import { Page, Frame } from 'playwright';

export class DirectionsExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{ directions: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[오시는길] 추출 시작');

      // 1) iframe 우선
      if (frame) {
        logs.push('[오시는길] iframe에서 우선 추출 시도');
        const fromFrame = await this.extractFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame) return { directions: fromFrame, logs };
      } else {
        logs.push('[오시는길] frame 없음 → iframe 추출 스킵');
      }

      // 2) page fallback
      logs.push('[오시는길] page에서 fallback 추출 시도');
      const fromPage = await this.extractFromHtml(await page.content(), logs, 'page');
      if (fromPage) return { directions: fromPage, logs };

      logs.push('[오시는길] 추출 실패');
      return { directions: '', logs };
    } catch (error: any) {
      logs.push(`[오시는길] 오류: ${error?.message || String(error)}`);
      return { directions: '', logs };
    }
  }

  private static async extractFromHtml(html: string, logs: string[], label: string): Promise<string> {
    logs.push(`[오시는길] ${label} HTML 길이: ${html.length}`);

    const patterns = [
      /"directions"\s*:\s*"([^"]{10,2000})"/,
      /"wayToCome"\s*:\s*"([^"]{10,2000})"/,
      /"route"\s*:\s*"([^"]{10,2000})"/,
      /"transport"\s*:\s*"([^"]{10,2000})"/
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) {
        const text = this.clean(m[1]);
        if (text.length >= 10) {
          logs.push(`[오시는길] ${label}에서 패턴 매칭 성공 (${text.length}자)`);
          return text;
        }
      }
    }

    logs.push(`[오시는길] ${label} 패턴 매칭 실패`);
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
