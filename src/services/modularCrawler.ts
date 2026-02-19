import { chromium, Browser, Page, Frame, BrowserContext } from "playwright";
import { PlaceData } from "../types";
import { UrlConverter } from "./modules/urlConverter";
import { KeywordExtractor } from "./modules/keywordExtractor";
import { DescriptionExtractor } from "./modules/descriptionExtractor";
import { DirectionsExtractor } from "./modules/directionsExtractor";
import { ReviewPhotoExtractor } from "./modules/reviewPhotoExtractor";
import { NextDataParser } from "./modules/nextDataParser";
import { UiExpander } from "./modules/uiExpander";
import { PriceExtractor, MenuItem } from "./modules/priceExtractor";

export interface CrawlResult {
  success: boolean;
  data?: PlaceDataWithExtras;
  logs: string[];
  error?: string;
}

type ContextType = Page | Frame;

export type PlaceDataWithExtras = PlaceData & {
  // PlaceData에 이미 menuCount/menus/recentReviewCount30d가 들어가도,
  // 기존 코드 호환을 위해 유지(중복이어도 문제없음)
  menuCount?: number;
  menus?: MenuItem[];
  recentReviewCount30d?: number;
};

export class ModularCrawler {
  private browser: Browser | null = null;

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
      ]
    });
  }

  async crawlPlace(originalUrl: string): Promise<CrawlResult> {
    const logs: string[] = [];

    if (!this.browser) {
      await this.initialize();
    }

    let context: BrowserContext | null = null;

    try {
      logs.push("=== 1단계: URL 변환 ===");
      logs.push(`원본 URL: ${originalUrl}`);

      const mobileUrl = UrlConverter.convertToMobileUrl(originalUrl);
      logs.push(`변환된 URL: ${mobileUrl}`);

      const placeIdMaybe = UrlConverter.extractPlaceId(mobileUrl);
      if (!placeIdMaybe) throw new Error("Place ID 추출 실패");
      const placeId = placeIdMaybe;

      // ✅ 업종 slug 감지(예: hairshop/cafe/restaurant/...)
      const categorySlug = this.detectCategorySlug(mobileUrl);
      logs.push(`categorySlug: ${categorySlug || "(unknown)"}`);

      logs.push(`Place ID: ${placeId}`);
      logs.push("*** DEPLOY CHECK: modularCrawler vFINAL-EXPAND-PRICE-PHOTOFIX-20260213 ***");

      context = await this.browser!.newContext({
        userAgent:
          "Mozilla/5.0 (Linux; Android 13; SM-G991N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36",
        viewport: { width: 390, height: 844 },
        extraHTTPHeaders: {
          "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7"
        }
      });

      const page = await context.newPage();
      logs.push("*** UA/CONTEXT SET OK ***");

      // 1차 로딩
      logs.push("\n=== 페이지 로딩 ===");
      await page.goto(mobileUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2500);

      logs.push("페이지 로드 완료");
      logs.push(`최종 URL: ${page.url()}`);

      // iframe 탐색
      logs.push("\n=== iframe 접근 ===");
      let frame = await this.tryGetEntryFrame(page);

      // shell이면 /home 재시도
      if (!frame && this.isShellUrl(page.url(), placeId)) {
        const homeUrl = `https://m.place.naver.com/place/${placeId}/home`;
        logs.push(`iframe 없음 + shell 감지 → /home 재시도: ${homeUrl}`);

        await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2500);

        logs.push("(/home) 페이지 로드 완료");
        logs.push(`(/home) 최종 URL: ${page.url()}`);

        frame = await this.tryGetEntryFrame(page);
      }

      // “더보기/정보 더보기” 펼치기
      logs.push("\n=== UI 확장(더보기 클릭) ===");
      const uiLogs = await UiExpander.expandAll(page, frame);
      logs.push(...uiLogs);

      const contentContext: ContextType = frame ?? page;

      // NEXT fallback
      let nextFallback: Partial<PlaceData> = {};
      if (!frame) {
        logs.push("*** NEXT FALLBACK CODE PATH ENTERED ***");
        const html = await page.content();
        logs.push(`page HTML 길이: ${html.length}`);

        const next = NextDataParser.extractNextData(html);
        logs.push(...next.logs);

        if (next.ok && next.data) {
          const fields = NextDataParser.extractFields(next.data);
          logs.push(...fields.logs);

          nextFallback = {
            name: fields.name,
            address: fields.address,
            reviewCount: fields.reviewCount ?? 0,
            photoCount: fields.photoCount ?? 0,
            keywords: fields.keywords ?? [],
            description: fields.description ?? "",
            directions: fields.directions ?? ""
          };
        }
      } else {
        logs.push("iframe 접근 성공");
      }

      // 기본 정보
      logs.push("\n=== 기본 정보 추출 ===");
      const name = nextFallback.name || (await this.extractName(contentContext)) || "이름 없음";
      let address = nextFallback.address || (await this.extractAddress(contentContext)) || "";

      if (!address || address === "주소 없음") {
        logs.push("[주소] DOM에서 실패 → HTML regex fallback 시도");
        const html = await page.content();
        address = this.extractAddressFromHtml(html) || "";
      }
      if (!address) address = "주소 없음";

      logs.push(`이름: ${name}`);
      logs.push(`주소: ${address}`);

      // 키워드
      logs.push("\n=== 2단계: 키워드 ===");
      let keywords = nextFallback.keywords || [];
      if (!keywords.length) {
        const k = await KeywordExtractor.extract(page, frame);
        logs.push(...k.logs);
        keywords = k.keywords;
      }

      // 상세설명
      logs.push("\n=== 3단계: 상세설명 ===");
      let description = nextFallback.description || "";
      if (!description) {
        const d = await DescriptionExtractor.extract(page, frame);
        logs.push(...d.logs);
        description = d.description;
      }

      // 오시는길
      logs.push("\n=== 4단계: 오시는길 ===");
      let directions = nextFallback.directions || "";
      if (!directions) {
        const d = await DirectionsExtractor.extract(page, frame);
        logs.push(...d.logs);
        directions = d.directions;
      }

      // 가격/메뉴
      logs.push("\n=== 5단계: 가격/메뉴 ===");
      let menuCount = 0;
      let menus: MenuItem[] = [];
      const p = await PriceExtractor.extract(page, frame, placeId);
      logs.push(...p.logs);
      menuCount = p.menuCount;
      menus = p.menus;

      // 리뷰/사진 (+ 최근30일 리뷰수)
      logs.push("\n=== 6단계: 리뷰/사진 ===");
      let reviewCount = nextFallback.reviewCount ?? 0;
      let photoCount = nextFallback.photoCount ?? 0;

      const r = await ReviewPhotoExtractor.extract(page, frame, placeId, categorySlug);
      logs.push(...r.logs);
      reviewCount = r.reviewCount || reviewCount;
      photoCount = r.photoCount || photoCount;

      const recentReviewCount30d = r.recentReviewCount30d;

      await context.close();
      logs.push("\n=== 크롤링 완료 ===");

      return {
        success: true,
        data: {
          name,
          address,
          reviewCount,
          photoCount,
          recentReviewCount30d,
          description,
          directions,
          keywords,
          menuCount,
          menus
        },
        logs
      };
    } catch (err: any) {
      try {
        if (context) await context.close();
      } catch {}
      logs.push(`❌ 오류: ${err?.message || String(err)}`);
      return { success: false, logs, error: err?.message || String(err) };
    }
  }

  private async tryGetEntryFrame(page: Page): Promise<Frame | null> {
    try {
      const el = await page
        .waitForSelector("iframe#entryIframe", { timeout: 8000, state: "attached" })
        .catch(() => null);

      if (el) {
        const fr = await el.contentFrame();
        if (fr) return fr;
      }

      const frames = page.frames();
      const found = frames.find(f => (f.url() || "").includes("entry"));
      return found || null;
    } catch {
      return null;
    }
  }

  private isShellUrl(url: string, placeId: string): boolean {
    try {
      const u = new URL(url);
      return u.pathname.replace(/\/+$/, "") === `/place/${placeId}`;
    } catch {
      return false;
    }
  }

  private detectCategorySlug(url: string): string | undefined {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      // 예: /hairshop/1443688242/home -> ["hairshop","144...","home"]
      const first = parts[0];
      if (!first) return undefined;
      if (first === "place") return undefined;
      if (!/^[a-z0-9_]+$/i.test(first)) return undefined;
      return first;
    } catch {
      return undefined;
    }
  }

  private async extractName(context: ContextType): Promise<string> {
    const selectors = [".Fc1rA", ".GHAhO", "h1", "h2"];
    for (const sel of selectors) {
      try {
        const el = await context.$(sel);
        if (el) {
          const t = await el.textContent();
          if (t?.trim()) return t.trim();
        }
      } catch {}
    }
    return "이름 없음";
  }

  private async extractAddress(context: ContextType): Promise<string> {
    const selectors = [".LDgIH", ".IH3UA", "address", 'span[class*="address"]', 'div[class*="address"]'];
    for (const sel of selectors) {
      try {
        const el = await context.$(sel);
        if (el) {
          const t = await el.textContent();
          if (t?.trim()) return t.trim();
        }
      } catch {}
    }
    return "주소 없음";
  }

  private extractAddressFromHtml(html: string): string | null {
    const patterns = [
      /"roadAddress"\s*:\s*"([^"]+)"/,
      /"roadAddr"\s*:\s*"([^"]+)"/,
      /"address"\s*:\s*"([^"]{5,200})"/,
      /"addr"\s*:\s*"([^"]{5,200})"/
    ];
    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) {
        return m[1].replace(/\\n/g, " ").replace(/\\"/g, '"').trim();
      }
    }
    return null;
  }
}
