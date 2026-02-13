// src/services/modules/nextDataParser.ts

export class NextDataParser {
  /**
   * HTML에서 __NEXT_DATA__ JSON을 파싱해서 객체로 반환
   */
  static extractNextData(html: string): { ok: boolean; data?: any; logs: string[] } {
    const logs: string[] = [];
    try {
      const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>(.*?)<\/script>/s);
      if (!m?.[1]) {
        logs.push('[NEXT] __NEXT_DATA__ 스크립트를 찾지 못했습니다.');
        return { ok: false, logs };
      }

      const jsonText = m[1].trim();
      logs.push(`[NEXT] __NEXT_DATA__ 길이: ${jsonText.length}`);

      const data = JSON.parse(jsonText);
      logs.push('[NEXT] __NEXT_DATA__ JSON 파싱 성공');

      return { ok: true, data, logs };
    } catch (e: any) {
      logs.push(`[NEXT] 파싱 오류: ${e?.message || String(e)}`);
      return { ok: false, logs };
    }
  }

  /**
   * __NEXT_DATA__ 안에서 필요한 값들을 "키 이름 기반"으로 최대한 찾아내기
   * (네이버 내부 구조가 바뀌어도 어느 정도 버티는 방식)
   */
  static extractFields(nextData: any): {
    name?: string;
    address?: string;
    reviewCount?: number;
    photoCount?: number;
    keywords?: string[];
    description?: string;
    directions?: string;
    logs: string[];
  } {
    const logs: string[] = [];

    const root = nextData;

    const name = this.findFirstString(root, ['name', 'placeName', 'bizName'], logs, 'name');
    const address =
      this.findFirstString(root, ['roadAddress', 'address', 'addr', 'roadAddr'], logs, 'address');

    const reviewCount =
      this.findFirstNumber(root, ['visitorReviewCount', 'reviewCount'], logs, 'reviewCount');

    const photoCount =
      this.findFirstNumber(root, ['photoCount', 'imageCount'], logs, 'photoCount');

    const description =
      this.findFirstString(root, ['description', 'placeDescription', 'intro', 'businessSummary'], logs, 'description');

    const directions =
      this.findFirstString(root, ['wayToCome', 'directions', 'route', 'transport'], logs, 'directions');

    const keywords =
      this.findKeywordArray(root, logs);

    return { name, address, reviewCount, photoCount, keywords, description, directions, logs };
  }

  private static findFirstString(obj: any, keys: string[], logs: string[], label: string): string | undefined {
    const val = this.deepFind(obj, (k, v) => keys.includes(k) && typeof v === 'string' && v.trim().length > 0);
    if (typeof val === 'string') {
      logs.push(`[NEXT] ${label} 발견: ${val.slice(0, 60)}${val.length > 60 ? '...' : ''}`);
      return this.clean(val);
    }
    logs.push(`[NEXT] ${label} 미발견`);
    return undefined;
  }

  private static findFirstNumber(obj: any, keys: string[], logs: string[], label: string): number | undefined {
    const val = this.deepFind(obj, (k, v) => keys.includes(k) && (typeof v === 'number' || (typeof v === 'string' && /^[0-9,]+$/.test(v))));
    if (typeof val === 'number') {
      logs.push(`[NEXT] ${label} 발견: ${val}`);
      return val;
    }
    if (typeof val === 'string') {
      const n = parseInt(val.replace(/,/g, ''), 10);
      if (!Number.isNaN(n)) {
        logs.push(`[NEXT] ${label} 발견(문자열): ${n}`);
        return n;
      }
    }
    logs.push(`[NEXT] ${label} 미발견`);
    return undefined;
  }

  private static findKeywordArray(obj: any, logs: string[]): string[] | undefined {
    // 대표키워드 후보 키
    const candidates = ['representKeywordList', 'keywordList', 'keywords', 'representKeywords'];

    const found = this.deepFind(obj, (k, v) => candidates.includes(k) && Array.isArray(v) && v.length > 0);
    if (!found || !Array.isArray(found)) {
      logs.push('[NEXT] keywords 배열 미발견');
      return undefined;
    }

    // 배열 원소가 string이거나, {text/name} 같은 객체일 수도 있음
    const list = found
      .map((x: any) => {
        if (typeof x === 'string') return x;
        if (x && typeof x === 'object') return x.text || x.name || '';
        return '';
      })
      .map((s: string) => this.clean(String(s)))
      .filter((s: string) => s.length > 0);

    const top5 = Array.from(new Set(list)).slice(0, 5);
    logs.push(`[NEXT] keywords 발견: ${top5.join(', ')}`);
    return top5.length ? top5 : undefined;
  }

  /**
   * 어떤 객체든 깊게 들어가며 조건을 만족하는 value 하나를 찾아 반환
   */
  private static deepFind(obj: any, predicate: (key: string, value: any) => boolean): any {
    const seen = new Set<any>();

    const walk = (node: any): any => {
      if (!node || typeof node !== 'object') return undefined;
      if (seen.has(node)) return undefined;
      seen.add(node);

      if (Array.isArray(node)) {
        for (const item of node) {
          const r = walk(item);
          if (r !== undefined) return r;
        }
        return undefined;
      }

      for (const [k, v] of Object.entries(node)) {
        try {
          if (predicate(k, v)) return v;
        } catch {}
        const r = walk(v);
        if (r !== undefined) return r;
      }
      return undefined;
    };

    return walk(obj);
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
