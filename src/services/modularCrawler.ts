import { chromium, Browser, Page, Frame } from 'playwright';
import { PlaceData } from '../types';
import { UrlConverter } from './modules/urlConverter';
import { KeywordExtractor } from './modules/keywordExtractor';
import { DescriptionExtractor } from './modules/descriptionExtractor';
import { DirectionsExtractor } from './modules/directionsExtractor';
import { ReviewPhotoExtractor } from './modules/reviewPhotoExtractor';
import { NextDataParser } from './modules/nextDataParser';

export interface CrawlResult {
  success: boolean;
  data?: PlaceData;
  logs: string[];
  error?: string;
}

type Context = Page | Frame;

export class ModularCrawler {
  private browser: Browser | null = null;

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async crawlPlace(originalUrl: string): Promise<CrawlResult> {
    const allLogs: string[] = [];

    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();

    try {
      allLogs.push('=== 1단계: URL 변환 ===');
      allLogs.push(`원본 URL: ${originalUrl}`);

      const mobileUrl = UrlConverter.convertToMobileUrl(originalUrl);
      allLogs.push(`변환된 URL: ${mobileUrl}`);

      const placeIdMaybe = UrlConverter.extractPlaceId(mobileUrl);
      if (!placeIdMaybe) throw new Error('Place ID를 추출할 수 없습니다. URL 형식을 확인하세요.');
      const placeId: string = placeIdMaybe;

      allLogs.push(`Place ID: ${placeId}`);

      // ✅ 헤드리스에서 너무 “봇” 티 안 나게 최소 세팅
      await page.setViewportSize({ width: 390, height: 844 });
      await page.setExtraHTTPHeaders({
        'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7'
      });

      allLogs.push('\n=== 페이지 로딩 ===');
      await page.goto(mobileUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2500);

      allLogs.push('페이지 로드 완료');
      allLogs.push(`최종 URL: ${page.url()}`);

      // iframe 접근
      allLogs.push('\n=== iframe 접근 ===');
      let frame = await this.tryGetEntryFrame(page, allLogs);

      // /place/{id} shell이면 /home 재시도
      if (!frame && this.looksLikeShellPlaceUrl(page.url(), placeId)) {
        const homeUrl = this.toHomeUrl(page.url(), placeId);
        allLogs.push(`iframe 없음 + shell URL 감지 → /home 재시도: ${homeUrl}`);

        await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2500);

        allLogs.push('(/home) 페이지 로드 완료');
        allLogs.push(`(/home) 최종 URL: ${page.url()}`);

        allLogs.push('\n=== iframe 재탐색(/home) ===');
        frame = await this.tryGetEntryFrame(page, allLogs);
      }

      const context: Context = frame ?? page;

      // ✅ iframe이 없으면: __NEXT_DATA__ 파싱 시도
      let nextFallback: Partial<PlaceData> = {};
      if (!frame) {
        allLogs.push('iframe 없음 → __NEXT_DATA__ 파싱 fallback 시도');
        const html = await page.content();
        allLogs.push(`page HTML 길이(디버그): ${html.length}`);

        const next = NextDataParser.extractNextData(html);
        allLogs.push(...next.logs);

        if (next.ok && next.data) {
          const fields = NextDataParser.extractFields(next.data);
          allLogs.push(...fields.logs);

          nextFallback = {
            name: fields.name,
            address: fields.address,
            reviewCount: fields.reviewCount ?? 0,
            photoCount: fields.photoCount ?? 0,
            keywords: fields.keywords ?? [],
            description: fields.description ?? '',
            directions: fields.directions ?? ''
          };
        } else {
          allLogs.push('[NEXT] __NEXT_DATA__ 자체가 없음 → 네이버가 shell만 내려주는 상태(차단/제한 가능성 높음)');
        }
      } else {
        allLogs.push('iframe 접근 성공 → frame 컨텍스트 사용');
      }

      // 기본 정보 추출 (이름, 주소) — nextFallback 우선
      allLogs.push('\n=== 기본 정보 추출 ===');
      const name = nextFallback.name || (await this.extractName(context));
      const address = nextFallback.address || (await this.extractAddress(context));
      allLogs.push(`이름: ${name}`);
      allLogs.push(`주소: ${address}`);

      // 이하 항목들도 nextFallback이 있으면 우선 사용, 없으면 기존 extractor 시도
      allLogs.push('\n=== 2단계: 키워드 추출 ===');
      let keywords = nextFallback.keywords || [];
      if (!keywords.length) {
        const keywordResult = await KeywordExtractor.extract(page, frame);
        allLogs.push(...keywordResult.logs);
        keywords = keywordResult.keywords;
      } else {
        allLogs.push(`[키워드] NEXT fallback 사용: ${keywords.join(', ')}`);
      }

      allLogs.push('\n=== 3단계: 상세설명 추출 ===');
      let description = nextFallback.description || '';
      if (!description) {
        const descResult = await DescriptionExtractor.extract(page, frame);
        allLogs.push(...descResult.logs);
        description = descResult.description;
      } else {
        allLogs.push(`[상세설명] NEXT fallback 사용 (${description.length}자)`);
      }

      allLogs.push('\n=== 4단계: 오시는길 추출 ===');
      let directions = nextFallback.directions || '';
      if (!directions) {
        const directionsResult = await DirectionsExtractor.extract(page, frame);
        allLogs.push(...directionsResult.logs);
        directions = directionsResult.directions;
      } else {
        allLogs.push(`[오시는길] NEXT fallback 사용 (${directions.length}자)`);
      }

      allLogs.push('\n=== 5단계: 리뷰&사진 추출 ===');
      let reviewCount = nextFallback.reviewCount ?? 0;
      let photoCount = nextFallback.photoCount ?? 0;
      if (reviewCount === 0 && photoCount === 0) {
        const reviewPhotoResult = await ReviewPhotoExtractor.extract(page, frame);
        allLogs.push(...reviewPhotoResult.logs);
        reviewCount = reviewPhotoResult.reviewCount;
        photoCount = reviewPhotoResult.photoCount;
      } else {
        allLogs.push(`[리뷰&사진] NEXT fallback 사용 - 리뷰:${reviewCount}, 사진:${photoCount}`);
      }

      await page.close();
      allLogs.push('\n=== 크롤링 완료 ===');

      const placeData: PlaceData = {
        name,
        address,
        reviewCount,
        photoCount,
        description,
        directions,
        keywords
      };

      return { success: true, data: placeData, logs: allLogs };
    } catch (error: any) {
      try { await page.close(); } catch {}
      allLogs.push(`\n❌ 오류 발생: ${error?.message || String(error)}`);
      return { success: false, logs: allLogs, error: error?.message || String(error) };
    }
  }

  private async tryGetEntryFrame(page: Page, logs: string[]): Promise<Frame | null> {
    try {
      logs.push('entryIframe 탐색(빠른 시도) ...');
      const el = await page.waitForSelector('iframe#entryIframe', { timeout: 8000, state: 'attached' }).catch(() => null);
      if (el) {
        const fr = await el.contentFrame();
        if (fr) return fr;
      }

      logs.push('entryIframe 없음 → frames()로 재탐색 ...');
      const frames = page.frames();
      const found = frames.find(f => (f.url() || '').includes('entry') || (f.name() || '').includes('entry'));
      if (found) return found;

      return null;
    } catch (e: any) {
      logs.push(`iframe 탐색 중 예외(무시하고 page로 진행): ${e?.message || String(e)}`);
      return null;
    }
  }

  private looksLikeShellPlaceUrl(currentUrl: string, placeId: string): boolean {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');
      return path === `/place/${placeId}`;
    } catch {
      return false;
    }
  }

  private toHomeUrl(currentUrl: string, placeId: string): string {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');
      if (path === `/place/${placeId}`) {
        u.pathname = `/place/${placeId}/home`;
        return u.toString();
      }
      if (!path.endsWith('/home')) u.pathname = `${path}/home`;
      return u.toString();
    } catch {
      return `https://m.place.naver.com/place/${placeId}/home`;
    }
  }

  private async extractName(context: Context): Promise<string> {
    const selectors = ['.Fc1rA', '.GHAhO', 'h1', 'h2'];
    for (const selector of selectors) {
      try {
        const element = await context.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0) return text.trim();
        }
      } catch {}
    }
    try {
      if ('title' in context) {
        const t = await context.title();
        if (t?.trim()) return t.trim();
      }
    } catch {}
    return '이름 없음';
  }

  private async extractAddress(context: Context): Promise<string> {
    const selectors = ['.LDgIH', '.IH3UA', 'span[role="text"]', 'address'];
    for (const selector of selectors) {
      try {
        const element = await context.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0) return text.trim();
        }
      } catch {}
    }
    return '주소 없음';
  }
}
