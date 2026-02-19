import { Page, Frame } from 'playwright';

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string
  ): Promise<{ reviewCount: number; photoCount: number; logs: string[] }> {
    const logs: string[] = [];
    logs.push('[리뷰&사진] 추출 시작');

    let reviewCount = 0;
    let photoCount = 0;

    try {
      // ✅ 1) 리뷰는 home 기준으로 안정적으로 다시 추출 (현재 /price여도 OK)
      const homeUrl = `https://m.place.naver.com/hairshop/${placeId}/home`;
      logs.push(`[리뷰&사진] 홈 이동(리뷰 기준): ${homeUrl}`);

      await page.goto(homeUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);

      const homeHtml = await page.content();

      reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi,
        /리뷰\s*([0-9,]+)/gi
      ]);

      logs.push(`[리뷰&사진] 리뷰 최댓값: ${reviewCount}`);
      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}`);

      // ✅ 2) 업체사진은 photo 탭 절대경로로 이동해서 탭 라벨 숫자 파싱
      const photoUrl = `https://m.place.naver.com/hairshop/${placeId}/photo`;
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      await page.goto(photoUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(1800);

      // 업체사진 탭 텍스트 파싱 (있으면 가장 좋음)
      const tabTextBefore = await this.getTabText(page, '업체사진');
      logs.push(`[리뷰&사진] 업체사진 탭 텍스트(전): ${tabTextBefore ? tabTextBefore : '(없음)'}`);

      let parsed = this.parseCountFromText(tabTextBefore);
      if (parsed > 0) {
        photoCount = parsed;
        logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(전): ${photoCount}`);
      }

      // 탭 클릭 시도
      const clicked = await this.clickTab(page, '업체사진');
      logs.push(`[리뷰&사진] 업체사진 탭 클릭: ${clicked ? '성공' : '실패/이미선택'}`);
      await page.waitForTimeout(1000);

      const tabTextAfter = await this.getTabText(page, '업체사진');
      logs.push(`[리뷰&사진] 업체사진 탭 텍스트(후): ${tabTextAfter ? tabTextAfter : '(없음)'}`);

      parsed = this.parseCountFromText(tabTextAfter);
      if (parsed > photoCount) {
        photoCount = parsed;
        logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(후): ${photoCount}`);
      }

      // DOM 전체에서 “업체사진” 라인 보조 파싱
      if (photoCount === 0) {
        const domLine = await page.evaluate(() => {
          const d: any = (globalThis as any).document;
          if (!d || !d.body) return '';
          const raw = String(d.body.innerText || '');
          const lines = raw.split(/\r?\n|•|·/g).map(s => (s || '').replace(/\s+/g, ' ').trim());
          const hit = lines.find(s => /업체\s*사진|업체사진/.test(s) && s.length <= 120);
          return hit || '';
        });

        logs.push(`[리뷰&사진] DOM에서 업체사진 라인: ${domLine ? domLine : '(없음)'}`);

        const domParsed = this.parseCountFromText(domLine);
        if (domParsed > 0) {
          photoCount = domParsed;
          logs.push(`[리뷰&사진] DOM 업체사진 라인에서 count 파싱 성공: ${photoCount}`);
        }
      }

      // 오탐 컷
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] photoCount=${photoCount} 오탐 가능 → 0 처리`);
        photoCount = 0;
      }
      if (photoCount === 5 && reviewCount >= 200) {
        logs.push('[리뷰&사진] 사진=5 & 리뷰가 많음 → 탭 숫자 오탐으로 판단, 0 처리');
        photoCount = 0;
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}`);
      return { reviewCount, photoCount, logs };
    } catch (e: any) {
      logs.push(`[리뷰&사진] 오류: ${e?.message || String(e)}`);
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, logs };
    }
  }

  private static parseCountFromText(text?: string | null): number {
    if (!text) return 0;
    const t = String(text);

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
        const cnt = await loc.count().catch(() => 0);
        if (cnt > 0) {
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
      const cnt = await loc.count().catch(() => 0);
      if (cnt > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 1500 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  }

  private static extractMaxNumber(html: string, regexList: RegExp[]): number {
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
    return Math.max(...nums);
  }
}
