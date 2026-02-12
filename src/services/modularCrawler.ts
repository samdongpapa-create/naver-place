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
      await page.goto(mobileUrl, { 
        waitUntil: 'load',
        timeout: 60000 
      });
      allLogs.push('페이지 로드 완료');
      await page.waitForTimeout(3000);
      
      // iframe 접근
      allLogs.push('\n=== iframe 접근 ===');
      await page.waitForSelector('iframe#entryIframe', { 
        timeout: 30000,
        state: 'attached'
      });
      
      const frameElement = await page.$('iframe#entryIframe');
      if (!frameElement) {
        throw new Error('iframe을 찾을 수 없습니다');
      }
      
      const frame = await frameElement.contentFrame();
      if (!frame) {
        throw new Error('iframe 콘텐츠에 접근할 수 없습니다');
      }
      
      allLogs.push('iframe 접근 성공');
      await page.waitForTimeout(2000);
      
      // 기본 정보 추출 (이름, 주소)
      allLogs.push('\n=== 기본 정보 추출 ===');
      const name = await this.extractName(frame);
      const address = await this.extractAddress(frame);
      allLogs.push(`이름: ${name}`);
      allLogs.push(`주소: ${address}`);
      
      // 2. 키워드 추출
      allLogs.push('\n=== 2단계: 키워드 추출 ===');
      const keywordResult = await KeywordExtractor.extract(page);
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
      
      return {
        success: true,
        data: placeData,
        logs: allLogs
      };
      
    } catch (error: any) {
      await page.close();
      allLogs.push(`\n❌ 오류 발생: ${error.message}`);
      
      return {
        success: false,
        logs: allLogs,
        error: error.message
      };
    }
  }

  private async extractName(frame: Frame): Promise<string> {
    const selectors = ['.Fc1rA', '.GHAhO', 'h1'];
    
    for (const selector of selectors) {
      try {
        const element = await frame.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0) {
            return text.trim();
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    return '이름 없음';
  }

  private async extractAddress(frame: Frame): Promise<string> {
    const selectors = ['.LDgIH', '.IH3UA'];
    
    for (const selector of selectors) {
      try {
        const element = await frame.$(selector);
        if (element) {
          const text = await element.textContent();
          if (text && text.trim().length > 0) {
            return text.trim();
          }
        }
      } catch (e) {
        continue;
      }
    }
    
    return '주소 없음';
  }
}
