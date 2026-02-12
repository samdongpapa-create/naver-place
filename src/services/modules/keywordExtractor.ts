// src/services/modules/keywordExtractor.ts
import { Page, Frame } from 'playwright';

export interface KeywordResult {
  keywords: string[];
  source: string;
}

export class KeywordExtractor {
  static async extract(page: Page, frame?: Frame | null): Promise<KeywordResult> {
    try {
      console.log('=== 2단계: 대표키워드 추출 시작 ===');

      let keywords: string[] = [];

      // 1️⃣ iframe 먼저 시도
      if (frame) {
        console.log('iframe에서 키워드 추출 시도');
        keywords = await this.extractFromContext(frame);
      }

      // 2️⃣ iframe에서 못 찾았으면 page에서 재시도
      if (!keywords.length) {
        console.log('메인 페이지에서 키워드 추출 시도');
        keywords = await this.extractFromContext(page);
      }

      console.log('추출된 키워드:', keywords);

      return {
        keywords,
        source: keywords.length ? 'html' : 'none'
      };

    } catch (error) {
      console.error('KeywordExtractor 오류:', error);
      return { keywords: [], source: 'error' };
    }
  }

  private static async extractFromContext(context: Page | Frame): Promise<string[]> {
    try {
      // 텍스트 기반 추출
      const textContent = await context.content();

      const patterns = [
        /"representKeywordList"\s*:\s*\[(.*?)\]/,
        /"keywords"\s*:\s*\[(.*?)\]/,
        /대표키워드[\s:]+([^"<]+)/,
      ];

      for (const pattern of patterns) {
        const match = textContent.match(pattern);
        if (match) {
          const raw = match[1];
          return raw
            .replace(/[\[\]"]/g, '')
            .split(',')
            .map(k => k.trim())
            .filter(k => k.length > 1)
            .slice(0, 5);
        }
      }

      // DOM 기반 추출 (fallback)
      const domKeywords = await context.$$eval(
        'a[href*="keyword"], span[class*="keyword"], div[class*="keyword"]',
        elements => elements.map(el => el.textContent?.trim() || '')
      );

      return domKeywords
        .filter(k => k.length > 1)
        .slice(0, 5);

    } catch (error) {
      console.error('extractFromContext 오류:', error);
      return [];
    }
  }
}
