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
}
