import { chromium, Browser } from "playwright";
import { UrlConverter } from "./modules/urlConverter";
import { ModularCrawler } from "./modularCrawler";
import type { Industry } from "../lib/scoring/types";

export type CompetitorSummary = {
  name: string;
  address: string;
  keywords: string[];
  reviewCount: number;
  photoCount: number;
};

function uniq(arr: string[]) {
  return Array.from(new Set(arr));
}

function extractPlaceIdsFromHtml(html: string): string[] {
  const ids: string[] = [];

  // "placeId":"1234567"
  {
    const re = /"placeId"\s*:\s*"(\d{5,12})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[1]);
  }

  // /place/1234567
  {
    const re = /\/place\/(\d{5,12})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[1]);
  }

  // /hairshop/1234567/home etc
  {
    const re = /\/(restaurant|cafe|hairshop)\/(\d{5,12})\//g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[2]);
  }

  return uniq(ids);
}

export class CompetitorService {
  private browser: Browser | null = null;

  private async ensureBrowser() {
    if (this.browser) return;
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

  async close() {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
  }

  private async fetchHtml(url: string): Promise<string> {
    // node18+ 에서는 fetch 기본 제공
    const res = await fetch(url, {
      headers: {
        "user-agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "accept-language": "ko-KR,ko;q=0.9,en;q=0.8"
      }
    });
    return await res.text();
  }

  /**
   * 네이버 플레이스 검색 결과에서 상위 placeId들을 뽑는다.
   * - 중복 제거
   * - 내 placeId 제외
   * ✅ 개선: Playwright 실패(브라우저 미설치/권한) 시 fetch 기반 HTML regex fallback
   */
  async findTopPlaceIds(searchQuery: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    // 1) 우선 Playwright 시도
    try {
      await this.ensureBrowser();
      const page = await this.browser!.newPage();

      try {
        const url = `https://m.place.naver.com/search?query=${encodeURIComponent(searchQuery)}`;
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2000);

        const hrefs: string[] = await page.$$eval("a[href]", (els: any[]) => {
          return els
            .map((el: any) => {
              try {
                const v = typeof el?.getAttribute === "function" ? el.getAttribute("href") : "";
                if (v) return String(v);
              } catch {}
              const href = el?.href;
              return href ? String(href) : "";
            })
            .filter(Boolean);
        });

        const ids: string[] = [];
        const seen = new Set<string>();

        for (const h of hrefs) {
          let m = h.match(/\/place\/(\d+)/);

          if (!m) {
            m = h.match(/\/(restaurant|cafe|hairshop)\/(\d+)\//);
            const id = m?.[2];
            if (id && id !== excludePlaceId && !seen.has(id)) {
              seen.add(id);
              ids.push(id);
            }
          } else {
            const id = m?.[1];
            if (id && id !== excludePlaceId && !seen.has(id)) {
              seen.add(id);
              ids.push(id);
            }
          }

          if (ids.length >= limit) break;
        }

        return ids.slice(0, limit);
      } finally {
        await page.close().catch(() => {});
      }
    } catch {
      // ignore and fallback below
    }

    // 2) fallback: fetch + regex
    try {
      const url = `https://m.place.naver.com/search?query=${encodeURIComponent(searchQuery)}`;
      const html = await this.fetchHtml(url);
      const all = extractPlaceIdsFromHtml(html);
      const filtered = all.filter((id) => id !== excludePlaceId).slice(0, limit);
      return filtered;
    } catch {
      return [];
    }
  }

  /**
   * placeId 리스트를 실제 크롤링해서 competitors 데이터로 만든다.
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<CompetitorSummary[]> {
    const out: CompetitorSummary[] = [];

    for (const id of placeIds.slice(0, limit)) {
      try {
        const url = `https://m.place.naver.com/place/${id}`;
        void industry;

        const crawler = new ModularCrawler();
        const r = await crawler.crawlPlace(UrlConverter.convertToMobileUrl(url));
        if (!r.success || !r.data) continue;

        out.push({
          name: r.data.name || "업체명 없음",
          address: r.data.address || "",
          keywords: Array.isArray(r.data.keywords) ? r.data.keywords.slice(0, 5) : [],
          reviewCount: r.data.reviewCount || 0,
          photoCount: r.data.photoCount || 0
        });
      } catch {
        continue;
      }
    }

    return out;
  }
}
