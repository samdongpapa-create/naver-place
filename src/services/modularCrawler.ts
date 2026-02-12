import { chromium, Browser, Page, Frame } from 'playwright';
import { PlaceData } from '../types';
import { UrlConverter } from './modules/urlConverter';
import { KeywordExtractor } from './modules/keywordExtractor';
import { DescriptionExtractor } from './modules/descriptionExtractor';
import { DirectionsExtractor } from './modules/directionsExtractor';
import { ReviewPhotoExtractor } from './modules/reviewPhotoExtractor';

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
      // 1. URL 변환
      allLogs.push('=== 1단계: URL 변환 ===');
      allLogs.push(`원본 URL: ${originalUrl}`);

      const mobileUrl = UrlConverter.convertToMobileUrl(originalUrl);
      allLogs.push(`변환된 URL: ${mobileUrl}`);

      const placeId = UrlConverter.extractPlaceId(mobileUrl);
      allLogs.push(`Place ID: ${placeId}`);

      // 페이지 로드
      allLogs.push('\n=== 페이지 로딩 ===');
      await page.goto(mobileUrl, { waitUntil: 'load', timeout: 60000 });
      allLogs.push('페이지 로드 완료');

      // ✅ 리다이렉트된 최종 URL도 로그에 남김
      try {
        allLogs.push(`최종 URL: ${page.url()}`);
      } catch {}

      await page.waitForTimeout(2500);

      // ✅ iframe 있으면 사용, 없으면 page 자체를 컨텍스트로 사용
      allLogs.push('\n=== iframe 접근 ===');
      const frame = await this.tryGetEntryFrame(page, allLogs);

      const context: Context = frame ?? page;
      if (frame) {
        allLogs.push('iframe 접근 성공 → frame 컨텍스트 사용');
      } else {
        allLogs.push('iframe 없음 → page 컨텍스트 사용');
      }

      await page.waitForTimeout(1500);

      // 기본 정보 추출 (이름, 주소)
      allLogs.push('\n=== 기본 정보 추출 ===');
      const name = await this.extractName(context);
      const address = await this.extractAddress(context);
      allLogs.push(`이름: ${name}`);
      allLogs.push(`주소: ${address}`);

      // 2. 키워드 추출 (이미 page+frame 지원)
      allLogs.push('\n=== 2단계: 키워드 추출 ===');
      const keywordResult = await KeywordExtractor.extract(page, frame);
      allLogs.push(...keywordResult.logs);

      // 3. 상세설명 추출
      allLogs.push('\n=== 3단계: 상세설명 추출 ===');
      const descResult = await DescriptionExtractor.extract(page, frame);
      allLogs.push(...descResult.logs);

      // 4. 오시는길 추출
      allLogs.push('\n=== 4단계: 오시는길 추출 ===');
      const directionsResult = await DirectionsExtractor.extract(page, frame);
      allLogs.push(...directionsResult.logs);

      // 5. 리뷰&사진 추출 (frame optional로 바꿈)
      allLogs.push('\n=== 5단계: 리뷰&사진 추출 ===');
      const reviewPhotoResult = await ReviewPhotoExtractor.extract(page, frame);
      allLogs.push(...reviewPhotoResult.logs);

      await page.close();

      allLogs.push('\n=== 크롤링 완료 ===');

      const placeData: PlaceData = {
        name,
        address,
        reviewCount: reviewPhotoResult.reviewCount,
        photoCount: reviewPhotoResult.photoCount,
        description: descResult.description,
        directions: directionsResult.directions,
        keywords: keywordResult.keywords
      };

      return {
        success: true,
        data: placeData,
        logs: allLogs
      };
    } catch (error: any) {
      try {
        await page.close();
      } catch {}

      allLogs.push(`\n❌ 오류 발생: ${error?.message || String(error)}`);

      return {
        success: false,
        logs: allLogs,
        error: error?.message || String(error)
      };
    }
  }

  /**
   * entryIframe이 있으면 Frame 반환, 없으면 null
   * - 구조가 바뀌거나 iframe 없는 케이스 대응
   */
  private async tryGetEntryFrame(page: Page, logs: string[]): Promise<Frame | null> {
    try {
      // 1) 짧게 먼저 기다려보고
      logs.push('entryIframe 탐색(빠른 시도) ...');
      const el = await page.waitForSelector('iframe#entryIframe', {
        timeout: 8000,
        state: 'attached'
      }).catch(() => null);

      if (el) {
        const fr = await el.contentFrame();
        if (fr) return fr;
      }

      // 2) 혹시 id가 다르거나 내부 frame이 이미 생성된 케이스
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

  private async extractName(context: Context): Promise<string> {
    const selectors = ['.Fc1rA', '.GHAhO', 'h1', 'h2'];

    for (const selector of selectors) {
      try {
        const element = await context.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0) return text.trim();
        }
      } catch {
        continue;
      }
    }

    // fallback: title
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
      } catch {
        continue;
      }
    }

    return '주소 없음';
  }
}
