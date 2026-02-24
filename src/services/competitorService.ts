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
   * (옵션) 지도 TOP5 고도화용
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
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") return route.continue();
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
    const timeoutMs = Math.max(
      1500,
      Math.min(20000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 9000))
    );

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const placeIds = this.__extractPlaceIdsInOrder(html);

    const out: Competitor[] = [];
    const seen = new Set<string>();

    for (const pid of placeIds) {
      if (!pid) continue;
      if (exclude && pid === exclude) continue;
      if (seen.has(pid)) continue;

      // ✅ search HTML에서는 "대표키워드"를 정적 텍스트로 주워오지 않는다(오염 방지)
      // 대신 __NEXT_DATA__에서만 추출 시도
      const searchNext = this.__parseNextData(html);
      let name = this.__findNameForPlaceId(searchNext, pid) || "";
      let keywords = this.__findKeywordsForPlaceId(searchNext, pid).slice(0, 5);

      // ✅ 부족하면 place home에서 __NEXT_DATA__로 보강
      if (this.__needKeywordEnrich(keywords, name)) {
        const enriched = await this.__fetchPlaceHomeAndExtract(pid, Math.min(7000, timeoutMs));
        if (enriched.name && !name) name = enriched.name;
        if (enriched.keywords?.length) keywords = enriched.keywords.slice(0, 5);

        out.push({
          placeId: pid,
          name: this.__cleanText(name),
          keywords: keywords.map((k) => this.__cleanText(k)).filter(Boolean).slice(0, 5),
          source: "place_home",
          rank: out.length + 1
        });
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

    // ✅ 오염 방지: 키워드가 '네이버/예약/문의/할인'류면 제거
    return out.map((c) => ({
      ...c,
      keywords: (c.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter((k) => k && k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5)
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
          Accept: "text/html,application/xhtml+xml",
          Referer: "https://search.naver.com/"
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
      if (ids.length >= 80) break;
    }

    if (ids.length < 10) {
      for (const m of html.matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 80) break;
      }
    }

    return ids;
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

  // ✅ 키워드가 아예 없거나, 브랜드명만 있으면 보강 필요
  private __needKeywordEnrich(keywords: string[], name: string) {
    const ks = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (ks.length >= 3) return false;
    if (ks.length === 0) return true;

    const nm = this.__cleanText(name).replace(/\s+/g, "");
    const allBrandLike = ks.every((k) => {
      const kk = this.__cleanText(k).replace(/\s+/g, "");
      if (!kk) return true;
      if (nm && (kk === nm || nm.includes(kk) || kk.includes(nm))) return true;
      if (/(네이버|플레이스|예약|문의|할인|이벤트|가격)/.test(kk)) return true;
      // 지역/업종/서비스 신호가 하나도 없으면 브랜드로 간주
      const hasSignal = /(역|동|구|미용실|카페|맛집|헤어|살롱|클리닉|펌|염색|커트|컷)/.test(kk);
      return !hasSignal;
    });

    return allBrandLike;
  }

  // ==========================
  // ✅ __NEXT_DATA__ 파싱 + 딥서치
  // ==========================
  private __parseNextData(html: string): any | null {
    const m = html.match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m?.[1]) return null;
    try {
      return JSON.parse(m[1]);
    } catch {
      return null;
    }
  }

  private __deepCollect(obj: any, predicate: (x: any) => boolean, out: any[] = []) {
    if (!obj || typeof obj !== "object") return out;
    if (predicate(obj)) out.push(obj);
    if (Array.isArray(obj)) {
      for (const it of obj) this.__deepCollect(it, predicate, out);
      return out;
    }
    for (const k of Object.keys(obj)) this.__deepCollect(obj[k], predicate, out);
    return out;
  }

  private __deepFindStringArray(obj: any, keyName: string): string[] {
    const hits = this.__deepCollect(
      obj,
      (x) => x && typeof x === "object" && Array.isArray((x as any)[keyName]),
      []
    );

    for (const h of hits) {
      const arr = (h as any)[keyName];
      const strs = arr
        .map((v: any) => this.__cleanText(String(v ?? "")))
        .filter(Boolean);
      if (strs.length) return Array.from(new Set(strs));
    }
    return [];
  }

  private __deepFindName(obj: any): string {
    const keyCandidates = ["name", "placeName", "businessName", "title"];
    const hits = this.__deepCollect(
      obj,
      (x) => x && typeof x === "object" && keyCandidates.some((k) => typeof (x as any)[k] === "string"),
      []
    );

    for (const h of hits) {
      for (const k of keyCandidates) {
        const v = (h as any)[k];
        if (typeof v === "string") {
          const t = this.__cleanText(v);
          if (t && t.length >= 2 && t.length <= 60) return t;
        }
      }
    }
    return "";
  }

  // ✅ search next data에서 특정 placeId에 매칭되는 name/keywords를 최대한 찾는다
  private __findNameForPlaceId(next: any, placeId: string): string {
    if (!next) return "";
    const pid = String(placeId);

    const hits = this.__deepCollect(
      next,
      (x) =>
        x &&
        typeof x === "object" &&
        (String((x as any).id || (x as any).placeId || (x as any).businessId || "") === pid ||
          String((x as any).placeId || "") === pid),
      []
    );

    for (const h of hits) {
      const nm = this.__deepFindName(h);
      if (nm) return nm;
    }

    // 마지막 fallback: 전체에서 name 하나라도
    return "";
  }

  private __findKeywordsForPlaceId(next: any, placeId: string): string[] {
    if (!next) return [];
    const pid = String(placeId);

    const hits = this.__deepCollect(
      next,
      (x) =>
        x &&
        typeof x === "object" &&
        (String((x as any).id || (x as any).placeId || (x as any).businessId || "") === pid ||
          String((x as any).placeId || "") === pid),
      []
    );

    for (const h of hits) {
      const keys = ["keywordList", "representKeywordList", "representKeywords", "keywords"];
      for (const k of keys) {
        const arr = this.__deepFindStringArray(h, k);
        if (arr.length) return arr;
      }
    }

    return [];
  }

  // ==========================
  // ✅ place home fetch -> __NEXT_DATA__에서 대표키워드 추출
  // ==========================
  private async __fetchPlaceHomeAndExtract(placeId: string, timeoutMs: number): Promise<{ name: string; keywords: string[] }> {
    const url = `https://m.place.naver.com/place/${placeId}/home`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const next = this.__parseNextData(html);

    // name은 next에서 우선
    let name = this.__deepFindName(next) || "";

    // keywords도 next에서 우선
    const keys = ["keywordList", "representKeywordList", "representKeywords", "keywords"];
    let keywords: string[] = [];
    for (const k of keys) {
      keywords = this.__deepFindStringArray(next, k);
      if (keywords.length) break;
    }

    // og:title fallback
    if (!name) {
      const m1 = html.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
      if (m1?.[1]) name = this.__cleanText(m1[1]);
    }

    return { name, keywords: (keywords || []).slice(0, 5) };
  }
}
