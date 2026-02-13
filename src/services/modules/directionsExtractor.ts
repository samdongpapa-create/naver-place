import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{ directions: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[오시는길] 추출 시작');

      // 1) HTML 패턴 (iframe -> page 순)
      if (frame) {
        logs.push('[오시는길] iframe HTML 시도');
        const fromFrame = await this.extractFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame) return { directions: fromFrame, logs };
      } else {
        logs.push('[오시는길] frame 없음 → iframe 스킵');
      }

      logs.push('[오시는길] page HTML 시도');
      const fromPage = await this.extractFromHtml(await page.content(), logs, 'page');
      if (fromPage) return { directions: fromPage, logs };

      // 2) ✅ DOM fallback (더보기 클릭 후 실제 문장이 DOM에 풀림)
      logs.push('[오시는길] HTML 실패 → DOM fallback 시도');

      const domText = await page.evaluate(() => {
        const labels = ['오시는길', '오시는 길', '찾아오는길', '찾아오는 길', '오시는방법', '방문 안내'];

        const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();

        // label을 포함한 요소 찾기
        const nodes = Array.from(document.querySelectorAll('h1,h2,h3,strong,span,div,p,li'));
        const labelEl = nodes.find(el => {
          const t = normalize(el.textContent || '');
          return labels.some(l => t === l || t.includes(l));
        });

        if (!labelEl) return '';

        const pickLongText = (el: Element | null) => {
          if (!el) return '';
          const t = normalize(el.textContent || '');
          // 너무 짧으면 무시
          if (t.length < 10) return '';
          // 라벨만 있는 텍스트 제거
          const cleaned = t
            .replace(/오시는길|오시는 길|찾아오는길|찾아오는 길|오시는방법|방문 안내/g, '')
            .replace(/^[:\-]\s*/, '')
            .trim();
          return cleaned.length >= 10 ? cleaned : '';
        };

        // 1) 같은 카드(부모)에서 긴 텍스트 시도
        let cur: Element | null = labelEl;
        for (let i = 0; i < 6; i++) {
          cur = cur?.parentElement || null;
          const text = pickLongText(cur);
          if (text) return text;
        }

        // 2) 다음 형제에서 시도
        const next = (labelEl as HTMLElement).nextElementSibling;
        const nextText = pickLongText(next);
        if (nextText) return nextText;

        // 3) 조상에서 못 찾으면, 페이지 전체에서 “출구/도보/미터/분/역” 같은 이동 정보 문장 추출
        const body = normalize(document.body.innerText || '');
        const candidates = body
          .split(/\n|\r|\t|•|·/g)
          .map(s => normalize(s))
          .filter(s => s.length >= 10);

        const moveHint = candidates.find(s =>
          /출구|도보|m|미터|분|역|버스|주차|주차장|길찾기/.test(s)
        );

        return moveHint || '';
      });

      const cleaned = (domText || '').trim();
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
      const matches = html.matchAll(p);
      for (const m of matches) {
        const raw = m?.[1];
        if (!raw) continue;
        const text = this.clean(raw);
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
