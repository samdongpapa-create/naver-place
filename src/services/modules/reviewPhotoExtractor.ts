import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{ reviewCount: number; photoCount: number; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[리뷰&사진] 추출 시작');

      // 1) 홈에서 리뷰는 최대값으로 잡기
      const homeHtml = await page.content();

      const reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi
      ], logs, '리뷰');

      // 홈에서 사진은 오탐이 많으니 참고만(탭 숫자 가능)
      const homePhotoHint = this.extractMaxNumber(homeHtml, [
        /"photoCount"[\s":]+([0-9,]+)/gi,
        /"imageCount"[\s":]+([0-9,]+)/gi,
        /사진\s*([0-9,]+)/gi
      ], logs, '사진(홈)');

      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}, 사진후보:${homePhotoHint}`);

      // 2) 사진 탭으로 이동해서 DOM으로 “사진 n”을 직접 찾는다
      const photoUrl = this.buildPhotoUrl(page.url());
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      let photoCount = 0;

      try {
        await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(1800);

        // DOM에서 숫자 찾기 (줄바꿈 유지 후 라인 스캔)
        const domNum = await page.evaluate(() => {
          const d: any = (globalThis as any).document;
          if (!d || !d.body) return 0;

          const raw = String(d.body.innerText || '');
          const lines = raw
            .split(/\r?\n|•|·/g)
            .map(s => (s || '').replace(/\s+/g, ' ').trim())
            .filter(s => s.length > 0 && s.length <= 200);

          // "사진 1,234" 같은 패턴을 최우선
          const nums: number[] = [];

          for (const line of lines) {
            // 예: "사진 1,234", "사진(1,234)", "사진 · 1,234"
            const m = line.match(/사진\s*[\(\·:]?\s*([0-9][0-9,]{0,})/);
            if (m?.[1]) {
              const n = parseInt(m[1].replace(/,/g, ''), 10);
              if (!Number.isNaN(n) && n > 0) nums.push(n);
            }
          }

          // 그래도 없으면, 페이지 전체에서 "사진" 근처 숫자 찾기
          if (!nums.length) {
            const all = raw.replace(/\s+/g, ' ');
            const m2 = all.match(/사진[^0-9]{0,10}([0-9][0-9,]{0,})/);
            if (m2?.[1]) {
              const n = parseInt(m2[1].replace(/,/g, ''), 10);
              if (!Number.isNaN(n) && n > 0) nums.push(n);
            }
          }

          if (!nums.length) return 0;
          return Math.max(...nums);
        });

        if (domNum && domNum > 0) {
          photoCount = domNum;
          logs.push(`[리뷰&사진] 사진탭 DOM에서 photoCount 발견: ${photoCount}`);
        } else {
          // DOM이 실패하면 HTML에서도 한 번 더 최대값 시도
          const photoHtml = await page.content();
          const htmlNum = this.extractMaxNumber(photoHtml, [
            /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
            /"photoTotalCount"[\s":]+([0-9,]+)/gi,
            /"imageTotalCount"[\s":]+([0-9,]+)/gi,
            /"photoCount"[\s":]+([0-9,]+)/gi,
            /"imageCount"[\s":]+([0-9,]+)/gi
          ], logs, '사진(탭-HTML)');

          photoCount = htmlNum;
          logs.push(`[리뷰&사진] 사진탭 HTML 기준 photoCount: ${photoCount}`);
        }
      } catch (e: any) {
        logs.push(`[리뷰&사진] 사진탭 이동/추출 실패: ${e?.message || String(e)}`);
      }

      // 3) 탭 숫자 오탐 컷: 1~4는 버림, 5도 애매하면(선택) 보류
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
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');

      if (path.endsWith('/home')) {
        u.pathname = path.replace(/\/home$/, '/photo');
        return u.toString();
      }
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
