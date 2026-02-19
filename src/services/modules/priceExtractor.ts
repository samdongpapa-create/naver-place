import { Page, Frame } from 'playwright';

export type MenuItem = { name: string; price: string; desc: string };

export class PriceExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string
  ): Promise<{ menuCount: number; menus: MenuItem[]; logs: string[] }> {
    const logs: string[] = [];
    logs.push('[가격/메뉴] 추출 시작');

    try {
      // ✅ 절대 경로로 이동 (현재 페이지가 /home 이든 /price 든 상관없음)
      const priceUrl = `https://m.place.naver.com/hairshop/${placeId}/price`;
      logs.push(`[가격/메뉴] 가격탭 이동: ${priceUrl}`);

      await page.goto(priceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForTimeout(2000);

      logs.push('[가격/메뉴] DOM 기반 메뉴 추출 시도');

      // ✅ DOM 텍스트 기반으로 “메뉴명 + 가격” 형태 후보를 폭넓게 수집
      const rawItems = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d || !d.body) return [];

        const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

        // li 기반이 가장 흔하지만, 구조 바뀌는 케이스 대비해서 넓게 수집
        const nodes = Array.from(d.querySelectorAll('li, a, button, div'));
        const candidates: string[] = [];

        for (const el of nodes) {
          const text = normalize((el as any).innerText || '');
          if (!text) continue;

          // 너무 긴 블록은 제외 (페이지 전체 설명/공지 등)
          if (text.length > 160) continue;

          // “원”, “문의”, “무료”, “별도” 등이 들어간 것만 후보
          if (
            /원/.test(text) ||
            /문의/.test(text) ||
            /무료/.test(text) ||
            /별도/.test(text)
          ) {
            // 너무 일반적인 문구 제외
            if (/영업시간|예약|리뷰|오시는길|길찾기|전화|공유/.test(text)) continue;
            candidates.push(text);
          }
        }

        // 중복 제거
        return Array.from(new Set(candidates));
      });

      logs.push(`[가격/메뉴] 후보 텍스트 수: ${rawItems.length}`);

      // ✅ 후보 텍스트를 (name/price/desc)로 정리
      const menus: MenuItem[] = [];
      const seen = new Set<string>();

      for (const t of rawItems) {
        const lines = t.split('\n').map(s => s.trim()).filter(Boolean);

        // lines가 없으면 스킵
        if (!lines.length) continue;

        // 가격 라인 찾기
        const priceLine =
          lines.find(l => /[0-9][0-9,]*\s*원/.test(l)) ||
          lines.find(l => /문의|무료|별도/.test(l)) ||
          '';

        // 메뉴명: 보통 첫 줄이 메뉴명
        const name = (lines[0] || '').replace(/\s+/g, ' ').trim();

        // name이 너무 짧거나 priceLine이 없으면 스킵
        if (!name) continue;
        if (!priceLine) continue;

        // 설명은 name/price 제외 나머지 합치기
        const desc = lines
          .filter(l => l !== name && l !== priceLine)
          .join(' ')
          .trim();

        // 키 중복 제거
        const key = `${name}||${priceLine}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // 너무 이상한 메뉴명 제외
        if (/^\d+$/.test(name)) continue;
        if (name.length > 60) continue;

        menus.push({
          name,
          price: priceLine.replace(/\s+/g, ' ').trim(),
          desc
        });
      }

      // 너무 과하게 잡히면 상위만
      const finalMenus = menus.slice(0, 50);

      logs.push(`[가격/메뉴] 메뉴 수: ${finalMenus.length}`);

      return { menuCount: finalMenus.length, menus: finalMenus, logs };
    } catch (e: any) {
      logs.push(`[가격/메뉴] 오류: ${e?.message || String(e)}`);
      return { menuCount: 0, menus: [], logs };
    }
  }
}
