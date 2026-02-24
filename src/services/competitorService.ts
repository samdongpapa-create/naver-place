// src/services/competitorService.ts
import { chromium, type Browser, type Page } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
};

type Competitor = {
  placeId: string;
  name: string;
  keywords: string[];
  source: "search_html" | "place_home";
  rank: number;
};

export class CompetitorService {
  private browser: Browser | null = null;

  private async getBrowser() {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    return this.browser;
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
  }

  /**
   * ✅ (옵션) m.map TOP 노출 순서 placeId 추출 (playwright)
   * - 지금은 search_html 방식 쓰지만, 나중에 "지도 TOP5 동일" 고도화할 때 유용
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
      viewport: { width: 390, height: 844 },
      locale: "ko-KR"
    });

    const page = await context.newPage();

    await page.route("**/*", (route) => {
      const req = route.request();
      const rtype = req.resourceType();
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") {
        return route.continue();
      }
      return route.abort();
    });

    page.setDefaultTimeout(Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const ids = await this.waitAndExtractPlaceIdsFromMapPage(page, 8000);

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

  private async waitAndExtractPlaceIdsFromMapPage(page: Page, maxWaitMs: number) {
    const started = Date.now();
    let html = "";

    while (Date.now() - started < maxWaitMs) {
      html = await page.content();

      const ids1 = [...html.matchAll(/\/place\/(\d{5,12})/g)].map((m) => m[1]);
      const ids2 = [...html.matchAll(/placeId[=:"']+(\d{5,12})/g)].map((m) => m[1]);

      const merged = this.mergeByFirstAppearance(html, [...ids1, ...ids2]);
      if (merged.length >= 5) return merged;

      await page.waitForTimeout(250);
    }

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
    uniq.sort((a, b) => html.indexOf(a) - html.indexOf(b));
    return uniq;
  }

  // ==========================
  // ✅ 핵심: where=place 검색 HTML 1회 + (필요시) place home 1회 보강
  // ==========================
  public async findTopCompetitorsByKeyword(
    keyword: string,
    opts: { excludePlaceId?: string; limit?: number; timeoutMs?: number } = {}
  ): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = String(opts.excludePlaceId || "").trim();
    const timeoutMs = Math.max(1500, Math.min(20000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 9000)));

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const placeIds = this.__extractPlaceIdsInOrder(html);

    const out: Competitor[] = [];
    const seen = new Set<string>();

    for (const pid of placeIds) {
      if (!pid) continue;
      if (exclude && pid === exclude) continue;
      if (seen.has(pid)) continue;

      const block = this.__sliceAround(html, pid, 14000);
      let name = this.__extractNameFromBlock(block) || "";
      let keywords = this.__extractKeywordListFromBlock(block).slice(0, 5);

      // ✅ 1차에서 keywordList 못 잡거나, "브랜드명만" 있는 경우 -> place home에서 보강
      if (this.__needKeywordEnrich(keywords, name)) {
        try {
          const enriched = await this.__fetchPlaceHomeAndExtract(pid, Math.min(6000, timeoutMs));
          if (enriched.name && !name) name = enriched.name;
          if (enriched.keywords?.length) keywords = enriched.keywords.slice(0, 5);

          out.push({
            placeId: pid,
            name: this.__cleanText(name),
            keywords: keywords.map((k) => this.__cleanText(k)).filter(Boolean).slice(0, 5),
            source: "place_home",
            rank: out.length + 1
          });
        } catch {
          out.push({
            placeId: pid,
            name: this.__cleanText(name),
            keywords: keywords.map((k) => this.__cleanText(k)).filter(Boolean).slice(0, 5),
            source: "search_html",
            rank: out.length + 1
          });
        }
      } else {
        out.push({
          placeId: pid,
          name: this.__cleanText(name),
          keywords: keywords.map((k) => this.__cleanText(k)).filter(Boolean).slice(0, 5),
          source: "search_html",
          rank: out.length + 1
        });
      }

      seen.add(pid);
      if (out.length >= limit) break;
    }

    // ✅ 마지막 안전장치: keywords 비면 name이라도 넣지 말고 빈 배열 유지 (브랜드명=키워드 같은 오염 방지)
    return out.map((c) => ({
      ...c,
      keywords: Array.isArray(c.keywords) ? c.keywords.filter((k) => k && k.length >= 2).slice(0, 5) : []
    }));
  }

  // ==========================
  // private utils
  // ==========================

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
        redirect: "follow",
        signal: ctrl.signal
      });

      if (!res.ok) throw new Error(`fetch status=${res.status}`);
      return (await res.text()) || "";
    } finally {
      clearTimeout(t);
    }
  }

  private __extractPlaceIdsInOrder(html: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const m of html.matchAll(/\/place\/(\d{5,12})/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 60) break;
    }

    if (ids.length < 10) {
      for (const m of html.matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 60) break;
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

  // ✅ 대표키워드 배열 패턴만 “강하게” 파싱 (텍스트 주워오기 fallback은 오염 위험이라 제거/축소)
  private __extractKeywordListFromBlock(block: string): string[] {
    const patterns = [
      /"keywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywords"\s*:\s*\[(.*?)\]/s,
      /"keywords"\s*:\s*\[(.*?)\]/s
    ];

    for (const p of patterns) {
      const m = block.match(p);
      if (!m?.[1]) continue;
      const arr = this.__parseStringArrayLoose(m[1]);
      if (arr.length) return arr;
    }

    // ✅ fallback(약하게): "대표키워드"처럼 보이는 짧은 토큰만
    // (브랜드명/네이버 같은 오염 방지)
    const cand = [...block.matchAll(/>([^<>]{2,25})</g)]
      .map((x) => this.__cleanText(x[1]))
      .filter(Boolean);

    const filtered = cand.filter((s) => /(역|동|구|미용실|카페|맛집|헤어|살롱|클리닉)/.test(s));
    // 너무 적으면 그냥 빈 배열로 둔다 (오염 방지)
    return filtered.slice(0, 5);
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

  // ✅ 키워드가 “브랜드명 1개”거나, 지역/업종 시그널이 아예 없으면 보강 필요
  private __needKeywordEnrich(keywords: string[], name: string) {
    const ks = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (ks.length >= 3) return false;
    if (ks.length === 0) return true;

    const nm = this.__cleanText(name).replace(/\s+/g, "");
    const allBrandLike = ks.every((k) => {
      const kk = this.__cleanText(k).replace(/\s+/g, "");
      if (!kk) return true;
      if (nm && (kk === nm || nm.includes(kk) || kk.includes(nm))) return true;
      if (/(네이버|플레이스|예약|문의|할인|이벤트)/.test(kk)) return true;
      // 지역/업종/서비스 신호가 전혀 없으면 브랜드로 간주
      const hasSignal = /(역|동|구|미용실|카페|맛집|헤어|살롱|클리닉|펌|염색|커트|컷)/.test(kk);
      return !hasSignal;
    });

    return allBrandLike;
  }

  // ✅ placeId의 모바일 플레이스 home을 fetch해서 대표키워드 파싱
  private async __fetchPlaceHomeAndExtract(placeId: string, timeoutMs: number): Promise<{ name: string; keywords: string[] }> {
    // /place/{id}/home 는 업종별로 리다이렉트됨 (hairshop/restaurant 등)
    const url = `https://m.place.naver.com/place/${placeId}/home`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const name = this.__extractNameFromPlaceHome(html);
    const keywords = this.__extractKeywordsFromPlaceHome(html);

    return { name, keywords };
  }

  private __extractNameFromPlaceHome(html: string): string {
    // og:title이 제일 안정적
    const m1 = html.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
    if (m1?.[1]) return this.__cleanText(m1[1]);

    // title tag fallback
    const m2 = html.match(/<title>\s*([^<]{2,80})\s*<\/title>/i);
    if (m2?.[1]) return this.__cleanText(m2[1]).replace(/\s*:\s*네이버.*$/i, "");

    return "";
  }

  private __extractKeywordsFromPlaceHome(html: string): string[] {
    const patterns = [
      /"keywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywordList"\s*:\s*\[(.*?)\]/s,
      /"representKeywords"\s*:\s*\[(.*?)\]/s,
      /"keywords"\s*:\s*\[(.*?)\]/s
    ];

    for (const p of patterns) {
      const m = html.match(p);
      if (!m?.[1]) continue;
      const arr = this.__parseStringArrayLoose(m[1]);
      if (arr.length) return arr.slice(0, 5);
    }

    return [];
  }
}
