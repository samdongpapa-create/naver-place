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

      // =========================
      // 리뷰 수: 후보 중 "최댓값" 사용
      // =========================
      logs.push('[리뷰&사진] 리뷰 수 찾는 중...');

      reviewCount = this.extractMaxNumber(content, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi
      ], logs, '리뷰');

      if (reviewCount > 0) logs.push(`[리뷰&사진] 리뷰 수 최종: ${reviewCount}`);
      else logs.push('[리뷰&사진] 리뷰 수를 찾지 못했습니다');

      // =========================
      // 사진 수: 후보 중 "최댓값" 사용 (오탐 1 방지)
      // =========================
      logs.push('[리뷰&사진] 사진 수 찾는 중...');

      photoCount = this.extractMaxNumber(content, [
        /"photoCount"[\s":]+([0-9,]+)/gi,
        /"imageCount"[\s":]+([0-9,]+)/gi,
        /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
        /"photoTotalCount"[\s":]+([0-9,]+)/gi,
        /사진\s*([0-9,]+)/gi
      ], logs, '사진');

      // ✅ 사진은 1~4는 오탐 가능성이 높으니 5 미만이면 0 처리
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] 사진 수 최댓값이 ${photoCount} (오탐 가능성 높음) → 0 처리`);
        photoCount = 0;
      }

      if (photoCount > 0) logs.push(`[리뷰&사진] 사진 수 최종: ${photoCount}`);
      else logs.push('[리뷰&사진] 사진 수를 찾지 못했습니다');

      // frame fallback은 지금은 스킵(필요하면 추후 강화)
      if (!frame) logs.push('[리뷰&사진] frame 없음 → iframe fallback 스킵');

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 사진: ${photoCount}`);
      return { reviewCount, photoCount, logs };
    } catch (error: any) {
      logs.push(`[리뷰&사진] 오류: ${error?.message || String(error)}`);
      return { reviewCount: 0, photoCount: 0, logs };
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

    if (!nums.length) return 0;

    const max = Math.max(...nums);
    logs.push(`[리뷰&사진] ${label} 후보들: ${nums.slice(0, 10).join(', ')}${nums.length > 10 ? '...' : ''}`);
    logs.push(`[리뷰&사진] ${label} 최댓값 채택: ${max}`);
    return max;
  }
}
