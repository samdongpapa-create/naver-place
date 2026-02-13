import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{
    reviewCount: number;
    photoCount: number;
    logs: string[];
  }> {
    const logs: string[] = [];

    try {
      logs.push('[리뷰&사진] 추출 시작');

      // 1) 현재 페이지 HTML에서 리뷰/사진 후보
      const homeHtml = await page.content();

      const reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi
      ], logs, '리뷰');

      // 홈에서 사진수는 오탐이 많으니 일단 얻어두고,
      // 아래에서 photo 탭으로 가서 다시 확정
      let photoCount = this.extractMaxNumber(homeHtml, [
        /"photoCount"[\s":]+([0-9,]+)/gi,
        /"imageCount"[\s":]+([0-9,]+)/gi
      ], logs, '사진(홈)');

      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}, 사진후보:${photoCount}`);

      // 2) ✅ 사진 탭으로 이동해서 photoCount 재추출
      const photoUrl = this.buildPhotoUrl(page.url());
      logs.push(`[리뷰&사진] 사진탭 재시도: ${photoUrl}`);

      try {
        await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1800);

        const photoHtml = await page.content();
        const photoFromTab = this.extractMaxNumber(photoHtml, [
          /"photoCount"[\s":]+([0-9,]+)/gi,
          /"imageCount"[\s":]+([0-9,]+)/gi,
          /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
          /"photoTotalCount"[\s":]+([0-9,]+)/gi,
          /사진\s*([0-9,]+)/gi
        ], logs, '사진(탭)');

        // ✅ 탭에서 얻은 값이 더 크면 그걸 채택
        if (photoFromTab > photoCount) photoCount = photoFromTab;

        logs.push(`[리뷰&사진] 사진탭 기준 photoCount: ${photoFromTab}`);
      } catch (e: any) {
        logs.push(`[리뷰&사진] 사진탭 이동 실패(무시): ${e?.message || String(e)}`);
      }

      // 3) 최종 정리: 사진 1~4는 오탐으로 0 처리
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] 사진 최종값 ${photoCount}는 오탐 가능 → 0 처리`);
        photoCount = 0;
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 사진: ${photoCount}`);
      return { reviewCount, photoCount, logs };
    } catch (error: any) {
      logs.push(`[리뷰&사진] 오류: ${error?.message || String(error)}`);
      return { reviewCount: 0, photoCount: 0, logs };
    }
  }

  private static buildPhotoUrl(currentUrl: string): string {
    // 현재가 .../home 이면 .../photo 로
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');
      if (path.endsWith('/home')) {
        u.pathname = path.replace(/\/home$/, '/photo');
        return u.toString();
      }
      // 혹시 /place/{id}/home 같은 케이스도 대응
      if (!path.endsWith('/photo')) {
        u.pathname = `${path}/photo`;
      }
      return u.toString();
    } catch {
      return currentUrl;
    }
  }

  private static extractMaxNumber(
    html: string,
    regexList: RegExp[],
    logs: string[],
    label: string
  ): number {
    const nums: number[] = [];

    for (const r of regexList) {
      const matches = html.matchAll(r);
      for (const m of matches) {
        const raw = m?.[1];
        if (!raw) continue;
        const n = parseInt(String(raw).replace(/,/g, ''), 10);
        if (!Number.isNaN(n) && n > 0 && n < 5000000) nums.push(n);
      }
    }

    if (!nums.length) {
      logs.push(`[리뷰&사진] ${label} 후보 없음`);
      return 0;
    }

    const max = Math.max(...nums);
    logs.push(`[리뷰&사진] ${label} 최댓값: ${max}`);
    return max;
  }
}
