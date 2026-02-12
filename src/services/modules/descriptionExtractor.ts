import { Page, Frame } from 'playwright';

export class DescriptionExtractor {
  static async extract(
    page: Page,
    frame?: Frame | null
  ): Promise<{ description: string; logs: string[] }> {
    const logs: string[] = [];

    try {
      logs.push('[상세설명] 추출 시작');

      // 1) iframe 우선
      if (frame) {
        logs.push('[상세설명] iframe에서 우선 추출 시도');
        const fromFrame = await this.extractFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame) return { description: fromFrame, logs };
      } else {
        logs.push('[상세설명] frame 없음 → iframe 추출 스킵');
      }

      // 2) page fallback
      logs.push('[상세설명] page에서 fallback 추출 시도');
      const fromPage = await this.extractFromHtml(await page.content(), logs, 'page');
      if (fromPage) return { description: fromPage, logs };

      logs.push('[상세설명] 추출 실패');
      return { description: '', logs };
    } catch (error: any) {
      logs.push(`[상세설명] 오류: ${error?.message || String(error)}`);
      return { description: '', logs };
    }
  }

  private static async extractFromHtml(html: string, logs: string[], label: string): Promise<string> {
    logs.push(`[상세설명] ${label} HTML 길이: ${html.length}`);

    // JSON/스크립트에 박힌 설명 후보들
    const patterns = [
      /"description"\s*:\s*"([^"]{10,1000})"/,
      /"intro"\s*:\s*"([^"]{10,1000})"/,
      /"businessSummary"\s*:\s*"([^"]{10,2000})"/,
      /"placeDescription"\s*:\s*"([^"]{10,2000})"/
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (m?.[1]) {
        const text = this.clean(m[1]);
        if (text.length >= 10) {
          logs.push(`[상세설명] ${label}에서 패턴 매칭 성공 (${text.length}자)`);
          return text;
        }
      }
    }

    logs.push(`[상세설명] ${label} 패턴 매칭 실패`);
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
