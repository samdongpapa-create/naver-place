import { Page, Frame } from 'playwright';

export class PriceExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{
    menuCount: number;
    menus: { name: string; price: string; desc: string }[];
    logs: string[];
  }> {
    const logs: string[] = [];

    try {
      logs.push('[가격/메뉴] 추출 시작');

      const priceUrl = this.buildPriceUrl(page.url());
      logs.push(`[가격/메뉴] 가격탭 이동: ${priceUrl}`);

      await page.goto(priceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      const html = await page.content();
      logs.push(`[가격/메뉴] HTML 길이: ${html.length}`);

      // 메뉴 배열 후보 키들
      const patterns: RegExp[] = [
        /"menuList"\s*:\s*(\[[\s\S]*?\])/,
        /"priceList"\s*:\s*(\[[\s\S]*?\])/,
        /"menus"\s*:\s*(\[[\s\S]*?\])/,
        /"items"\s*:\s*(\[[\s\S]*?\])/
      ];

      let rawArray = '';

      for (const p of patterns) {
        const m = html.match(p);
        if (m?.[1] && m[1].length > rawArray.length) {
          rawArray = m[1];
        }
      }

      if (!rawArray) {
        logs.push('[가격/메뉴] 메뉴 배열 패턴 실패');
        return { menuCount: 0, menus: [], logs };
      }

      // JSON 파싱 시도
      let parsed: any[] = [];
      try {
        parsed = JSON.parse(rawArray);
      } catch {
        logs.push('[가격/메뉴] JSON.parse 실패 → 수동 파싱 시도');
      }

      const menus: { name: string; price: string; desc: string }[] = [];

      if (Array.isArray(parsed)) {
        for (const item of parsed) {
          const name =
            item?.name ||
            item?.menuName ||
            item?.title ||
            '';

          const price =
            item?.price ||
            item?.priceText ||
            item?.amount ||
            '';

          const desc =
            item?.description ||
            item?.desc ||
            '';

          if (name) {
            menus.push({
              name: String(name).trim(),
              price: String(price || '').trim(),
              desc: String(desc || '').trim()
            });
          }
        }
      }

      logs.push(`[가격/메뉴] 메뉴 수: ${menus.length}`);

      return {
        menuCount: menus.length,
        menus: menus.slice(0, 30), // 상위 30개만
        logs
      };

    } catch (e: any) {
      logs.push(`[가격/메뉴] 오류: ${e?.message || String(e)}`);
      return { menuCount: 0, menus: [], logs };
    }
  }

  private static buildPriceUrl(currentUrl: string): string {
    try {
      const u = new URL(currentUrl);
      const path = u.pathname.replace(/\/+$/, '');

      if (path.endsWith('/home')) {
        u.pathname = path.replace(/\/home$/, '/price');
        return u.toString();
      }
      if (!path.endsWith('/price')) {
        u.pathname = `${path}/price`;
      }
      return u.toString();
    } catch {
      return currentUrl;
    }
  }
}
