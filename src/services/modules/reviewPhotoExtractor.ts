import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{ reviewCount: number; photoCount: number; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[리뷰&사진] 추출 시작');

      // 1) 홈에서 리뷰 수는 최대값으로
      const homeHtml = await page.content();
      const reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi
      ], logs, '리뷰');

      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}`);

      // 2) 사진 탭으로 이동
      const photoUrl = this.buildPhotoUrl(page.url());
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      let photoCount = 0;

      try {
        await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.waitForTimeout(2000);

        // ✅ 핵심: "업체사진" 탭 텍스트에서 숫자 뽑기
        // 2-1) 먼저 탭 라벨에 숫자가 있으면 바로 파싱
        const tabTextBefore = await this.getTabText(page, '업체사진');
        logs.push(`[리뷰&사진] 업체사진 탭 텍스트(전): ${tabTextBefore || '(없음)'}`);

        const parsedBefore = this.parseCountFromText(tabTextBefore);
        if (parsedBefore > 0) {
          photoCount = parsedBefore;
          logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(전): ${photoCount}`);
        }

        // 2-2) 탭을 클릭해서 "업체사진" 뷰로 전환 (전환 후 텍스트 다시 파싱)
        const clicked = await this.clickTab(page, '업체사진');
        logs.push(`[리뷰&사진] 업체사진 탭 클릭: ${clicked ? '성공' : '실패/이미선택'}`);

        await page.waitForTimeout(1200);

        const tabTextAfter = await this.getTabText(page, '업체사진');
        logs.push(`[리뷰&사진] 업체사진 탭 텍스트(후): ${tabTextAfter || '(없음)'}`);

        const parsedAfter = this.parseCountFromText(tabTextAfter);
        if (parsedAfter > photoCount) {
          photoCount = parsedAfter;
          logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(후): ${photoCount}`);
        }

        // 2-3) 그래도 없으면 DOM 전체에서 "업체사진" 근처 숫자 찾기 (안전장치)
        if (photoCount === 0) {
          const domNear = await page.evaluate(() => {
            const d: any = (globalThis as any).document;
            if (!d || !d.body) return '';

            const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
            const raw = String(d.body.innerText || '');
            const lines = raw
              .split(/\r?\n|•|·/g)
              .map(normalize)
              .filter(s => s.length > 0 && s.length <= 200);

            // "업체사진 123" / "업체 사진 123" / "업체사진(123)" 같은 라인 찾기
            const hit = lines.find(s => /업체\s*사진|업체사진/.test(s));
            return hit || '';
          });

          logs.push(`[리뷰&사진] DOM에서 업체사진 라인: ${domNear || '(없음)'}`);

          const domParsed = this.parseCountFromText(domNear);
          if (domParsed > 0) {
            photoCount = domParsed;
            logs.push(`[리뷰&사진] DOM 업체사진 라인에서 count 파싱 성공: ${photoCount}`);
          }
        }

        // 2-4) 마지막 fallback: /photo HTML에서 관련 키 최대값(있으면)
        if (photoCount === 0) {
          const photoHtml = await page.content();
          const htmlNum = this.extractMaxNumber(photoHtml, [
            /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
            /"photoTotalCount"[\s":]+([0-9,]+)/gi,
            /"imageTotalCount"[\s":]+([0-9,]+)/gi,
            /"ugcPhotoCount"[\s":]+([0-9,]+)/gi,
            /"placePhotoCount"[\s":]+([0-9,]+)/gi,
            /"businessPhotoCount"[\s":]+([0-9,]+)/gi,
            /"ownerPhotoCount"[\s":]+([0-9,]+)/gi
          ], logs, '사진(탭-HTML)');

          photoCount = htmlNum;
          logs.push(`[리뷰&사진] 사진탭 HTML fallback photoCount: ${photoCount}`);
        }

      } catch (e: any) {
        logs.push(`[리뷰&사진] 사진탭 이동/추출 실패: ${e?.message || String(e)}`);
      }

      // 오탐 컷: 1~4는 무조건 오탐
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] photoCount=${photoCount} 오탐 가능 → 0 처리`);
        photoCount = 0;
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}`);
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
      if (!path.endsWith('/photo')) u.pathname = `${path}/photo`;
      return u.toString();
    } catch {
      return currentUrl;
    }
  }

  private static parseCountFromText(text?: string | null): number {
    if (!text) return 0;
    const t = String(text);

    // "업체사진 1,234" / "업체사진(1234)" / "업체 사진 · 123" 등
    const m =
      t.match(/업체\s*사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/업체사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/\(([0-9][0-9,]{0,})\)/);

    if (!m?.[1]) return 0;
    const n = parseInt(m[1].replace(/,/g, ''), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  private static async getTabText(page: Page, tabLabel: string): Promise<string> {
    const candidates = [
      page.locator('a,button,div[role="tab"]', { hasText: tabLabel }).first(),
      page.locator(`text=${tabLabel}`).first()
    ];

    for (const loc of candidates) {
      try {
        if (await loc.count().catch(() => 0)) {
          const txt = await loc.textContent().catch(() => '');
          if (txt && txt.trim()) return txt.trim();
        }
      } catch {}
    }
    return '';
  }

  private static async clickTab(page: Page, tabLabel: string): Promise<boolean> {
    const loc = page.locator('a,button,div[role="tab"]', { hasText: tabLabel }).first();
    try {
      if (await loc.count().catch(() => 0)) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 1500 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
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
