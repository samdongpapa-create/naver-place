import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  /**
   * 오시는길 추출
   */
  static async extract(page: Page, frame: Frame): Promise<{ directions: string, logs: string[] }> {
    const logs: string[] = [];
    
    try {
      logs.push('[오시는길] 추출 시작');
      
      // 페이지 소스에서 직접 찾기
      const content = await page.content();
      
      // 패턴 1: wayGuide 또는 directions 필드
      const patterns = [
        /"wayGuide"\s*:\s*"([^"]{10,})"/,
        /"directions"\s*:\s*"([^"]{10,})"/,
        /"way"\s*:\s*"([^"]{10,})"/
      ];
      
      for (const pattern of patterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          const directions = match[1]
            .replace(/\\n/g, '\n')
            .replace(/\\t/g, '\t')
            .replace(/\\"/g, '"')
            .trim();
          
          if (directions.length > 10) {
            logs.push(`[오시는길] 소스에서 발견: ${directions.substring(0, 50)}...`);
            return { directions, logs };
          }
        }
      }
      
      // iframe 내부에서 추출
      logs.push('[오시는길] iframe 내부에서 시도...');
      
      // 오시는길 탭 클릭
      const wayTabs = ['a:has-text("오시는길")', 'button:has-text("오시는길")'];
      for (const selector of wayTabs) {
        try {
          const tab = await frame.$(selector);
          if (tab) {
            await tab.click();
            await page.waitForTimeout(1500);
            logs.push('[오시는길] 탭 클릭');
            break;
          }
        } catch (e) {
          continue;
        }
      }
      
      // 더보기 버튼 클릭
      const moreButtons = ['a.zuyEj:has-text("더보기")', 'button:has-text("더보기")'];
      for (const selector of moreButtons) {
        try {
          const buttons = await frame.$$(selector);
          for (const btn of buttons) {
            const text = await btn.textContent();
            if (text && text.includes('더보기')) {
              await btn.click();
              await page.waitForTimeout(1000);
              logs.push('[오시는길] 더보기 클릭');
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      // 텍스트 추출
      const directionsSelectors = ['.vV_z_', '.way_description', 'div[class*="way"]'];
      for (const selector of directionsSelectors) {
        try {
          const element = await frame.$(selector);
          if (element) {
            const text = await element.textContent();
            if (text && text.trim().length > 10) {
              logs.push(`[오시는길] 요소에서 추출: ${text.substring(0, 50)}...`);
              return { directions: text.trim(), logs };
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      logs.push('[오시는길] 추출 실패 - 오시는길 정보가 없거나 찾을 수 없습니다');
      return { directions: '', logs };
      
    } catch (error) {
      logs.push(`[오시는길] 오류: ${error}`);
      return { directions: '', logs };
    }
  }
}
