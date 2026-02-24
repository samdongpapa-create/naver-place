// src/services/competitorService.ts
import { chromium, type Browser, type Page } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
};

export class CompetitorService {
  private browser: Browser | null = null;

  private async getBrowser() {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu"
      ]
    });
    return this.browser;
  }

  // ✅ 서버에서 확실히 정리하려면 close() 제공하는게 좋아
  async close() {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
  }

  /**
   * ✅ (정답) 키워드로 네이버 지도(m.map) 검색 결과 "노출 순서" 그대로 placeId TOP N 추출
   * - 개인화/광고 등 100% 동일 보장은 아니지만, 지금 니가 원하는 TOP5에 가장 근접
   */
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = String(opts.excludePlaceId || "").trim();

    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 390, height: 844 }, // 모바일 느낌
      locale: "ko-KR"
    });

    const page = await context.newPage();

    // ✅ 속도/타임아웃 개선: 불필요 리소스 차단
    await page.route("**/*", (route) => {
      const req = route.request();
      const rtype = req.resourceType();
      // 문서/스크립트/xhr만 통과
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") {
        return route.continue();
      }
      return route.abort();
    });

    page.setDefaultTimeout(Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    try {
      // ✅ commit 말고 domcontentloaded로 바꾸면 훨씬 덜 걸림
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // ✅ 결과가 늦게 뜨는 경우가 있어서 HTML에서 placeId가 잡힐 때까지 짧게 폴링
      const ids = await this.waitAndExtractPlaceIdsFromMapPage(page, 8000);

      // exclude 제거 + 중복 제거 + limit
      const out: string[] = [];
      const seen = new Set<string>();

      for (const id of ids) {
        if (!id) continue;
        if (exclude && id === exclude) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= limit) break;
      }

      return out;
    } finally {
      try {
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  /**
   * ✅ m.map 검색 페이지 HTML/DOM에서 placeId 추출 (노출 순서 유지)
   * - m.map은 내부 구조가 바뀔 수 있어, "여러 패턴"을 동시에 탐색
   */
  private async waitAndExtractPlaceIdsFromMapPage(page: Page, maxWaitMs: number) {
    const started = Date.now();
    let html = "";

    while (Date.now() - started < maxWaitMs) {
      html = await page.content();

      // 패턴1) /place/{id}
      const ids1 = [...html.matchAll(/\/place\/(\d{5,12})/g)].map((m) => m[1]);

      // 패턴2) placeId=12345
      const ids2 = [...html.matchAll(/placeId[=:"']+(\d{5,12})/g)].map((m) => m[1]);

      // 합치되, "노출 순서" 느낌을 위해 html에서 먼저 등장한 순서를 최대한 유지
      const merged = this.mergeByFirstAppearance(html, [...ids1, ...ids2]);

      // 최소 5~10개 정도 잡히면 성공으로 보고 반환
      if (merged.length >= 5) return merged;

      await page.waitForTimeout(250);
    }

    // 타임아웃이어도 일단 잡힌 건 반환
    const ids1 = [...html.matchAll(/\/place\/(\d{5,12})/g)].map((m) => m[1]);
    const ids2 = [...html.matchAll(/placeId[=:"']+(\d{5,12})/g)].map((m) => m[1]);
    return this.mergeByFirstAppearance(html, [...ids1, ...ids2]);
  }

  private mergeByFirstAppearance(html: string, ids: string[]) {
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const id of ids) {
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(id);
    }
    // "처음 등장 위치" 기준 정렬(노출 순서에 근접)
    uniq.sort((a, b) => html.indexOf(a) - html.indexOf(b));
    return uniq;
  }

  // ==========================
  // ✅ 기존 findTopPlaceIds()는 "지도 TOP5"를 우선으로 하도록 바꿔라
  // ==========================
  async findTopPlaceIds(keyword: string, excludePlaceId?: string, limit = 5): Promise<string[]> {
    // 1) 지도 노출 순서 TOP5 시도
    try {
      const ids = await this.findTopPlaceIdsFromMapRank(keyword, { excludePlaceId, limit });
      if (ids?.length) return ids;
    } catch (e) {
      // ignore
    }

    // 2) (기존 방식) search.naver.com fallback 있으면 여기서 실행
    // return await this.findPlaceIdsFromSearchHtml(keyword, excludePlaceId, limit);

    return [];
  }
  // ✅ (2번 방식) 네이버 where=place 검색 HTML 1회 fetch로
// "노출 TOP + 대표키워드(카드에 보이는)"만 뽑는다
public async findTopCompetitorsByKeyword(
  keyword: string,
  opts: { excludePlaceId?: string; limit?: number; timeoutMs?: number } = {}
): Promise<Array<{ placeId: string; name: string; keywords: string[]; source: "search_html"; rank: number }>> {
  const q = String(keyword || "").trim();
  if (!q) return [];

  const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
  const exclude = String(opts.excludePlaceId || "").trim();
  const timeoutMs = Math.max(1500, Math.min(15000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 9000)));

  const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

  const html = await this.__fetchHtml(url, timeoutMs);

  const placeIds = this.__extractPlaceIdsInOrder(html);

  const out: Array<{ placeId: string; name: string; keywords: string[]; source: "search_html"; rank: number }> = [];
  const seen = new Set<string>();

  for (const pid of placeIds) {
    if (!pid) continue;
    if (exclude && pid === exclude) continue;
    if (seen.has(pid)) continue;

    const block = this.__sliceAround(html, pid, 12000);
    const name = this.__extractNameFromBlock(block) || "";
    const keywords = this.__extractKeywordListFromBlock(block).slice(0, 5);

    seen.add(pid);
    out.push({
      placeId: pid,
      name: this.__cleanText(name),
      keywords: keywords.map((k) => this.__cleanText(k)).filter(Boolean),
      source: "search_html",
      rank: out.length + 1
    });

    if (out.length >= limit) break;
  }

  return out;
}

/** ============ 아래는 위 메서드 전용 private 유틸들 (클래스 내부에 함께 추가) ============ */

private async __fetchHtml(url: string, timeoutMs: number): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        Accept: "text/html,application/xhtml+xml"
      },
      signal: ctrl.signal
    });

    if (!res.ok) throw new Error(`searchHTML status=${res.status}`);
    return (await res.text()) || "";
  } finally {
    clearTimeout(t);
  }
}

private __extractPlaceIdsInOrder(html: string): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();

  // /place/123456789
  for (const m of html.matchAll(/\/place\/(\d{5,12})/g)) {
    const id = m[1];
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    if (ids.length >= 50) break;
  }

  // placeId":"123456789 (보강)
  if (ids.length < 10) {
    for (const m of html.matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 50) break;
    }
  }

  return ids;
}

private __sliceAround(html: string, token: string, windowSize: number) {
  const idx = html.indexOf(token);
  if (idx < 0) return html.slice(0, Math.min(html.length, windowSize));
  const start = Math.max(0, idx - Math.floor(windowSize / 2));
  const end = Math.min(html.length, idx + Math.floor(windowSize / 2));
  return html.slice(start, end);
}

private __extractKeywordListFromBlock(block: string): string[] {
  // keywordList: ["...","..."]
  const m1 = block.match(/keywordList["']?\s*:\s*\[([^\]]{1,2000})\]/);
  if (m1?.[1]) {
    const arr = this.__parseStringArrayLoose(m1[1]);
    if (arr.length) return arr;
  }

  // fallback: 텍스트 후보
  const cand = [...block.matchAll(/>([^<>]{2,25})</g)]
    .map((x) => this.__cleanText(x[1]))
    .filter((s) => s && !s.includes("네이버") && !s.includes("더보기"));

  const filtered = cand.filter((s) => /(역|동|구|미용실|카페|맛집|헤어|살롱|클리닉|필라테스|학원|부동산|병원)/.test(s));
  return filtered.slice(0, 8);
}

private __extractNameFromBlock(block: string): string {
  const m1 = block.match(/title["']?\s*:\s*["']([^"']{2,60})["']/);
  if (m1?.[1]) return m1[1];

  const m2 = block.match(/name["']?\s*:\s*["']([^"']{2,60})["']/);
  if (m2?.[1]) return m2[1];

  const m3 = block.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
  if (m3?.[1]) return m3[1];

  const m4 = block.match(/([가-힣A-Za-z0-9\s]{2,40})\s*:\s*네이버/);
  if (m4?.[1]) return m4[1].trim();

  return "";
}

private __parseStringArrayLoose(inner: string): string[] {
  const out: string[] = [];
  for (const m of inner.matchAll(/["']([^"']{1,40})["']/g)) {
    const v = this.__cleanText(m[1]);
    if (!v) continue;
    out.push(v);
  }
  return Array.from(new Set(out));
}

private __cleanText(s: string) {
  return String(s || "")
    .replace(/\\u003c/g, "<")
    .replace(/\\u003e/g, ">")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .replace(/[^\w가-힣\s\-·]/g, "")
    .trim();
}
}
