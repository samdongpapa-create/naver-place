import { Page, Frame } from 'playwright';

export class KeywordExtractor {
  /**
   * 대표키워드 추출
   * - iframe(entryIframe) 안에 있는 경우가 많아서 frame 우선 탐색
   * - 없으면 page.content()로 fallback
   */
  static async extract(page: Page, frame?: Frame | null): Promise<{ keywords: string[]; logs: string[] }> {
    const logs: string[] = [];
    try {
      logs.push('[키워드] 추출 시작');

      // 1) iframe 우선
      if (frame) {
        logs.push('[키워드] iframe에서 우선 추출 시도');
        const fromFrame = await this.extractFromHtml(await frame.content(), logs, 'iframe');
        if (fromFrame.length) return { keywords: fromFrame, logs };
      } else {
        logs.push('[키워드] frame이 없어 iframe 추출 스킵');
      }

      // 2) page fallback
      logs.push('[키워드] page에서 fallback 추출 시도');
      const fromPage = await this.extractFromHtml(await page.content(), logs, 'page');
      if (fromPage.length) return { keywords: fromPage, logs };

      logs.push('[키워드] 추출 실패 (키워드 없음/형식 변경)');
      return { keywords: [], logs };
    } catch (error: any) {
      logs.push(`[키워드] 오류: ${error?.message || String(error)}`);
      return { keywords: [], logs };
    }
  }

  private static async extractFromHtml(html: string, logs: string[], label: string): Promise<string[]> {
    logs.push(`[키워드] ${label} HTML 길이: ${html.length}`);

    // ✅ 대표키워드가 들어갈 수 있는 후보 패턴들
    const patterns = [
      /"keywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywords"\s*:\s*\[(.*?)\]/s,
      /"keywords"\s*:\s*\[(.*?)\]/s
    ];

    for (const pattern of patterns) {
      const m = html.match(pattern);
      if (!m?.[1]) continue;

      logs.push(`[키워드] ${label}에서 키워드 배열 패턴 발견`);
      const body = m[1];

      // 1) 객체 배열 형태: {"text":"..."} 또는 {"name":"..."}
      const textMatches = body.match(/"text"\s*:\s*"([^"]+)"/g) || [];
      const nameMatches = body.match(/"name"\s*:\s*"([^"]+)"/g) || [];

      const extracted1 = textMatches
        .map(s => s.match(/"text"\s*:\s*"([^"]+)"/)?.[1] || '')
        .filter(Boolean);

      const extracted2 = nameMatches
        .map(s => s.match(/"name"\s*:\s*"([^"]+)"/)?.[1] || '')
        .filter(Boolean);

      const merged = [...extracted1, ...extracted2]
        .map(x => x.trim())
        .filter(x => x.length > 0);

      if (merged.length) {
        const top5 = Array.from(new Set(merged)).slice(0, 5);
        logs.push(`[키워드] ${label} 추출 성공: ${top5.join(', ')}`);
        return top5;
      }

      // 2) 문자열 배열 형태: "키워드1","키워드2"
      const stringArr = body
        .split(',')
        .map(x => x.replace(/[\[\]"]/g, '').trim())
        .filter(x => x.length > 0);

      if (stringArr.length) {
        const top5 = Array.from(new Set(stringArr)).slice(0, 5);
        logs.push(`[키워드] ${label} 추출 성공(문자열배열): ${top5.join(', ')}`);
        return top5;
      }
    }

    logs.push(`[키워드] ${label}에서 키워드 패턴 미발견`);
    return [];
  }
}
