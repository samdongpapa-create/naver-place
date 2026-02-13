import { Page, Frame } from 'playwright';

export class DescriptionExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{ description: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[상세설명] 추출 시작');

      // iframe 우선
      if (frame) {
        logs.push('[상세설명] iframe에서 추출 시도');
        const fromFrame = this.extractBestFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame) return { description: fromFrame, logs };
      } else {
        logs.push('[상세설명] frame 없음 → iframe 스킵');
      }

      // page fallback
      logs.push('[상세설명] page에서 fallback 추출');
      const fromPage = this.extractBestFromHtml(await page.content(), logs, 'page');
      if (fromPage) return { description: fromPage, logs };

      // DOM fallback (더보기 클릭 후 소개 카드 문장 잡기)
      logs.push('[상세설명] HTML 실패 → DOM fallback 시도');
      const dom = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        if (!d || !d.body) return '';

        const normalizeLine = (s: string) => (s || '').replace(/\s+/g, ' ').trim();

        const raw = String(d.body.innerText || '');
        const roughLines = raw.split(/\r?\n|•|·/g).map(normalizeLine);

        // 소개/미용실/정품/아베다 등 특징 문장 후보들
        const picked = roughLines.filter(s =>
          s.length >= 10 &&
          s.length <= 220 &&
          /소개|미용실|살롱|아베다|정품|디자이너|상담|1:1|시술|커트|펌|염색/.test(s)
        );

        return picked.slice(0, 12).join('\n');
      });

      const cleaned = this.postProcess(String(dom || ''), 1200);
      if (cleaned) {
        logs.push(`[상세설명] DOM fallback 성공 (${cleaned.length}자)`);
        return { description: cleaned, logs };
      }

      logs.push('[상세설명] 추출 실패');
      return { description: '', logs };
    } catch (error: any) {
      logs.push(`[상세설명] 오류: ${error?.message || String(error)}`);
      return { description: '', logs };
    }
  }

  private static extractBestFromHtml(html: string, logs: string[], label: string): string {
    logs.push(`[상세설명] ${label} HTML 길이: ${html.length}`);

    // ✅ 후보 키를 넓게 + 여러 개 나오면 “가장 긴 텍스트” 채택
    const patterns: RegExp[] = [
      /"description"\s*:\s*"([^"]{20,20000})"/g,
      /"placeDescription"\s*:\s*"([^"]{20,20000})"/g,
      /"intro"\s*:\s*"([^"]{20,20000})"/g,
      /"businessSummary"\s*:\s*"([^"]{20,20000})"/g,
      /"bizIntro"\s*:\s*"([^"]{20,20000})"/g,
      /"storeIntro"\s*:\s*"([^"]{20,20000})"/g
    ];

    let best = '';

    for (const p of patterns) {
      const matches = html.matchAll(p);
      for (const m of matches) {
        const raw = m?.[1];
        if (!raw) continue;
        const text = this.clean(raw);
        if (text.length > best.length) best = text;
      }
    }

    if (!best) {
      logs.push(`[상세설명] ${label} 패턴 매칭 실패`);
      return '';
    }

    const out = this.postProcess(best, 1200);
    logs.push(`[상세설명] ${label} 패턴 매칭 성공 (${out.length}자)`);
    return out;
  }

  private static postProcess(s: string, maxLen: number): string {
    const t = (s || '')
      .replace(/\r/g, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    // 너무 길면 앞부분 우선(소개는 앞이 핵심)
    return t.length > maxLen ? t.slice(0, maxLen).trim() : t;
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
