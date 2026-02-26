// src/services/competitorService.ts
import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number; // ✅ map rank 단계 예산
};

type Competitor = {
  placeId: string;
  name: string;
  keywords: string[];
  source: "map_rank" | "search_html" | "place_home";
  rank: number;
};

type FindTopCompetitorsOpts = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number; // 전체 예산(상한)
};

type PlaceMeta = { placeId: string; name: string };

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

  // ==========================
  // ✅ UA / Referer
  // ==========================
  private __pickRandomUA() {
    const pool = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private __buildMapReferer(query: string) {
    const q = encodeURIComponent(query);
    return `https://map.naver.com/p/search/${q}?c=15.00,0,0,0,dh`;
  }

  private __nowMs() {
    return Date.now();
  }

  private __deadlineMs(totalTimeoutMs: number) {
    return this.__nowMs() + Math.max(1000, totalTimeoutMs) - 350;
  }

  private __remaining(deadline: number, min = 1) {
    return Math.max(min, deadline - this.__nowMs());
  }

  // ==========================
  // ✅ PlaceId util
  // ==========================
  private __normPlaceId(pid: string) {
    return String(pid || "").trim();
  }

  private __isValidPlaceId(pid: string) {
    const s = this.__normPlaceId(pid);
    return /^\d{7,12}$/.test(s);
  }

  // ==========================
  // ✅ Text util
  // ==========================
  private __cleanText(s: string) {
    return String(s || "")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/&quot;|&#34;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .replace(/[^\w가-힣\s\-·#]/g, "")
      .trim();
  }

  private __cleanName(s: string) {
    // "더살롱아베다 네이버" 같은 꼬리 제거
    let t = this.__cleanText(s);
    t = t.replace(/\s*네이버\s*플레이스\s*$/i, "").trim();
    t = t.replace(/\s*네이버\s*$/i, "").trim();
    // " - 네이버 플레이스" 형태
    t = t.replace(/\s*-\s*네이버\s*플레이스\s*$/i, "").trim();
    return t;
  }

  private __isBannedName(name: string) {
    const n = this.__cleanText(name);
    if (!n) return true;

    if (/^(광고|저장|길찾기|예약|전화|공유|블로그|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(n)) return true;
    if (/^네이버\s*플레이스$/i.test(n)) return true;
    if (/네이버\s*플레이스/i.test(n) && n.length <= 12) return true;

    if (/^방문\s*리뷰\s*\d+/i.test(n)) return true;
    if (/^블로그\s*리뷰\s*\d+/i.test(n)) return true;
    if (/리뷰\s*\d+/i.test(n) && n.length <= 15) return true;

    if (/^\d+(\.\d+)?\s*(m|km)$/i.test(n)) return true;
    if (/^\d+\s*분$/.test(n)) return true;

    return false;
  }

  // ==========================
  // ✅ keyword noise filter (강화)
  // ==========================
  private __normalizeKeyword(s: string) {
    return this.__cleanText(String(s || "")).replace(/^#/, "").replace(/\s+/g, " ").trim();
  }

  private __isNoiseKeyword(raw: string) {
    const k = this.__normalizeKeyword(raw);
    if (!k) return true;

    if (k.length < 2) return true;
    if (k.length > 25) return true;

    // 숫자/카운트/거리/시간
    if (/^\d+$/.test(k)) return true;
    if (/^\d+(\.\d+)?\s*(m|km|분|초|개|건|명|원|회|%)$/i.test(k)) return true;
    if (/^(사진|동영상|리뷰|블로그)\s*\d+\s*(개|건)?$/i.test(k)) return true;

    // UI/탭
    if (/^(홈|정보|리뷰|사진|동영상|메뉴|가격|예약|전화|길찾기|지도|공유|저장|더보기|펼치기|전체보기|자세히)$/i.test(k))
      return true;

    // 페이지/업데이트/공지 류
    if (/(이전\s*페이지|다음\s*페이지|페이지|공지|업데이트|수정|신고|제보)/i.test(k)) return true;

    // 네이버/프로모션
    if (/(네이버|플레이스|스마트플레이스|N예약|N페이)/i.test(k)) return true;
    if (/(예약|문의|할인|이벤트|가격|베스트|추천|쿠폰|증정|특가)/i.test(k)) return true;

    // 대표키워드없음
    if (/(대표\s*키워드\s*없음|키워드\s*없음)/i.test(k)) return true;

    return false;
  }

  // ==========================
  // ✅ env: searchCoord 정규화 (allSearch 필수)
  // ==========================
  private __normalizeSearchCoord(): string {
    const raw = String(process.env.NAVER_MAP_SEARCH_COORD || "").trim();
    const fallback = "126.9780;37.5665"; // lng;lat (서울)

    if (!raw) return fallback;

    const cleaned = raw.replace(/\s+/g, "");
    const parsePair = (a: string, b: string) => {
      const n1 = Number(a);
      const n2 = Number(b);
      if (!Number.isFinite(n1) || !Number.isFinite(n2)) return fallback;

      const looksLngLat = Math.abs(n1) > Math.abs(n2);
      return looksLngLat ? `${n1};${n2}` : `${n2};${n1}`;
    };

    if (/^-?\d+(\.\d+)?;-?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(";");
      return parsePair(a, b);
    }
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(",");
      return parsePair(a, b);
    }

    return fallback;
  }

  private __coordToXY(searchCoord: string) {
    const fallback = { x: "126.9780", y: "37.5665" };
    const s = String(searchCoord || "").trim();
    const m = s.match(/(-?\d+(\.\d+)?);(-?\d+(\.\d+)?)/);
    if (!m) return fallback;
    const x = String(Number(m[1]));
    const y = String(Number(m[3]));
    if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) return fallback;
    return { x, y };
  }

  // ==========================
  // ✅ Context/Page
  // ==========================
  private async __newContext(baseReferer: string): Promise<BrowserContext> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent: this.__pickRandomUA(),
      viewport: { width: 390, height: 844 },
      locale: "ko-KR",
      extraHTTPHeaders: {
        "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
        referer: baseReferer
      }
    });

    await context.addInitScript(() => {
      try {
        const nav: any = (globalThis as any).navigator;
        if (nav) Object.defineProperty(nav, "webdriver", { get: () => undefined });
      } catch {}
    });

    return context;
  }

  private async __newLightPage(context: BrowserContext, timeoutMs: number): Promise<Page> {
    const page = await context.newPage();
    page.setDefaultTimeout(Math.max(1000, timeoutMs));

    await page.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (rt === "image" || rt === "font" || rt === "media") return route.abort();
      return route.continue();
    });

    return page;
  }

  // ==========================
  // ✅ JSON parse helper (XSSI 제거)
  // ==========================
  private __safeJsonParse(text: string): any | null {
    const s0 = String(text || "").trim();
    if (!s0) return null;

    const s = s0
      .replace(/^\)\]\}',?\s*\n?/, "")
      .replace(/^for\s*\(\s*;\s*;\s*\)\s*;?\s*/, "")
      .trim();

    if (!(s.startsWith("{") || s.startsWith("["))) return null;

    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }

  // ==========================
  // ✅ 0) allSearch JSON (map rank) - ⚠️ searchCoord required 고정
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const searchCoord = this.__normalizeSearchCoord();
    const { x, y } = this.__coordToXY(searchCoord);
    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "").trim();

    // ✅ searchCoord는 반드시 포함(Required). x/y는 "추가로" 붙여도 됨.
    const variants: Array<{ useBoundary: boolean; alsoXY: boolean }> = [
      { useBoundary: true, alsoXY: true },
      { useBoundary: true, alsoXY: false },
      { useBoundary: false, alsoXY: true },
      { useBoundary: false, alsoXY: false }
    ];

    const tryOnce = async (v: { useBoundary: boolean; alsoXY: boolean }, ms: number) => {
      const url = new URL("https://map.naver.com/p/api/search/allSearch");
      url.searchParams.set("query", q);

      // 안정화
      url.searchParams.set("type", "place");
      url.searchParams.set("page", "1");
      url.searchParams.set("displayCount", String(Math.max(5, Math.min(20, limit + 5))));
      url.searchParams.set("isPlaceSearch", "true");

      // ✅ Required
      url.searchParams.set("searchCoord", searchCoord);

      // ✅ Optional: 일부 환경에서 결과 안정화 되는 경우가 있어 추가
      if (v.alsoXY) {
        url.searchParams.set("x", x);
        url.searchParams.set("y", y);
      }

      if (v.useBoundary && boundary) url.searchParams.set("boundary", boundary);

      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), Math.max(1, ms));

      try {
        const res = await fetch(url.toString(), {
          method: "GET",
          headers: {
            accept: "application/json, text/plain, */*",
            "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
            "user-agent": this.__pickRandomUA(),
            referer: this.__buildMapReferer(q),
            origin: "https://map.naver.com"
          },
          redirect: "follow",
          signal: ctrl.signal
        });

        if (!res.ok) {
          const txt = await res.text().catch(() => "");
          throw new Error(
            `[allSearch:searchCoord${v.alsoXY ? "+xy" : ""}${v.useBoundary ? "+boundary" : ""}] status=${res.status} body=${txt.slice(0, 220)}`
          );
        }

        const data: any = await res.json().catch(() => null);

        const list: any[] =
          data?.result?.place?.list ||
          data?.result?.place?.items ||
          data?.result?.place?.results ||
          data?.result?.place ||
          data?.place?.list ||
          data?.place?.items ||
          [];

        const ids = (Array.isArray(list) ? list : [])
          .map((x2: any) => (x2?.id ? String(x2.id) : x2?.placeId ? String(x2.placeId) : x2?.bizId ? String(x2.bizId) : ""))
          .map((id: string) => this.__normPlaceId(id))
          .filter((id: string) => this.__isValidPlaceId(id));

        return Array.from(new Set(ids)).slice(0, limit);
      } finally {
        clearTimeout(t);
      }
    };

    const budget = Math.max(1800, Math.min(5200, timeoutMs));
    const step = Math.max(650, Math.floor(budget / variants.length));

    for (const v of variants) {
      try {
        const ids = await tryOnce(v, step);
        if (ids.length) return ids;
      } catch (e) {
        console.warn("[COMP][mapRank] allSearch failed:", e);
      }
    }

    return [];
  }

  // ==========================
  // ✅ 1) 지도 TOP placeId (예산 기반)
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q = String(keyword || "").trim();
    if (!q) return [];

    const budget = Math.max(2500, Math.min(9000, Number(opts.timeoutMs ?? 6000)));
    const startedAt = Date.now();
    const remaining = () => Math.max(400, budget - (Date.now() - startedAt));

    // 1) allSearch 우선
    try {
      const ids = await this.__findTopPlaceIdsViaAllSearch(q, limit + 5, Math.min(4200, remaining()));
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
      if (out.length) return out;
    } catch (e) {
      console.warn("[COMP][mapRank] allSearch failed:", e);
    }

    // 2) m.map (Railway 500 자주) — 남은 예산만
    const left = remaining();
    if (left < 700) return [];

    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://m.map.naver.com/");
    const page = await this.__newLightPage(context, Math.min(left, 6000));

    const buf: string[] = [];
    const onRespMap = async (res: any) => {
      try {
        const rt = res.request().resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const text = await res.text().catch(() => "");
        if (!text) return;

        if (
          !/(placeId|\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/\d{5,12})/.test(text)
        )
          return;

        buf.push(text);
        if (buf.length > 60) buf.shift();
      } catch {}
    };

    try {
      page.on("response", onRespMap);

      const gotoBudget = Math.min(remaining(), 5500);
      const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoBudget }).catch(() => null);
      const st = resp?.status?.() ?? -1;
      if (st >= 400) console.warn("[COMP][mapRank] m.map goto status", st, url);

      await page.waitForTimeout(Math.min(800, remaining()));

      const mergedText = buf.join("\n");
      let ids = this.__extractPlaceIdsFromAnyTextInOrder(mergedText);

      if (ids.length < 5) {
        const html = await page.content().catch(() => "");
        ids = this.__mergeInOrder(ids, this.__extractPlaceIdsFromAnyTextInOrder(html));
      }

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
        page.off("response", onRespMap);
      } catch {}
      try {
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  // ==========================
  // ✅ 2) 메인
  // ==========================
  public async findTopCompetitorsByKeyword(keyword: string, opts: FindTopCompetitorsOpts = {}): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");

    const totalTimeoutMs = Math.max(
      9000,
      Math.min(
        45000,
        opts.timeoutMs ??
          Number(process.env.COMPETITOR_TIMEOUT_MS || process.env.COMPETITOR_TOTAL_TIMEOUT_MS || 18000)
      )
    );
    const deadline = this.__deadlineMs(totalTimeoutMs);

    // 1) map rank
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, {
      excludePlaceId: exclude,
      limit,
      timeoutMs: Math.min(6500, Math.max(2500, this.__remaining(deadline)))
    }).catch(() => []);

    // 2) fallback: search where=place
    let metas: PlaceMeta[] = [];
    if (!mapIds.length) {
      const remain = Math.min(12000, Math.max(4500, this.__remaining(deadline)));
      metas = await this.__findTopPlaceMetasFromSearchWherePlaceFetch(q, remain).catch(() => []);
      if (!metas.length) metas = await this.__findTopPlaceMetasFromSearchWherePlaceRendered(q, remain).catch(() => []);
    }

    const candidateMetas = (mapIds.length ? mapIds.map((id) => ({ placeId: id, name: "" })) : metas)
      .map((x) => ({ placeId: this.__normPlaceId(x.placeId), name: this.__cleanText(x.name || "") }))
      .filter((x) => this.__isValidPlaceId(x.placeId))
      .filter((x) => !(exclude && x.placeId === exclude))
      .slice(0, limit);

    console.log("[COMP] query:", q);
    console.log("[COMP] mapIds:", mapIds);
    console.log("[COMP] candidateMetas:", candidateMetas);

    if (!candidateMetas.length) return [];

    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    const enrichPromises = candidateMetas.map((m) =>
      runLimited(() =>
        this.__fetchPlaceHomeAndExtract(m.placeId, Math.min(18000, Math.max(6500, this.__remaining(deadline))))
      ).catch(() => ({ name: "", keywords: [] as string[], loaded: false }))
    );

    const out: Competitor[] = [];
    for (let i = 0; i < candidateMetas.length && out.length < limit; i++) {
      if (this.__nowMs() > deadline) break;

      const pid = candidateMetas[i].placeId;
      const remaining = this.__remaining(deadline);

      const enriched = await this.__withTimeout(enrichPromises[i], remaining).catch(() => ({
        name: "",
        keywords: [] as string[],
        loaded: false
      }));

      let finalName = this.__cleanName(enriched?.name || candidateMetas[i].name || "");
      if (this.__isBannedName(finalName)) finalName = "";
      if (!finalName) finalName = `place_${pid}`;

      const finalKeywords = this.__finalizeKeywords(enriched?.keywords || []);
      const safeKeywords = finalKeywords.length ? finalKeywords : ["대표키워드없음"];
      const source: Competitor["source"] = enriched.loaded ? "place_home" : "search_html";

      out.push({
        placeId: pid,
        name: finalName,
        keywords: safeKeywords,
        source,
        rank: out.length + 1
      });
    }

    return out;
  }

  // ==========================
  // ✅ where=place (fetch)
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceFetch(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const reAnyPlaceId =
      /https?:\/\/(?:m\.place\.naver\.com|pcmap\.place\.naver\.com|place\.naver\.com)\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/g;

    const metas: PlaceMeta[] = [];
    const seen = new Set<string>();

    for (const m of html.matchAll(reAnyPlaceId)) {
      const pid = this.__normPlaceId(m[1]);
      if (!this.__isValidPlaceId(pid)) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);

      const idx = m.index ?? -1;
      const chunk = idx >= 0 ? html.slice(Math.max(0, idx - 900), Math.min(html.length, idx + 900)) : "";

      const titleMatches = [...chunk.matchAll(/title=["']([^"']{2,80})["']/gi)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean)
        .filter((t) => !this.__isBannedName(t));

      const ariaMatches = [...chunk.matchAll(/aria-label=["']([^"']{2,80})["']/gi)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean)
        .filter((t) => !this.__isBannedName(t));

      const textMatches = [...chunk.matchAll(/>\s*([가-힣A-Za-z0-9][^<>]{1,50})\s*</g)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean)
        .filter((t) => !this.__isBannedName(t));

      const name = titleMatches[0] || ariaMatches[0] || textMatches[0] || "";
      metas.push({ placeId: pid, name });
      if (metas.length >= 10) break;
    }

    return metas;
  }

  // ==========================
  // ✅ where=place (render)
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceRendered(
    keyword: string,
    timeoutMs: number
  ): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://search.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(900);

      const items = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        const out: Array<{ placeId: string; name: string }> = [];
        if (!d || !d.querySelectorAll) return out;

        const linkNodes: any[] = Array.from(
          d.querySelectorAll('a[href*="place.naver.com"], a[href*="m.place.naver.com"], a[href*="pcmap.place.naver.com"]')
        );

        const rePid = /\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/;

        const pickNameFromContainer = (el: any) => {
          let cur: any = el;
          for (let i = 0; i < 8 && cur; i++) {
            const tag = String(cur.tagName || "").toLowerCase();
            if (tag === "li" || tag === "article" || tag === "section" || tag === "div") break;
            cur = cur.parentElement;
          }
          const root = cur || el;

          const candidates: any[] = [];
          const sels = ['span[class*="tit"]', 'a[class*="tit"]', "strong", 'span[class*="name"]', 'a[class*="name"]', "span"];
          for (const sel of sels) {
            const ns: any[] = Array.from(root.querySelectorAll(sel));
            for (const n of ns) candidates.push(n);
            if (candidates.length > 30) break;
          }

          const texts: string[] = [];
          for (const n of candidates) {
            const t = String((n && (n.textContent || (n as any).innerText)) || "").replace(/\s+/g, " ").trim();
            if (!t) continue;
            if (t.length < 2 || t.length > 40) continue;
            texts.push(t);
            if (texts.length >= 20) break;
          }

          const fallback = String((el && (el.textContent || (el as any).innerText)) || "").replace(/\s+/g, " ").trim();
          if (fallback) texts.unshift(fallback);

          return texts[0] || "";
        };

        for (const a of linkNodes) {
          const href = String(a?.href || "");
          const m = href.match(rePid);
          const pid = String(m?.[1] || "").trim();
          if (!pid) continue;

          const name = pickNameFromContainer(a);
          out.push({ placeId: pid, name });

          if (out.length >= 200) break;
        }

        return out;
      });

      const metas: PlaceMeta[] = [];
      const seen = new Set<string>();

      for (const it of items) {
        const pid = this.__normPlaceId(it.placeId);
        if (!this.__isValidPlaceId(pid)) continue;
        if (seen.has(pid)) continue;

        const name = this.__cleanText(it.name || "");
        seen.add(pid);
        metas.push({ placeId: pid, name: this.__isBannedName(name) ? "" : name });

        if (metas.length >= 10) break;
      }

      if (!metas.length) {
        const ids = items.map((x) => this.__normPlaceId(x.placeId)).filter((id) => this.__isValidPlaceId(id));
        const uniq = Array.from(new Set(ids)).slice(0, 10);
        return uniq.map((id) => ({ placeId: id, name: "" }));
      }

      return metas;
    } catch {
      return [];
    } finally {
      try {
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  private async __fetchHtml(url: string, timeoutMs: number): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.__pickRandomUA(),
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

  // ==========================
  // ✅ place home: 대표키워드 추출 (NET JSON 우선 + NEXT_DATA + HTML regex + DOM fallback)
  // ==========================
  private async __fetchPlaceHomeAndExtract(
    placeId: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[]; loaded: boolean }> {
    const pid = this.__normPlaceId(placeId);
    if (!pid) return { name: "", keywords: [], loaded: false };

    const candidates = [
      `https://m.place.naver.com/place/${pid}/home`,
      `https://m.place.naver.com/hairshop/${pid}/home`,
      `https://m.place.naver.com/restaurant/${pid}/home`,
      `https://m.place.naver.com/cafe/${pid}/home`
    ];

    for (const u of candidates) {
      const r = await this.__renderAndExtractFromPlaceHome(u, Math.max(2500, Math.min(20000, timeoutMs)));
      if (r.loaded || r.name || r.keywords.length) return r;
    }

    return { name: "", keywords: [], loaded: false };
  }

  private async __renderAndExtractFromPlaceHome(
    url: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[]; loaded: boolean }> {
    const state = { name: "", keywords: [] as string[] };
    let loaded = false;

    const context = await this.__newContext("https://m.place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    // ✅ 네트워크 JSON이면 URL/키워드 문자열 매칭 없이도 "일단 파싱→deep scan"
    const onResponseKw = async (res: any) => {
      try {
        const req = res.request?.();
        const rt = req?.resourceType?.() ?? "";
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const ct = (await res.headerValue?.("content-type").catch(() => "")) || "";
        if (!/json|javascript/i.test(ct)) return;

        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 20) return;

        const j = this.__safeJsonParse(txt);
        if (!j) return;

        if (!state.name) {
          const nm = this.__deepFindName(j);
          if (nm && !this.__isBannedName(nm)) state.name = nm;
        }

        if (!state.keywords.length) {
          for (const k of [
            "representKeywordList",
            "representativeKeywordList",
            "representKeywords",
            "representativeKeywords",
            "keywordList",
            "keywords",
            "tags",
            "hashTags",
            "hashTagList"
          ]) {
            const arr = this.__deepFindStringArray(j, k);
            if (arr.length) {
              state.keywords = arr;
              break;
            }
          }
        }
      } catch {}
    };

    page.on("response", onResponseKw);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);

      const status = resp?.status?.() ?? -1;
      const finalUrl = page.url();
      const outer = await page.content().catch(() => "");
      const pageTitle = await page.title().catch(() => "");

      loaded = status === 200 && outer.length > 500;
      console.log("[COMP][placeHome] goto", { status, url, finalUrl, title: pageTitle, htmlLen: outer.length });

      // 네트워크 늦게 오는 경우 조금만
      await page.waitForTimeout(350).catch(() => {});

      // (A) NEXT_DATA (outer)
      const nextOuter = this.__parseNextData(outer);
      if (nextOuter) {
        if (!state.name) {
          const nm = this.__deepFindName(nextOuter);
          if (nm && !this.__isBannedName(nm)) state.name = nm;
        }
        if (!state.keywords.length) {
          for (const k of [
            "representKeywordList",
            "representativeKeywordList",
            "representKeywords",
            "representativeKeywords",
            "keywordList",
            "keywords",
            "tags",
            "hashTags",
            "hashTagList"
          ]) {
            const arr = this.__deepFindStringArray(nextOuter, k);
            if (arr.length) {
              state.keywords = arr;
              break;
            }
          }
        }
      }

      // (B) HTML regex fallback (outer)
      if (!state.keywords.length) {
        const byRe = this.__extractKeywordArrayByRegex(outer);
        if (byRe.length) state.keywords = byRe;
      }

      // entry frame
      const frame = await this.__resolveEntryFrame(page, timeoutMs);

      if (!frame) {
        if (!state.keywords.length) {
          const domFallback = await this.__extractKeywordsFromPageDomSmart(page).catch(() => []);
          if (domFallback.length) state.keywords = domFallback;
        }

        const cleaned = this.__finalizeKeywords(state.keywords);
        console.log("[COMP][placeHome] extracted", {
          finalUrl,
          name: this.__cleanName(state.name),
          kwCount: cleaned.length,
          keywords: cleaned
        });
        return { name: this.__cleanName(state.name), keywords: cleaned, loaded };
      }

      await this.__expandAndScrollFrame(frame, timeoutMs).catch(() => {});

      // (C) DOM smart (frame)
      if (!state.keywords.length) {
        const early = await this.__extractKeywordsFromDomSmart(frame).catch(() => []);
        if (early.length) state.keywords = early;
      }

      // (D) NEXT_DATA / regex (frame html)
      if (!state.keywords.length || !state.name) {
        const frameHtml = await frame.content().catch(() => "");
        if (frameHtml) {
          const nextFrame = this.__parseNextData(frameHtml);
          if (nextFrame) {
            if (!state.name) {
              const nm = this.__deepFindName(nextFrame);
              if (nm && !this.__isBannedName(nm)) state.name = nm;
            }
            if (!state.keywords.length) {
              for (const k of [
                "representKeywordList",
                "representativeKeywordList",
                "representKeywords",
                "representativeKeywords",
                "keywordList",
                "keywords",
                "tags",
                "hashTags",
                "hashTagList"
              ]) {
                const arr = this.__deepFindStringArray(nextFrame, k);
                if (arr.length) {
                  state.keywords = arr;
                  break;
                }
              }
            }
          }

          if (!state.keywords.length) {
            const byRe2 = this.__extractKeywordArrayByRegex(frameHtml);
            if (byRe2.length) state.keywords = byRe2;
          }
        }
      }

      // (E) DOM wide
      if (!state.keywords.length) {
        const domWide = await this.__extractKeywordsFromDomWide(frame).catch(() => []);
        if (domWide.length) state.keywords = domWide;
      }

      // name fallback (og:title)
      if (!state.name) {
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,120})["']/);
        const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
        if (og && !this.__isBannedName(og)) state.name = og;
      }

      const cleanedKeywords = this.__finalizeKeywords(state.keywords);

      console.log("[COMP][placeHome] extracted", {
        finalUrl,
        name: this.__cleanName(state.name),
        kwCount: cleanedKeywords.length,
        keywords: cleanedKeywords
      });

      return { name: this.__cleanName(state.name), keywords: cleanedKeywords, loaded };
    } catch {
      return { name: "", keywords: [], loaded: false };
    } finally {
      try {
        page.off("response", onResponseKw);
      } catch {}
      try {
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  private async __resolveEntryFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
    const h1 = await page
      .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(7000, timeoutMs) })
      .catch(() => null);
    const f1 = h1 ? await h1.contentFrame().catch(() => null) : null;
    if (f1) return f1;

    const handles = await page.$$("iframe").catch(() => []);
    for (const h of handles) {
      const src = (await h.getAttribute("src").catch(() => "")) || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(src)) {
        const f = await h.contentFrame().catch(() => null);
        if (f) return f;
      }
    }

    const frames = page.frames();
    for (const f of frames) {
      const u = f.url() || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(u)) return f;
    }

    return null;
  }

  private async __expandAndScrollFrame(frame: Frame, timeoutMs: number) {
    const clickTexts = ["더보기", "정보 더보기", "펼치기", "전체보기", "자세히"];
    for (let round = 0; round < 2; round++) {
      for (const t of clickTexts) {
        try {
          const loc = frame.locator(`text=${t}`).first();
          if ((await loc.count().catch(() => 0)) > 0) {
            await loc.click({ timeout: Math.min(1200, timeoutMs) }).catch(() => {});
            await frame.waitForTimeout(180).catch(() => {});
          }
        } catch {}
      }
    }

    const steps = 14;
    for (let i = 0; i < steps; i++) {
      try {
        await frame.evaluate((ratio) => {
          const d: any = (globalThis as any).document;
          if (!d) return;

          const root = d.scrollingElement || d.documentElement || d.body;
          if (root && root.scrollHeight) root.scrollTop = Math.floor(root.scrollHeight * ratio);

          const els = Array.from(d.querySelectorAll("div, main, section")) as any[];
          for (const el of els) {
            try {
              const st = (globalThis as any).getComputedStyle?.(el);
              const oy = st?.overflowY || "";
              const canScroll = (oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight + 50;
              if (!canScroll) continue;
              el.scrollTop = Math.floor(el.scrollHeight * ratio);
            } catch {}
          }
        }, (i + 1) / steps);
      } catch {}
      await frame.waitForTimeout(220).catch(() => {});
    }

    try {
      await frame.evaluate(() => {
        const d: any = (globalThis as any).document;
        const root = d?.scrollingElement || d?.documentElement || d?.body;
        if (root) root.scrollTop = 0;
      });
    } catch {}
    await frame.waitForTimeout(150).catch(() => {});
  }

  private async __extractKeywordsFromDomSmart(frame: any): Promise<string[]> {
    const raw: string[] = await frame.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const push = (t: any) => {
        const s = clean(t);
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        out.push(s.replace(/^#/, ""));
      };

      const bad = (t: string) => /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(t);

      const allNodes = Array.from(d.querySelectorAll("span, strong, h2, h3, div, p")) as any[];
      const header = allNodes.find((el) => {
        const t = clean(el?.innerText || el?.textContent);
        return t && t.includes("대표") && t.includes("키워드");
      });

      const collectNear = (root: any) => {
        if (!root || !root.querySelectorAll) return;
        const nodes = Array.from(root.querySelectorAll("a, button, span")) as any[];
        for (const el of nodes) {
          const t = clean(el?.innerText || el?.textContent);
          if (!t) continue;
          if (t.length < 2 || t.length > 25) continue;
          if (bad(t)) continue;
          push(t);
          if (out.length >= 15) break;
        }
      };

      if (header) {
        let root: any = header;
        for (let i = 0; i < 2; i++) root = root?.parentElement || root;
        collectNear(root);
        collectNear(header?.parentElement?.nextElementSibling);
        collectNear(header?.nextElementSibling);
      }

      if (out.length < 3) {
        const tags = Array.from(d.querySelectorAll("span, a, button")) as any[];
        for (const el of tags) {
          const t = clean(el?.innerText || el?.textContent);
          if (!t || !t.startsWith("#")) continue;
          if (t.length < 2 || t.length > 25) continue;
          push(t);
          if (out.length >= 15) break;
        }
      }

      const uniq: string[] = [];
      const seen = new Set<string>();
      for (const s of out) {
        const k = s.replace(/\s+/g, "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      return uniq.slice(0, 10);
    });

    return this.__finalizeKeywords(raw);
  }

  private async __extractKeywordsFromDomWide(frame: any): Promise<string[]> {
    const raw: string[] = await frame.evaluate(() => {
      const texts: string[] = [];
      const push = (t: unknown) => {
        const s = String(t ?? "").replace(/\s+/g, " ").trim();
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        texts.push(s.replace(/^#/, ""));
      };

      const d: any = (globalThis as any).document;
      if (!d || !d.querySelectorAll) return texts;

      const nodes = Array.from(d.querySelectorAll("a, button, span, div"));
      for (const el of nodes as any[]) {
        const t = (el?.innerText ?? el?.textContent ?? "") as string;
        push(t);
      }
      return texts;
    });

    return this.__finalizeKeywords(raw);
  }

  private async __extractKeywordsFromPageDomSmart(page: Page): Promise<string[]> {
    const raw: string[] = await page.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d || !d.querySelectorAll) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const push = (t: any) => {
        const s = clean(t);
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        out.push(s.replace(/^#/, ""));
      };

      const nodes: any[] = Array.from(d.querySelectorAll("a, button, span"));
      for (const el of nodes) {
        const t = clean(el?.innerText || el?.textContent);
        if (!t) continue;
        if (t.length < 2 || t.length > 25) continue;
        if (/^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(t)) continue;
        push(t);
        if (out.length >= 15) break;
      }

      const uniq: string[] = [];
      const seen = new Set<string>();
      for (const s of out) {
        const k = s.replace(/\s+/g, "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      return uniq.slice(0, 10);
    });

    return outNormalize(raw => raw); // placeholder to keep structure
  }

  // 👇 위 함수 마지막 줄 교체: ts/런타임 안전 위해 그냥 아래로 대체
  // (실수 방지용: 상단 함수에서 return outNormalize(...) 넣지 말고, 아래 2줄로 끝나야 함)
  // return this.__finalizeKeywords(raw);

  private __finalizeKeywords(keywords: string[]) {
    const cleaned = (keywords || [])
      .map((k) => this.__normalizeKeyword(k))
      .filter(Boolean)
      .filter((k) => k.length >= 2 && k.length <= 25)
      .filter((k) => !this.__isNoiseKeyword(k));

    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const s of cleaned) {
      const key = s.replace(/\s+/g, "");
      if (!key || seen.has(key)) continue;
      seen.add(key);
      uniq.push(s);
    }
    return uniq.slice(0, 5);
  }

  // ==========================
  // generic helpers
  // ==========================
  private async __withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    const t = new Promise<T>((_, reject) => {
      const id = setTimeout(() => {
        clearTimeout(id);
        reject(new Error("withTimeout"));
      }, Math.max(1, ms));
    });
    return await Promise.race([p, t]);
  }

  private __createLimiter(concurrency: number) {
    let active = 0;
    const queue: Array<() => void> = [];

    const next = () => {
      if (active >= concurrency) return;
      const job = queue.shift();
      if (!job) return;
      active++;
      job();
    };

    return async <T>(fn: () => Promise<T>): Promise<T> => {
      return await new Promise<T>((resolve) => {
        const run = () => {
          fn()
            .then(resolve)
            .catch(() => resolve((undefined as any) as T))
            .finally(() => {
              active--;
              next();
            });
        };
        queue.push(run);
        next();
      });
    };
  }

  private __parseNextData(html: string): any | null {
    const m = String(html || "").match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m?.[1]) return null;
    return this.__safeJsonParse(m[1]);
  }

  private __deepCollect(obj: any, predicate: (x: any) => boolean, out: any[] = []) {
    if (!obj || typeof obj !== "object") return out;
    if (predicate(obj)) out.push(obj);
    if (Array.isArray(obj)) {
      for (const it of obj) this.__deepCollect(it, predicate, out);
      return out;
    }
    for (const k of Object.keys(obj)) this.__deepCollect((obj as any)[k], predicate, out);
    return out;
  }

  private __deepFindStringArray(obj: any, keyName: string): string[] {
    const hits = this.__deepCollect(obj, (x) => x && typeof x === "object" && Array.isArray((x as any)[keyName]), []);

    const pickFromItem = (it: any): string => {
      if (typeof it === "string") return this.__normalizeKeyword(it);
      if (it && typeof it === "object") {
        const candKeys = ["keyword", "name", "text", "title", "value", "label"];
        for (const k of candKeys) {
          const v = (it as any)[k];
          if (typeof v === "string") {
            const t = this.__normalizeKeyword(v);
            if (t) return t;
          }
        }
      }
      return "";
    };

    for (const h of hits) {
      const arr = (h as any)[keyName] as any[];
      const strs = arr.map((v) => pickFromItem(v)).filter(Boolean).filter((s) => !this.__isNoiseKeyword(s));
      if (strs.length) return Array.from(new Set(strs));
    }
    return [];
  }

  private __deepFindName(obj: any): string {
    const keyCandidates = ["name", "placeName", "businessName", "bizName", "displayName", "storeName", "partnerName", "title"];
    const hits = this.__deepCollect(
      obj,
      (x) => x && typeof x === "object" && keyCandidates.some((k) => typeof (x as any)[k] === "string"),
      []
    );

    for (const h of hits) {
      for (const k of keyCandidates) {
        const v = (h as any)[k];
        if (typeof v === "string") {
          const t = this.__cleanName(v);
          if (!t) continue;
          if (this.__isBannedName(t)) continue;
          if (t.length >= 2 && t.length <= 60) return t;
        }
      }
    }
    return "";
  }

  private __extractKeywordArrayByRegex(html: string): string[] {
    const text = String(html || "");
    const re =
      /"(?:representKeywordList|keywordList|representKeywords|keywords|representativeKeywords|representativeKeywordList|tags|hashTags|hashTagList)"\s*:\s*(\[[\s\S]*?\])/gi;

    for (const m of text.matchAll(re)) {
      const inside = m[1] || "";
      const parsed = this.__safeJsonParse(inside);

      if (Array.isArray(parsed)) {
        const picked = parsed
          .map((v: any) => {
            if (typeof v === "string") return v;
            if (v && typeof v === "object") return v.keyword ?? v.name ?? v.text ?? v.title ?? "";
            return "";
          })
          .filter(Boolean);

        const fin = this.__finalizeKeywords(picked);
        if (fin.length) return fin;
      }

      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)].map((x) => x[1]).filter(Boolean);
      const fin = this.__finalizeKeywords(strs);
      if (fin.length) return fin;
    }

    return [];
  }

  private __extractPlaceIdsFromAnyTextInOrder(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const s = String(text || "");

    const rePath = /\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/g;
    for (const m of s.matchAll(rePath)) {
      const id = this.__normPlaceId(m[1]);
      if (!id || seen.has(id)) continue;
      if (!this.__isValidPlaceId(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 150) break;
    }

    if (ids.length < 10) {
      const rePlaceId = /placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g;
      for (const m of s.matchAll(rePlaceId)) {
        const id = this.__normPlaceId(m[1]);
        if (!id || seen.has(id)) continue;
        if (!this.__isValidPlaceId(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 150) break;
      }
    }

    if (ids.length < 10) {
      const reId = /["']id["']\s*:\s*["'](\d{5,12})["']/g;
      for (const m of s.matchAll(reId)) {
        const id = this.__normPlaceId(m[1]);
        if (!id || seen.has(id)) continue;
        if (!this.__isValidPlaceId(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 150) break;
      }
    }

    return ids;
  }

  private __mergeInOrder(a: string[], b: string[]) {
    const out: string[] = [];
    const seen = new Set<string>();
    for (const x of [...a, ...b]) {
      const id = this.__normPlaceId(x);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
    return out;
  }
}
