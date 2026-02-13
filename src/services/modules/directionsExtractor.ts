import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{ directions: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[오시는길] 추출 시작');

      // 1) iframe HTML
      if (frame) {
        logs.push('[오시는길] iframe HTML 시도');
        const fromFrame = await this.extractFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame) return { directions: fromFrame, logs };
      } else {
        logs.push('[오시는길] frame 없음 → iframe 스킵');
      }

      // 2) page HTML
      logs.push('[오시는길] page HTML 시도');
      const fromPage = await this.extractFromHtml(await page.content(), logs, 'page');
      if (fromPage) return { directions: fromPage, logs };

      // 3) DOM fallback
      logs.push('[오시는길] HTML 실패 → DOM fallback 시도');

      const domText = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d) return '';

        const labels = ['오시는길', '오시는 길', '찾아오는길', '찾아오는 길', '오시는방법', '방문 안내'];
        const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

        const nodes: any[] = Array.from(d.querySelectorAll('h1,h2,h3,strong,span,div,p,li') || []);
        const labelEl = nodes.find((node: any) => {
          const t = normalize(node?.textContent || '');
          return labels.some(l => t === l || t.includes(l));
        });

        const pickLongText = (node: any) => {
          if (!node) return '';
          const t = normalize(node.textContent || '');
          if (t.length < 10) return '';
          const cleaned = t
            .replace(/오시는길|오시는 길|찾아오는길|찾아오는 길|오시는방법|방문 안내/g, '')
            .replace(/^[:\-]\s*/, '')
            .trim();
          return cleaned.length >= 10 ? cleaned : '';
        };

        // 라벨을 못 찾으면, 페이지 전체에서 이동 힌트 문장 찾기
        if (!labelEl) {
          const body = normalize(d.body?.innerText || '');
          const parts = body
            .split(/\n|\r|\t|•|·/g)
            .map(s => normalize(s))
            .filter(s => s.length >= 10);
          const hint = parts.find(s => /출구|도보|미터|m|분|역|버스|주차|주차장|길찾기/.test(s));
          return hint || '';
        }

        // 부모로 올라가며 텍스트 찾기
        let cur: any = labelEl;
        for (let i = 0; i < 7; i++) {
          cur = cur?.parentElement || null;
          const text = pickLongText(cur);
          if (text) return text;
        }

        // 다음 형제
        const next = labelEl?.nextElementSibling || null;
        const nextText = pickLongText(next);
        if (nextText) return nextText;

        return '';
      });

      const cleaned = String(domText || '').trim();
      if (cleaned) {
        logs.push(`[오시는길] DOM fallback 성공 (${cleaned.length}자)`);
        return { directions: cleaned, logs };
      }

      logs.push('[오시는길] 추출 실패');
      return { directions: '', logs };
    } catch (e: any) {
      logs.push(`[오시는길] 오류: ${e?.message || String(e)}`);
      return { directions: '', logs };
    }
  }

  private static async extractFromHtml(html: string, logs: string[], label: string): Promise<string> {
    logs.push(`[오시는길] ${label} HTML 길이: ${html.length}`);

    // matchAll 제거 -> match만 사용 (g 필요 없음)
    const patterns: RegExp[] = [
      /"wayToCome"\s*:\s*"([^"]{10,8000})"/,
      /"directions"\s*:\s*"([^"]{10,8000})"/,
      /"visitGuide"\s*:\s*"([^"]{10,8000})"/,
      /"comeRoute"\s*:\s*"([^"]{10,8000})"/,
      /"route"\s*:\s*"([^"]{10,8000})"/,
      /"transport"\s*:\s*"([^"]{10,8000})"/,
      /"guide"\s*:\s*"([^"]{10,8000})"/
    ];

    let best = '';

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) {
        const text = this.clean(m[1]);
        if (text.length >= 10 && text.length > best.length) best = text;
      }
    }

    if (best) {
      logs.push(`[오시는길] ${label} 패턴 성공 (${best.length}자)`);
      return best;
    }

    logs.push(`[오시는길] ${label} 패턴 실패`);
    return '';
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
