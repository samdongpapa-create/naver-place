import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    _frame?: Frame | null
  ): Promise<{ directions: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[오시는길] 추출 시작');

      // 1) HTML 기반 먼저 시도
      const html = await page.content();
      const fromHtml = this.extractFromHtml(html, logs);
      if (fromHtml) {
        logs.push(`[오시는길] HTML 패턴 성공 (${fromHtml.length}자)`);
        return { directions: fromHtml, logs };
      }

      logs.push('[오시는길] HTML 실패 → DOM 텍스트 기반 추출');

      // 2) DOM 전체 텍스트에서 이동 관련 문장만 선별
      const domText = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d || !d.body) return '';

        const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

        const body = normalize(d.body.innerText || '');

        const lines = body
          .split(/\n|\r|•|·/g)
          .map((s: string) => normalize(s))
          .filter((s: string) => s.length >= 8 && s.length <= 200);

        const picked = lines.filter((s: string) =>
          /출구|도보|미터|m\b|분\b|역\b|버스|주차|주차장|건물|층|입구|엘리베이터|횡단보도/.test(s)
        );

        return picked.slice(0, 15).join('\n');
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
      /"comeRoute"\s*:\s*"([^"]{10,8000})"/
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) {
        return this.postProcess(this.clean(m[1]));
      }
    }

    logs.push('[오시는길] HTML 패턴 실패');
    return '';
  }

  private static postProcess(s: string): string {
    const t = s
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
    const top = lines.slice(0, 15).join('\n');

    return top.length > 800 ? top.slice(0, 800).trim() : top;
  }

  private static clean(s: string) {
    return s
      .replace(/\\n/g, '\n')
      .replace(/\\"/g, '"')
      .replace(/\\t/g, ' ')
      .replace(/\\r/g, '')
      .trim();
  }
}
