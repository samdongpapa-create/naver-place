import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{ reviewCount: number; photoCount: number; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[리뷰&사진] 추출 시작');

      // 1) 홈에서 리뷰: 최대값
      const homeHtml = await page.content();

      const reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi
      ], logs, '리뷰');

      // 홈 사진 힌트(오탐 가능)
      const homePhotoHint = this.extractMaxNumber(homeHtml, [
        /"photoCount"[\s":]+([0-9,]+)/gi,
        /"imageCount"[\s":]+([0-9,]+)/gi,
        /사진\s*([0-9,]+)/gi
      ], logs, '사진(홈)');

      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}, 사진후보:${homePhotoHint}`);

      // 2) 사진 탭으로 이동
      const photoUrl = this.buildPhotoUrl(page.url());
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      let photoCount = 0;

      try {
        await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // ✅ 2-1) DOM에서 “사진 1,234” 텍스트를 최우선으로 찾는다
        const domResult = await page.evaluate(() => {
          const d: any = (globalThis as any).document;
          if (!d || !d.body) return { best: 0, samples: [] as string[] };

          const normalizeLine = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

          const raw = String(d.body.innerText || '');
          const lines = raw
            .split(/\r?\n|•|·/g)
            .map(normalizeLine)
            .filter(s => s.length > 0 && s.length <= 200);

          const samples: string[] = [];
          const nums: number[] = [];

          // 우선순위 1: “사진 1,234” (정확)
          for (const line of lines) {
            const m = line.match(/^사진\s*([0-9][0-9,]{0,})$/) || line.match(/사진\s*[:\(\·]?\s*([0-9][0-9,]{0,})/);
            if (m?.[1]) {
              const n = parseInt(m[1].replace(/,/g, ''), 10);
              if (!Number.isNaN(n) && n > 0) {
                nums.push(n);
                if (samples.length < 8) samples.push(line);
              }
            }
          }

          // 우선순위 2: “전체 사진”, “포토”, “이미지” 등 변형
          if (!nums.length) {
            for (const line of lines) {
              const m =
                line.match(/(전체\s*)?(사진|포토|이미지)\s*[:\(\·]?\s*([0-9][0-9,]{0,})/) ||
                line.match(/([0-9][0-9,]{0,})\s*(장|개)\s*(사진|포토|이미지)/);
              if (m) {
                const rawNum = m[3] || m[1];
                const n = parseInt(String(rawNum).replace(/,/g, ''), 10);
                if (!Number.isNaN(n) && n > 0) {
                  nums.push(n);
                  if (samples.length < 8) samples.push(line);
                }
              }
            }
          }

          const best = nums.length ? Math.max(...nums) : 0;
          return { best, samples };
        });

        logs.push(`[리뷰&사진] 사진탭 DOM samples: ${(domResult?.samples || []).join(' | ')}`);

        if (domResult?.best && domResult.best > 0) {
          photoCount = domResult.best;
          logs.push(`[리뷰&사진] 사진탭 DOM에서 photoCount 확정: ${photoCount}`);
        } else {
          // ✅ 2-2) DOM 실패 시 HTML 키 확장해서 최대값
          const photoHtml = await page.content();
          const htmlNum = this.extractMaxNumber(photoHtml, [
            /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
            /"photoTotalCount"[\s":]+([0-9,]+)/gi,
            /"imageTotalCount"[\s":]+([0-9,]+)/gi,
            /"ugcPhotoCount"[\s":]+([0-9,]+)/gi,
            /"placePhotoCount"[\s":]+([0-9,]+)/gi,
            /"photoCount"[\s":]+([0-9,]+)/gi,
            /"imageCount"[\s":]+([0-9,]+)/gi
          ], logs, '사진(탭-HTML)');

          photoCount = htmlNum;
          logs.push(`[리뷰&사진] 사진탭 HTML 기준 photoCount: ${photoCount}`);
        }
      } catch (e: any) {
        logs.push(`[리뷰&사진] 사진탭 이동/추출 실패: ${e?.message || String(e)}`);
      }

      // ✅ 3) 오탐 컷 강화:
      // - 1~4 무조건 오탐
      // - "5"도 탭 숫자일 가능성이 높아서: 리뷰가 수천인데 사진이 5면 비정상 → 0 처리
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] 사진 최종값 ${photoCount}는 오탐 가능 → 0 처리`);
        photoCount = 0;
      }
      if (photoCount === 5 && reviewCount >= 200) {
        logs.push('[리뷰&사진] 사진=5 & 리뷰가 많음 → 탭 숫자 오탐으로 판단, 0 처리');
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
