import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{ directions: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[오시는길] 추출 시작');

      // 1) HTML 기반 먼저
      const html = await page.content();
      const fromHtml = this.extractFromHtml(html, logs);
      if (fromHtml) {
        logs.push(`[오시는길] HTML 패턴 성공 (${fromHtml.length}자)`);
        return { directions: fromHtml, logs };
      }

      logs.push('[오시는길] HTML 실패 → DOM 텍스트 기반 추출');

      // 2) DOM 전체 텍스트에서 "찾아오는길/오시는길" 문장만 선별
      const domText = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d || !d.body) return '';

        // ✅ 핵심: normalize는 "줄로 쪼갠 후"에 각 줄에만 적용
        const normalizeLine = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

        const rawInnerText: string = String(d.body.innerText || '');
        const rawTextContent: string = String(d.body.textContent || '');

        // innerText가 비면 textContent를 사용
        const baseRaw = rawInnerText.length > 30 ? rawInnerText : rawTextContent;

        // ✅ 먼저 줄 단위로 쪼갠다 (여기서 줄바꿈 유지가 핵심)
        const roughLines = baseRaw.split(/\r?\n|•|·/g);

        // 줄 정리
        const lines = roughLines
          .map(normalizeLine)
          .filter(s => s.length >= 6 && s.length <= 220); // 너무 긴 한줄은 버림

        // ✅ "찾아오는길" 실제 표현까지 포함
        const picked = lines.filter(s =>
          /찾아오는길|찾아오는 길|오시는길|오시는 길|출구|도보|미터|m\b|분\b|역\b|버스|주차|주차장|건물|층|입구|엘리베이터|횡단보도|위치/.test(s)
        );

        // 많이 잡히면 상위 12줄만
        return picked.slice(0, 12).join('\n');
      });

      const cleaned = this.postProcess(String(domText || ''));
      if (cleaned) {
        logs.push(`[오시는길] DOM 기반 추출 성공 (${cleaned.length}자)`);
        return { directions: cleaned, logs };
      }

      logs.push('[오시는길] 추출 실패');
      return { directions: '', logs };
    } catch (e: any) {
      logs.push(`[오시는길] 오류: ${e?.message || String(e)}`);
      return { directions: '', logs };
    }
  }

  private static extractFromHtml(html: string, logs: string[]): string {
    const patterns: RegExp[] = [
      /"wayToCome"\s*:\s*"([^"]{10,8000})"/,
      /"directions"\s*:\s*"([^"]{10,8000})"/,
      /"visitGuide"\s*:\s*"([^"]{10,8000})"/,
      /"comeRoute"\s*:\s*"([^"]{10,8000})"/,
      /"route"\s*:\s*"([^"]{10,8000})"/,
      /"transport"\s*:\s*"([^"]{10,8000})"/,
      /"guide"\s*:\s*"([^"]{10,8000})"/
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return this.postProcess(this.clean(m[1]));
    }

    logs.push('[오시는길] HTML 패턴 실패');
    return '';
  }

  private static postProcess(s: string): string {
    const t = (s || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
    const top = lines.slice(0, 12).join('\n');

    return top.length > 800 ? top.slice(0, 800).trim() : top;
  }

  private static clean(s: string) {
    return (s || '')
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\t/g, ' ')
      .replace(/\\r/g, '')
      .trim();
  }
}
