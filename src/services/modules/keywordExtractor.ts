import { Page } from 'playwright';

export class KeywordExtractor {
  /**
   * 페이지 소스에서 대표키워드 추출
   */
  static async extract(page: Page): Promise<{ keywords: string[], logs: string[] }> {
    const logs: string[] = [];
    
    try {
      logs.push('[키워드] 페이지 소스 가져오는 중...');
      
      // 페이지 전체 HTML 가져오기
      const content = await page.content();
      logs.push(`[키워드] 페이지 소스 길이: ${content.length}`);
      
      // keywordList 패턴 찾기
      const keywordMatch = content.match(/"keywordList":\[(.*?)\]/);
      
      if (keywordMatch && keywordMatch[1]) {
        logs.push('[키워드] keywordList 발견!');
        
        const keywordsJson = keywordMatch[1];
        const keywords = keywordsJson.match(/"text":"([^"]+)"/g);
        
        if (keywords) {
          const extracted = keywords
            .map(k => k.match(/"text":"([^"]+)"/)?.[1] || '')
            .filter(k => k.length > 0)
            .slice(0, 5);
          
          logs.push(`[키워드] 추출 성공: ${extracted.join(', ')}`);
          return { keywords: extracted, logs };
        }
      }
      
      logs.push('[키워드] keywordList를 찾지 못했습니다');
      
      // 대안: 메타 태그나 다른 위치에서 시도
      const altMatch = content.match(/keywords["\s:]+\[([^\]]+)\]/i);
      if (altMatch) {
        logs.push('[키워드] 대안 패턴 발견');
        const extracted = altMatch[1]
          .split(',')
          .map(k => k.replace(/['"]/g, '').trim())
          .filter(k => k.length > 0)
          .slice(0, 5);
        
        if (extracted.length > 0) {
          logs.push(`[키워드] 대안 추출 성공: ${extracted.join(', ')}`);
          return { keywords: extracted, logs };
        }
      }
      
      logs.push('[키워드] 추출 실패 - 키워드가 없거나 형식이 다릅니다');
      return { keywords: [], logs };
      
    } catch (error) {
      logs.push(`[키워드] 오류: ${error}`);
      return { keywords: [], logs };
    }
  }
}
