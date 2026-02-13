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

      // 3) DOM fallback (라벨 주변에서 "무조건" 텍스트 가져온 뒤, 밖에서 컷)
      logs.push('[오시는길] HTML 실패 → DOM fallback 시도');

      const raw = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d) return '';

        const normalize = (s: string) => (s || '').replace(/\s+/g, ' ').trim();
        const labels = ['오시는길', '오시는 길', '찾아오는길', '찾아오는 길', '오시는방법', '방문 안내'];

        const nodes: any[] = Array.from(d.querySelectorAll('h1,h2,h3,strong,span,div,p,li') || []);

        const labelEl = nodes.find((node: any) => {
          const t = normalize(node?.textContent || '');
          return labels.some(l => t === l || t.includes(l));
        });

        const cleanLabel = (t: string) =>
          t
            .replace(/오시는길|오시는 길|찾아오는길|찾아오는 길|오시는방법|방문 안내/g, '')
            .replace(/^[:\-]\s*/, '')
            .trim();

        const textOf = (node: any) => cleanLabel(normalize(node?.textContent || ''));

        // ✅ 1) 라벨이 있으면: 조상으로 올라가며 가장 "긴 텍스트"를 하나 잡는다(상한 없음)
        if (labelEl) {
          let best = '';
          let cur: any = labelEl;

          for (let i = 0; i < 10; i++) {
            cur = cur?.parentElement || null;
            if (!cur) break;
            const t = textOf(cur);
            if (t.length > best.length) best = t;
          }

          // 다음 형제도 후보로
          const next = labelEl?.nextElementSibling || null;
          const nextText = textOf(next);
          if (nextText.length > best.length) best = nextText;

          return best || '';
        }

        // ✅ 2) 라벨이 없으면: 페이지 전체에서 "이동 관련 문장"만 골라서 합치기(전체 body 반환 금지)
        const body = normalize(d.body?.innerText || '');
        const lines = body
          .split(/\n|\r|•|·/g)
          .map(s => normalize(s))
          .filter(s => s.length >= 8 && s.length <= 200);

        const picked = lines.filter(s =>
          /출구|도보|미터|m\b|분\b|역\b|버스|주차|주차장|길찾기|건물|층|입구/.test(s)
        );

        return picked.slice(0, 12).join('\n');
      });

      const cleaned = this.postProcess(String(raw || ''));
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
      const m = html.match(p);
      if (m?.[1]) {
        const text = this.clean(m[1]);
        if (text.length >= 10 && text.length > best.length) best = text;
      }
    }

    if (best) {
      const processed = this.postProcess(best);
      logs.push(`[오시는길] ${label} 패턴 성공 (${processed.length}자)`);
      return processed;
    }

    logs.push(`[오시는길] ${label} 패턴 실패`);
    return '';
  }

  private static postProcess(s: string): string {
    const t = s
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 너무 길면 상위 12줄만 + 최대 800자 컷
    const lines = t.split('\n').map(x => x.trim()).filter(Boolean);
    const top = lines.slice(0, 12).join('\n');

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
