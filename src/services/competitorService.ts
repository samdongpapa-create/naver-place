// src/services/competitorService.ts
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
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
  // ✅ PlaceId 필터/정규화
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
      .replace(/[^\w가-힣\s\-·]/g, "")
      .trim();
  }

  private __isBannedName(name: string) {
    const n = this.__cleanText(name);
    if (!n) return true;
    if (/^(광고|저장|길찾기|예약|전화|공유|블로그|리뷰|사진|홈|메뉴|가격)$/i.test(n)) return true;
    if (/^네이버\s*플레이스$/i.test(n)) return true;
    if (/네이버\s*플레이스/i.test(n) && n.length <= 12) return true;
    return false;
  }

  // ==========================
  // ✅ searchCoord 정규화 (필수!)
  // - allSearch는 searchCoord 없으면 400
  // - 형식은 "lng;lat"
  // ==========================
  private __normalizeSearchCoord(): string {
    const raw = String(process.env.NAVER_MAP_SEARCH_COORD || "").trim();

    // 기본값: 서울 시청 근처
    const fallback = "126.9780;37.5665";

    if (!raw) return fallback;

    // 허용: "126.97;37.56" / "126.97,37.56" / "37.56;126.97" 등
    const cleaned = raw.replace(/\s+/g, "");

    // 케이스1: "lng;lat"
    if (/^-?\d+(\.\d+)?;-?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(";");
      const n1 = Number(a);
      const n2 = Number(b);
      if (Number.isFinite(n1) && Number.isFinite(n2)) {
        // a=lng(대략 120~130), b=lat(대략 33~38)
        const looksLngLat = Math.abs(n1) > Math.abs(n2);
        if (looksLngLat) return `${n1};${n2}`;
        // 반대로 들어왔을 수도 있으니 swap 시도
        return `${n2};${n1}`;
      }
    }

    // 케이스2: "lng,lat"
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(",");
      const n1 = Number(a);
      const n2 = Number(b);
      if (Number.isFinite(n1) && Number.isFinite(n2)) {
        const looksLngLat = Math.abs(n1) > Math.abs(n2);
        if (looksLngLat) return `${n1};${n2}`;
        return `${n2};${n1}`;
      }
    }

    // 케이스3: 다른 형식이면 fallback
    return fallback;
  }

  // ==========================
  // ✅ Playwright Context 생성
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
  // ✅ 0) allSearch JSON (searchCoord 필수)
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const searchCoord = this.__normalizeSearchCoord(); // ✅ 필수
    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "").trim();

    const tryOnce = async (useBoundary: boolean, ms: number) => {
      const url = new URL("https://map.naver.com/p/api/search/allSearch");
      url.searchParams.set("query", q);
      url.searchParams.set("type", "all");
      url.searchParams.set("page", "1");

      // ✅ 필수
      url.searchParams.set("searchCoord", searchCoord);

      // ✅ boundary는 값 있을 때만
      if (useBoundary && boundary) url.searchParams.set("boundary", boundary);

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
          throw new Error(`[allSearch] status=${res.status} body=${txt.slice(0, 220)}`);
        }

        const data: any = await res.json().catch(() => null);
        const list: any[] = data?.result?.place?.list || data?.result?.place?.items || [];

        const ids = list
          .map((x) => (x?.id ? String(x.id) : x?.placeId ? String(x.placeId) : ""))
          .map((id) => this.__normPlaceId(id))
          .filter((id) => this.__isValidPlaceId(id));

        return Array.from(new Set(ids)).slice(0, limit);
      } finally {
        clearTimeout(t);
      }
    };

    const budget = Math.max(1400, Math.min(4500, timeoutMs));
    const step = Math.floor(budget / 2);

    // 1) boundary 포함(값 있을 때만 의미) → 2) boundary 없이
    try {
      const ids1 = await tryOnce(true, step);
      if (ids1.length) return ids1;
    } catch (e) {
      console.warn("[COMP][mapRank] allSearch failed:", e);
    }

    try {
      const ids2 = await tryOnce(false, step);
      if (ids2.length) return ids2;
    } catch (e) {
      console.warn("[COMP][mapRank] allSearch failed:", e);
    }

    return [];
  }

  // ==========================
  // ✅ 1) 지도 TOP placeId
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q = String(keyword || "").trim();
    if (!q) return [];

    // 1순위 allSearch
    const ids0 = await this.__findTopPlaceIdsViaAllSearch(q, limit + 5, 4500).catch(() => []);
    if (ids0.length) {
      const out: string[] = [];
      const seen = new Set<string>();
      for (const id of ids0) {
        if (!id) continue;
        if (exclude && id === exclude) continue;
        if (seen.has(id)) continue;
        seen.add(id);
        out.push(id);
        if (out.length >= limit) break;
      }
      if (out.length) return out;
    }

    // 2순위 m.map (500 자주 뜸)
    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://m.map.naver.com/");
    const page = await this.__newLightPage(context, Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    const buf: string[] = [];
    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const ct = (await res.headerValue("content-type")) || "";
        const text = await res.text().catch(() => "");
        if (!text) return;

        const seemsUseful =
          /json|javascript/i.test(ct) ||
          /(placeId|\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/\d{5,12})/.test(text);

        if (!seemsUseful) return;

        buf.push(text);
        if (buf.length > 60) buf.shift();
      } catch {}
    };

    const onHttpFail = async (res: any) => {
      try {
        const st = res.status?.() ?? 0;
        const u = res.url?.() ?? "";
        if (st >= 400 && /naver\.com/.test(u)) console.warn("[COMP][mapRank][HTTP]", st, u);
      } catch {}
    };

    page.on("response", onResponse);
    page.on("response", onHttpFail);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
      const st = resp?.status?.() ?? -1;
      if (st >= 400) console.warn("[COMP][mapRank] m.map goto status", st, url);

      await page.waitForTimeout(1000);

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
        page.off("response", onResponse);
        page.off("response", onHttpFail);
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
      Math.min(45000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 18000))
    );
    const deadline = this.__deadlineMs(totalTimeoutMs);

    const mapIds = await this.findTopPlaceIdsFromMapRank(q, { excludePlaceId: exclude, limit }).catch(() => []);

    let metas: PlaceMeta[] = [];
    if (!mapIds.length) {
      const remain = Math.min(15000, Math.max(4000, this.__remaining(deadline)));

      metas = await this.__findTopPlaceMetasFromSearchWherePlaceFetch(q, remain).catch(() => []);
      if (!metas.length) metas = await this.__findTopPlaceMetasFromSearchWherePlaceRendered(q, remain).catch(() => []);

      // 마지막 보루: m.place 검색(fetch)
      if (!metas.length) {
        const ids = await this.__findTopPlaceIdsFromMobilePlaceSearchFetch(q, limit + 8, remain).catch(() => []);
        if (ids.length) metas = ids.map((id) => ({ placeId: id, name: "" }));
      }
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

    const nameMap = new Map<string, string>();
    for (const m of candidateMetas) {
      const nm = this.__cleanText(m.name || "");
      if (m.placeId && nm && !this.__isBannedName(nm)) nameMap.set(m.placeId, nm);
    }

    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    const enrichPromises = candidateMetas.map((m) =>
      runLimited(() =>
        this.__fetchPlaceHomeAndExtract(m.placeId, Math.min(16000, Math.max(6500, this.__remaining(deadline))))
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

      const fallbackName = nameMap.get(pid) || "";
      const enrichedName = this.__cleanText(enriched?.name || "");

      let finalName = this.__cleanText(enrichedName || fallbackName || "");
      if (this.__isBannedName(finalName)) finalName = "";
      if (!finalName) finalName = `place_${pid}`;

      const finalKeywords = (enriched?.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5);

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
    const html = await this.__fetchHtml(url, timeoutMs, "https://search.naver.com/").catch((e) => {
      console.warn("[COMP][where=place][fetch] failed:", e);
      return "";
    });
    if (!html) return [];

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
      if (metas.length >= 12) break;
    }

    return metas;
  }

  // ==========================
  // ✅ where=place (render)
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceRendered(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://search.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(800);

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
            const t = String((n && (n.textContent || n.innerText)) || "").replace(/\s+/g, " ").trim();
            if (!t) continue;
            if (t.length < 2 || t.length > 40) continue;
            texts.push(t);
            if (texts.length >= 30) break;
          }

          const fallback = String((el && (el.textContent || el.innerText)) || "").replace(/\s+/g, " ").trim();
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
        if (name && this.__isBannedName(name)) {
          seen.add(pid);
          metas.push({ placeId: pid, name: "" });
        } else {
          seen.add(pid);
          metas.push({ placeId: pid, name });
        }

        if (metas.length >= 12) break;
      }

      if (!metas.length) {
        const ids = items
          .map((x) => this.__normPlaceId(x.placeId))
          .filter((id) => this.__isValidPlaceId(id));
        const uniq = Array.from(new Set(ids)).slice(0, 12);
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

  // ==========================
  // ✅ 마지막 보루: m.place 검색(fetch)
  // ==========================
  private async __findTopPlaceIdsFromMobilePlaceSearchFetch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://m.place.naver.com/search?query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs, "https://m.place.naver.com/").catch(() => "");
    if (!html) return [];

    const ids = this.__extractPlaceIdsFromAnyTextInOrder(html);

    const out: string[] = [];
    const seen = new Set<string>();
    for (const id of ids) {
      if (!id) continue;
      if (!this.__isValidPlaceId(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= limit) break;
    }
    return out;
  }

  private async __fetchHtml(url: string, timeoutMs: number, referer = "https://search.naver.com/"): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.__pickRandomUA(),
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          Referer: referer
        },
        redirect: "follow",
        signal: ctrl.signal
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`fetch status=${res.status} body=${txt.slice(0, 140)}`);
      }
      return (await res.text()) || "";
    } finally {
      clearTimeout(t);
    }
  }

  // ==========================
  // ✅ place home: 대표키워드 추출
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
    const netState = { name: "", keywords: [] as string[] };
    let loaded = false;

    const context = await this.__newContext("https://m.place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    const onResponse = async (res: any) => {
      try {
        const rt = res.request().resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const u = String(res.url?.() || "");
        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 20) return;

        const looksLikeKeyword =
          /(keywordList|representKeywordList|representKeywords|keywords|representative)/i.test(u) ||
          /(keywordList|representKeywordList|representKeywords|keywords|representative)/.test(txt);

        if (!looksLikeKeyword) return;

        const j = this.__safeJsonParse(txt);

        if (j) {
          if (!netState.name) {
            const nm = this.__deepFindName(j);
            if (nm && !this.__isBannedName(nm)) netState.name = nm;
          }

          if (!netState.keywords.length) {
            for (const k of [
              "keywordList",
              "representKeywordList",
              "representKeywords",
              "keywords",
              "representativeKeywords",
              "representativeKeywordList"
            ]) {
              const arr = this.__deepFindStringArray(j, k);
              if (arr.length) {
                netState.keywords = arr;
                break;
              }
            }
          }

          if (!netState.keywords.length) {
            const loose = this.__deepFindKeywordsLoose(j);
            if (loose.length) netState.keywords = loose;
          }
          return;
        }

        if (!netState.keywords.length) {
          const fallback = this.__extractKeywordArrayByRegex(txt);
          if (fallback.length) netState.keywords = fallback;
        }
      } catch {}
    };

    page.on("response", onResponse);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);

      const status = resp?.status?.() ?? -1;
      const finalUrl = page.url();
      const outer = await page.content().catch(() => "");
      const pageTitle = await page.title().catch(() => "");

      loaded = status === 200 && outer.length > 500;

      console.log("[COMP][placeHome] goto", { status, url, finalUrl, title: pageTitle, htmlLen: outer.length });

      const iframeHandle = await page
        .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(8000, timeoutMs) })
        .catch(() => null);

      let frame: any = null;
      if (iframeHandle) frame = await iframeHandle.contentFrame().catch(() => null);

      if (frame) {
        await frame.waitForLoadState("domcontentloaded").catch(() => {});
        await frame.waitForSelector('script#__NEXT_DATA__', { timeout: Math.min(6500, timeoutMs) }).catch(() => {});
      }

      const frameHtml = frame ? await frame.content().catch(() => "") : "";

      const nextFromOuter = this.__parseNextData(outer);
      if (nextFromOuter) {
        const nm = this.__deepFindName(nextFromOuter);
        if (!netState.name && nm && !this.__isBannedName(nm)) netState.name = nm;

        if (!netState.keywords.length) {
          for (const k of [
            "keywordList",
            "representKeywordList",
            "representKeywords",
            "keywords",
            "representativeKeywords",
            "representativeKeywordList"
          ]) {
            const arr = this.__deepFindStringArray(nextFromOuter, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }
        if (!netState.keywords.length) {
          const loose = this.__deepFindKeywordsLoose(nextFromOuter);
          if (loose.length) netState.keywords = loose;
        }
      }

      if (frameHtml) {
        const next = this.__parseNextData(frameHtml);

        const nm = this.__deepFindName(next);
        if (!netState.name && nm && !this.__isBannedName(nm)) netState.name = nm;

        if (!netState.keywords.length) {
          for (const k of [
            "keywordList",
            "representKeywordList",
            "representKeywords",
            "keywords",
            "representativeKeywords",
            "representativeKeywordList"
          ]) {
            const arr = this.__deepFindStringArray(next, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }

        if (!netState.keywords.length) {
          const loose = this.__deepFindKeywordsLoose(next);
          if (loose.length) netState.keywords = loose;
        }

        if (!netState.keywords.length) {
          const fallback = this.__extractKeywordArrayByRegex(frameHtml);
          if (fallback.length) netState.keywords = fallback;
        }
      }

      if (frame && !netState.keywords.length) {
        const domKeywords = await this.__extractKeywordsFromDom(frame).catch(() => []);
        if (domKeywords.length) netState.keywords = domKeywords;
      }

      if (!netState.name) {
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
        const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
        if (og && !this.__isBannedName(og)) netState.name = og;
      }

      if (!netState.name && frameHtml) {
        const m1 = frameHtml.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
        const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
        if (og && !this.__isBannedName(og)) netState.name = og;
      }

      const cleanedKeywords = (netState.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5);

      return { name: this.__cleanText(netState.name), keywords: cleanedKeywords, loaded };
    } catch {
      return { name: "", keywords: [], loaded: false };
    } finally {
      try {
        page.off("response", onResponse);
      } catch {}
      try {
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  private async __extractKeywordsFromDom(frame: any): Promise<string[]> {
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

    const cleaned = raw
      .map((x) => this.__cleanText(x))
      .filter(Boolean)
      .filter((x) => x.length >= 2 && x.length <= 25)
      .filter((x) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천|영업|휴무|길찾기|전화)/.test(x));

    const uniq: string[] = [];
    const seen = new Set<string>();

    const score = (s: string) => {
      let sc = 0;
      if (/(역|동|구|로|길)/.test(s)) sc += 2;
      if (/(미용실|헤어|살롱|펌|염색|커트|컷|클리닉|카페|맛집|식당|브런치|디저트)/.test(s)) sc += 2;
      if (/[가-힣]/.test(s)) sc += 1;
      if (/^(리뷰|사진|예약|문의|가격|메뉴)$/.test(s)) sc -= 3;
      return sc;
    };

    cleaned
      .sort((a, b) => score(b) - score(a))
      .forEach((s) => {
        const k = s.replace(/\s+/g, "");
        if (seen.has(k)) return;
        seen.add(k);
        uniq.push(s);
      });

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

  private __deepFindKeywordsLoose(obj: any): string[] {
    const out: string[] = [];
    const seen = new Set<string>();

    const push = (v: any) => {
      const t = this.__cleanText(String(v ?? ""));
      if (!t) return;
      if (t.length < 2 || t.length > 25) return;
      if (/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천|길찾기|전화|공유|블로그|리뷰|사진|홈|메뉴)/.test(t))
        return;
      const key = t.replace(/\s+/g, "");
      if (seen.has(key)) return;
      seen.add(key);
      out.push(t);
    };

    const hits = this.__deepCollect(obj, (x) => x && typeof x === "object" && !Array.isArray(x), []);
    for (const h of hits) {
      for (const k of ["keyword", "name", "text", "title", "value", "label", "displayName", "storeName"]) {
        if (typeof (h as any)[k] === "string") push((h as any)[k]);
      }
    }

    const score = (s: string) => {
      let sc = 0;
      if (/(역|동|구|로|길)/.test(s)) sc += 3;
      if (/(미용실|헤어|살롱|펌|염색|커트|컷|클리닉|카페|맛집|식당|브런치|디저트)/.test(s)) sc += 3;
      if (/[가-힣]/.test(s)) sc += 1;
      return sc;
    };

    return out.sort((a, b) => score(b) - score(a)).slice(0, 5);
  }

  private __deepFindStringArray(obj: any, keyName: string): string[] {
    const hits = this.__deepCollect(obj, (x) => x && typeof x === "object" && Array.isArray((x as any)[keyName]), []);

    const pickFromItem = (it: any): string => {
      if (typeof it === "string") return this.__cleanText(it);

      if (it && typeof it === "object") {
        const candKeys = ["keyword", "name", "text", "title", "value", "label"];
        for (const k of candKeys) {
          const v = (it as any)[k];
          if (typeof v === "string") {
            const t = this.__cleanText(v);
            if (t) return t;
          }
        }
        for (const k of Object.keys(it)) {
          const v = (it as any)[k];
          if (typeof v === "string") {
            const t = this.__cleanText(v);
            if (t) return t;
          }
        }
      }
      return "";
    };

    for (const h of hits) {
      const arr = (h as any)[keyName] as any[];
      const strs = arr
        .map((v) => pickFromItem(v))
        .filter(Boolean)
        .filter((s) => s.length >= 2 && s.length <= 25)
        .filter((s) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(s));

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
          const t = this.__cleanText(v);
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
    const re1 =
      /"(?:representKeywordList|keywordList|representKeywords|keywords|representativeKeywords|representativeKeywordList)"\s*:\s*(\[[\s\S]*?\])/g;

    const pickFromItem = (it: any): string => {
      if (typeof it === "string") return this.__cleanText(it);
      if (it && typeof it === "object") {
        for (const k of ["keyword", "name", "text", "title", "value", "label"]) {
          const v = (it as any)[k];
          if (typeof v === "string") {
            const t = this.__cleanText(v);
            if (t) return t;
          }
        }
      }
      return "";
    };

    for (const m of text.matchAll(re1)) {
      const inside = m[1] || "";

      const parsed = this.__safeJsonParse(inside);
      if (Array.isArray(parsed)) {
        const out = parsed
          .map((v) => pickFromItem(v))
          .filter(Boolean)
          .filter((s) => s.length >= 2 && s.length <= 25)
          .filter((s) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(s));
        if (out.length) return Array.from(new Set(out));
      }

      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)].map((x) => this.__cleanText(x[1])).filter(Boolean);
      if (strs.length) return Array.from(new Set(strs));
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
      if (ids.length >= 120) break;
    }

    if (ids.length < 10) {
      const rePlaceId = /placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g;
      for (const m of s.matchAll(rePlaceId)) {
        const id = this.__normPlaceId(m[1]);
        if (!id || seen.has(id)) continue;
        if (!this.__isValidPlaceId(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 120) break;
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
        if (ids.length >= 120) break;
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
