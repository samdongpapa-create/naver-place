import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
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

      // 2) DOM 텍스트: page에서 시도
      const pageDom = await this.extractFromDomContext(page, logs, 'page');
      if (pageDom) {
        logs.push(`[오시는길] DOM(page) 성공 (${pageDom.length}자)`);
        return { directions: pageDom, logs };
      }

      // 3) DOM 텍스트: frame에서도 시도 (있으면)
      if (frame) {
        const frameDom = await this.extractFromDomContext(frame, logs, 'frame');
        if (frameDom) {
          logs.push(`[오시는길] DOM(frame) 성공 (${frameDom.length}자)`);
          return { directions: frameDom, logs };
        }
      } else {
        logs.push('[오시는길] frame 없음 → DOM(frame) 스킵');
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
      /"guide"\s*:\s*"([^"]{10,8000})"/,
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) return this.postProcess(this.clean(m[1]));
    }

    logs.push('[오시는길] HTML 패턴 실패');
    return '';
  }

  private static async extractFromDomContext(
    ctx: any, // Page | Frame (DOM lib 없이 타입 우회)
    logs: string[],
    label: 'page' | 'frame'
  ): Promise<string> {
    const debugJson = await ctx.evaluate(() => {
      const d: any = (globalThis as any).document;
      if (!d || !d.body) {
        return JSON.stringify({
          ok: false,
          reason: 'no_document_or_body',
          innerTextLen: 0,
          textContentLen: 0,
          lineCount: 0,
          pickedCount: 0
        });
      }

      const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

      const innerText = normalize(d.body.innerText || '');
      const textContent = normalize(d.body.textContent || '');

      // innerText가 비어있으면 textContent로 fallback
      const base = innerText.length >= 20 ? innerText : textContent;

      const lines = base
        .split(/\n|\r|•|·/g)
        .map((s: string) => normalize(s))
        .filter((s: string) => s.length >= 8 && s.length <= 200);

      const picked = lines.filter((s: string) =>
        /오시는길|오시는 길|찾아오는길|찾아오는 길|출구|도보|미터|m\b|분\b|역\b|버스|주차|주차장|건물|층|입구|엘리베이터|횡단보도|방문/.test(s)
      );

      const result = picked.slice(0, 15).join('\n');

      return JSON.stringify({
        ok: true,
        innerTextLen: innerText.length,
        textContentLen: textContent.length,
        baseLen: base.length,
        lineCount: lines.length,
        pickedCount: picked.length,
        samplePicked: picked.slice(0, 5),
        resultLen: result.length,
        result
      });
    });

    let dbg: any = null;
    try {
      dbg = JSON.parse(String(debugJson || '{}'));
    } catch {
      logs.push(`[오시는길][DOM-${label}] debug JSON parse 실패`);
      return '';
    }

    if (!dbg?.ok) {
      logs.push(`[오시는길][DOM-${label}] document/body 없음`);
      return '';
    }

    logs.push(
      `[오시는길][DOM-${label}] innerTextLen=${dbg.innerTextLen}, textContentLen=${dbg.textContentLen}, baseLen=${dbg.baseLen}, lines=${dbg.lineCount}, picked=${dbg.pickedCount}, resultLen=${dbg.resultLen}`
    );
    if (Array.isArray(dbg.samplePicked) && dbg.samplePicked.length) {
      logs.push(`[오시는길][DOM-${label}] samplePicked: ${dbg.samplePicked.join(' | ')}`);
    }

    const cleaned = this.postProcess(String(dbg.result || ''));
    return cleaned;
  }

  private static postProcess(s: string): string {
    const t = (s || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
    const top = lines.slice(0, 15).join('\n');

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
