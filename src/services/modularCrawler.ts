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

      const placeIdMaybe = UrlConverter.extractPlaceId(mobileUrl);

if (!placeIdMaybe) {
  throw new Error('Place ID를 추출할 수 없습니다. URL 형식을 확인하세요.');
}

const placeId: string = placeIdMaybe;
allLogs.push(`Place ID: ${placeId}`);


      // 2) 1차 페이지 로딩
      allLogs.push('\n=== 페이지 로딩 ===');
      await page.goto(mobileUrl, { waitUntil: 'load', timeout: 60000 });
      allLogs.push('페이지 로드 완료');
      allLogs.push(`최종 URL: ${page.url()}`);
      await page.waitForTimeout(2500);

      // 3) iframe 시도
      allLogs.push('\n=== iframe 접근 ===');
      let frame = await this.tryGetEntryFrame(page, allLogs);

      // ✅ 핵심: /place/{id}에서 iframe이 없으면 /home 으로 2차 진입 시도
      if (!frame && this.looksLikeShellPlaceUrl(page.url(), placeId)) {
        const homeUrl = this.toHomeUrl(page.url(), placeId);
        allLogs.push(`iframe 없음 + shell URL 감지 → /home 재시도: ${homeUrl}`);

        await page.goto(homeUrl, { waitUntil: 'load', timeout: 60000 });
        allLogs.push('(/home) 페이지 로드 완료');
        allLogs.push(`(/home) 최종 URL: ${page.url()}`);
        await page.waitForTimeout(2500);

        // 다시 iframe 찾기
        allLogs.push('\n=== iframe 재탐색(/home) ===');
        frame = await this.tryGetEntryFrame(page, allLogs);
      }

      const context: Context = frame ?? page;
      if (frame) {
        allLogs.push('iframe 접근 성공 → frame 컨텍스트 사용');
      } else {
        // 여기까지 왔는데도 iframe이 없으면,
        // 아직도 shell이거나, 구조가 또 다른 케이스
        allLogs.push('iframe 없음 → page 컨텍스트 사용');
        const htmlLen = (await page.content()).length;
        allLogs.push(`page HTML 길이(디버그): ${htmlLen}`);
      }

      await page.waitForTimeout(1200);

      // 기본 정보 추출 (이름, 주소)
      allLogs.push('\n=== 기본 정보 추출 ===');
      const name = await this.extractName(context);
      const address = await this.extractAddress(context);
      allLogs.push(`이름: ${name}`);
      allLogs.push(`주소: ${address}`);

      // 2. 키워드 추출
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

      // 5. 리뷰&사진 추출
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

      return { success: true, data: placeData, logs: allLogs };
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
   */
  private async tryGetEntryFrame(page: Page, logs: string[]): Promise<Frame | null> {
    try {
      logs.push('entryIframe 탐색(빠른 시도) ...');
      const el = await page
        .waitForSelector('iframe#entryIframe', { timeout: 8000, state: 'attached' })
        .catch(() => null);

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

  /**
   * /place/{id} 같은 shell URL인지 판단
   * - iframe이 없고, URL이 /place/{id}로 끝나는 경우가 흔함
   */
  private looksLikeShellPlaceUrl(currentUrl: string, placeId: string): boolean {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');
      // 예: /place/1443688242
      return path === `/place/${placeId}`;
    } catch {
      return false;
    }
  }

  /**
   * /place/{id} → /place/{id}/home 으로 변환
   */
  private toHomeUrl(currentUrl: string, placeId: string): string {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');
      if (path === `/place/${placeId}`) {
        u.pathname = `/place/${placeId}/home`;
        return u.toString();
      }
      // 혹시 다른 형태면 마지막에 /home 붙이기
      if (!path.endsWith('/home')) {
        u.pathname = `${path}/home`;
      }
      return u.toString();
    } catch {
      // fallback
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
