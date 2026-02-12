import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  /**
   * 리뷰 및 사진 갯수 추출
   */
  static async extract(page: Page, frame: Frame): Promise<{ 
    reviewCount: number, 
    photoCount: number, 
    logs: string[] 
  }> {
    const logs: string[] = [];
    
    try {
      logs.push('[리뷰&사진] 추출 시작');
      
      // 페이지 소스에서 추출 (가장 확실함)
      const content = await page.content();
      
      let reviewCount = 0;
      let photoCount = 0;
      
      // 리뷰 수 추출
      logs.push('[리뷰&사진] 리뷰 수 찾는 중...');
      
      const reviewPatterns = [
  /"reviewCount["\s:]+([0-9,]+)/i,
  /"visitorReviewCount["\s:]+([0-9,]+)/i,
  /방문자리뷰\s*([0-9,]+)/i,
  /리뷰\s*([0-9,]+)/i
];

reviewCount = parseInt(match[1].replace(/,/g, ''), 10);
      
      for (const pattern of reviewPatterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          reviewCount = parseInt(match[1]);
          if (reviewCount > 0) {
            logs.push(`[리뷰&사진] 리뷰 수 발견: ${reviewCount}`);
            break;
          }
        }
      }
      
      if (reviewCount === 0) {
        logs.push('[리뷰&사진] 리뷰 수를 찾지 못했습니다');
      }
      
      // 사진 수 추출
      logs.push('[리뷰&사진] 사진 수 찾는 중...');
      
      const photoPatterns = [
        /"photoCount["\s:]+(\d+)/i,
        /사진\s*(\d+)/i,
        /"imageCount["\s:]+(\d+)/i,
        /포토\s*(\d+)/i
      ];
      
      for (const pattern of photoPatterns) {
        const match = content.match(pattern);
        if (match && match[1]) {
          photoCount = parseInt(match[1]);
          if (photoCount > 0) {
            logs.push(`[리뷰&사진] 사진 수 발견: ${photoCount}`);
            break;
          }
        }
      }
      
      if (photoCount === 0) {
        logs.push('[리뷰&사진] 사진 수를 찾지 못했습니다');
      }
      
      // iframe 내부에서도 시도 (백업)
      if (reviewCount === 0 || photoCount === 0) {
        logs.push('[리뷰&사진] iframe 내부에서 재시도...');
        
        // 리뷰 수 (iframe)
        if (reviewCount === 0) {
          const reviewSelectors = ['em.PXMot', '.veBoZ em', 'span[class*="review"] em'];
          for (const selector of reviewSelectors) {
            try {
              const elements = await frame.$$(selector);
              for (const el of elements) {
                const text = await el.textContent();
                if (text) {
                  const num = parseInt(text.replace(/,/g, '').replace(/[^0-9]/g, ''));
                  if (num > 0 && num < 1000000) {
                    reviewCount = num;
                    logs.push(`[리뷰&사진] iframe에서 리뷰 수 발견: ${reviewCount}`);
                    break;
                  }
                }
              }
              if (reviewCount > 0) break;
            } catch (e) {
              continue;
            }
          }
        }
        
        // 사진 수 (iframe)
        if (photoCount === 0) {
          const photoSelectors = ['a[href*="photo"] em', '.K0PDV em', 'span[class*="photo"] em'];
          for (const selector of photoSelectors) {
            try {
              const elements = await frame.$$(selector);
              for (const el of elements) {
                const text = await el.textContent();
                if (text) {
                  const num = parseInt(text.replace(/,/g, '').replace(/[^0-9]/g, ''));
                  if (num > 0 && num < 1000000) {
                    photoCount = num;
                    logs.push(`[리뷰&사진] iframe에서 사진 수 발견: ${photoCount}`);
                    break;
                  }
                }
              }
              if (photoCount > 0) break;
            } catch (e) {
              continue;
            }
          }
        }
      }
      
      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 사진: ${photoCount}`);
      
      return { reviewCount, photoCount, logs };
      
    } catch (error) {
      logs.push(`[리뷰&사진] 오류: ${error}`);
      return { reviewCount: 0, photoCount: 0, logs };
    }
  }
}
