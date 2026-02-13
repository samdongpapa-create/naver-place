import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{
    reviewCount: number;
    photoCount: number;
    logs: string[];
  }> {
    const logs: string[] = [];

    try {
      logs.push('[리뷰&사진] 추출 시작');

      const content = await page.content();

      let reviewCount = 0;
      let photoCount = 0;

      // 리뷰 수
      logs.push('[리뷰&사진] 리뷰 수 찾는 중...');
      const reviewPatterns: RegExp[] = [
        /"visitorReviewCount"[\s":]+([0-9,]{1,})/i,
        /"reviewCount"[\s":]+([0-9,]{1,})/i,
        /방문자리뷰\s*([0-9,]+)/i
      ];

      for (const pattern of reviewPatterns) {
        const m = content.match(pattern);
        if (m?.[1]) {
          const num = parseInt(m[1].replace(/,/g, ''), 10);
          if (!Number.isNaN(num) && num > 0) {
            reviewCount = num;
            logs.push(`[리뷰&사진] 리뷰 수 발견: ${reviewCount}`);
            break;
          }
        }
      }
      if (reviewCount === 0) logs.push('[리뷰&사진] 리뷰 수를 찾지 못했습니다');

      // 사진 수 (✅ "1" 같은 오탐을 방지: 최소 5 이상만 신뢰)
      logs.push('[리뷰&사진] 사진 수 찾는 중...');
      const photoPatterns: RegExp[] = [
        /"photoCount"[\s":]+([0-9,]{1,})/i,
        /"imageCount"[\s":]+([0-9,]{1,})/i,
        /"totalPhotoCount"[\s":]+([0-9,]{1,})/i,
        /"photoTotalCount"[\s":]+([0-9,]{1,})/i
      ];

      for (const pattern of photoPatterns) {
        const m = content.match(pattern);
        if (m?.[1]) {
          const num = parseInt(m[1].replace(/,/g, ''), 10);
          // ✅ 1~4는 탭 숫자/페이지네이션 오탐 가능성이 높아서 버림
          if (!Number.isNaN(num) && num >= 5) {
            photoCount = num;
            logs.push(`[리뷰&사진] 사진 수 발견(신뢰): ${photoCount}`);
            break;
          } else if (!Number.isNaN(num)) {
            logs.push(`[리뷰&사진] 사진 수 후보(${num})는 오탐 가능성으로 무시`);
          }
        }
      }

      // 그래도 0이면, 텍스트 기반 마지막 시도
      if (photoCount === 0) {
        const loose = content.match(/사진\s*([0-9,]+)/i);
        if (loose?.[1]) {
          const num = parseInt(loose[1].replace(/,/g, ''), 10);
          if (!Number.isNaN(num) && num >= 5) {
            photoCount = num;
            logs.push(`[리뷰&사진] 사진 수(텍스트) 발견: ${photoCount}`);
          }
        }
      }

      if (photoCount === 0) logs.push('[리뷰&사진] 사진 수를 찾지 못했습니다');

      // iframe fallback (있을 때만)
      if (frame && (reviewCount === 0 || photoCount === 0)) {
        logs.push('[리뷰&사진] iframe 내부에서 재시도...');
        // 필요하면 여기 더 강화 가능
      } else if (!frame) {
        logs.push('[리뷰&사진] frame 없음 → iframe fallback 스킵');
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 사진: ${photoCount}`);
      return { reviewCount, photoCount, logs };
    } catch (error: any) {
      logs.push(`[리뷰&사진] 오류: ${error?.message || String(error)}`);
      return { reviewCount: 0, photoCount: 0, logs };
    }
  }
}
