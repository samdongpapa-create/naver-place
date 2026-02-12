import { Page, Frame } from 'playwright';

export class DescriptionExtractor {
  /**
   * 상세설명 추출
   */
  static async extract(page: Page, frame: Frame): Promise<{ description: string, logs: string[] }> {
    const logs: string[] = [];
    
    try {
      logs.push('[상세설명] 추출 시작');
      
      // 페이지 소스에서 직접 찾기 (가장 확실한 방법)
      const content = await page.content();
      
      // 패턴 1: description 필드
      const descPattern1 = /"description"\s*:\s*"([^"]+)"/;
      const match1 = content.match(descPattern1);
      if (match1 && match1[1]) {
        const desc = match1[1]
          .replace(/\\n/g, '\n')
          .replace(/\\t/g, '\t')
          .replace(/\\"/g, '"')
          .trim();
        
        if (desc.length > 10) {
          logs.push(`[상세설명] 소스에서 발견 (패턴1): ${desc.substring(0, 50)}...`);
          return { description: desc, logs };
        }
      }
      
      // 패턴 2: businessHours 근처의 설명
      const descPattern2 = /"description"\s*:\s*"([^"]{10,})"/;
      const match2 = content.match(descPattern2);
      if (match2 && match2[1]) {
        const desc = match2[1]
          .replace(/\\n/g, '\n')
          .replace(/\\"/g, '"')
          .trim();
        
        logs.push(`[상세설명] 소스에서 발견 (패턴2): ${desc.substring(0, 50)}...`);
        return { description: desc, logs };
      }
      
      // 패턴 3: iframe 내부에서 직접 추출
      logs.push('[상세설명] iframe 내부에서 시도...');
      
      // 홈 탭 클릭
      const homeTabs = ['a:has-text("홈")', 'button:has-text("홈")'];
      for (const selector of homeTabs) {
        try {
          const tab = await frame.$(selector);
          if (tab) {
            await tab.click();
            await page.waitForTimeout(1500);
            logs.push('[상세설명] 홈 탭 클릭');
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
              logs.push('[상세설명] 더보기 클릭');
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      // 텍스트 추출
      const descSelectors = ['.zPfVt', '.vV_z_', '.place_detail_introduction'];
      for (const selector of descSelectors) {
        try {
          const element = await frame.$(selector);
          if (element) {
            const text = await element.textContent();
            if (text && text.trim().length > 10) {
              logs.push(`[상세설명] 요소에서 추출: ${text.substring(0, 50)}...`);
              return { description: text.trim(), logs };
            }
          }
        } catch (e) {
          continue;
        }
      }
      
      logs.push('[상세설명] 추출 실패 - 상세설명이 없거나 찾을 수 없습니다');
      return { description: '', logs };
      
    } catch (error) {
      logs.push(`[상세설명] 오류: ${error}`);
      return { description: '', logs };
    }
  }
}
