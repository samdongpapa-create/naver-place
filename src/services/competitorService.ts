// src/services/competitorService.ts
import { chromium, type Browser, type BrowserContext, type Page, type Frame } from "playwright";

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

    if (/^방문\s*리뷰\s*\d+/i.test(n)) return true;
    if (/^블로그\s*리뷰\s*\d+/i.test(n)) return true;
    if (/리뷰\s*\d+/i.test(n) && n.length <= 15) return true;

    if (/^\d+(\.\d+)?\s*(m|km)$/i.test(n)) return true;
    if (/^\d+\s*분$/.test(n)) return true;

    return false;
  }

  // ==========================
  // ✅ searchCoord 정규화 (allSearch 필수)
  // ==========================
  private __normalizeSearchCoord(): string {
    const raw = String(process.env.NAVER_MAP_SEARCH_COORD || "").trim();
    const fallback = "126.9780;37.5665"; // 서울 시청 근처 lng;lat
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
  // ✅ anti-XSSI prefix 제거 후 JSON 파싱
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
  // ✅ 0) allSearch JSON
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const searchCoord = this.__normalizeSearchCoord();
    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "").trim();

    const tryOnce = async (useBoundary: boolean, ms: number) => {
      const url = new URL("https://map.naver.com/p/api/search/allSearch");
      url.searchParams.set("query", q);
      url.searchParams.set("type", "all");
      url.searchParams.set("page", "1");
      url.searchParams.set("searchCoord", searchCoord);
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
  // ✅ 1) 지도 TOP placeId (allSearch → m.map)
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q = String(keyword || "").trim();
    if (!q) return [];

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

    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://m.map.naver.com/");
    const page = await this.__newLightPage(context, Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    const buf: string[] = [];
    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const text = await res.text().catch(() => "");
        if (!text) return;
        if (!/(placeId|\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/\d{5,12})/.test(text))
          return;

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

    const candidateMetas = mapIds
      .map((id) => ({ placeId: this.__normPlaceId(id), name: "" }))
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

      let finalName = this.__cleanText(enriched?.name || "");
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
  // ✅ place home: 대표키워드/이름 추출 (lazy-load 대응: 더보기 + 스크롤)
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
        if (!j) return;

        if (!state.name) {
          const nm = this.__deepFindName(j);
          if (nm && !this.__isBannedName(nm)) state.name = nm;
        }

        if (!state.keywords.length) {
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
              state.keywords = arr;
              break;
            }
          }
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

      // 이름 보강 (outer)
      if (!state.name) {
        const og = this.__extractOgTitle(outer);
        if (og && !this.__isBannedName(og)) state.name = og;
      }
      if (!state.name) {
        const ld = this.__extractNameFromLdJson(outer);
        if (ld && !this.__isBannedName(ld)) state.name = ld;
      }

      // iframe 찾기 (더 robust)
      const frame = await this.__resolveEntryFrame(page, timeoutMs);
      if (!frame) {
        // iframe이 없으면 page DOM에서라도 키워드 시도
        const domFallback = await this.__extractKeywordsFromPageDomSmart(page).catch(() => []);
        if (domFallback.length) state.keywords = domFallback;

        const cleanedKeywords = this.__finalizeKeywords(state.keywords);
        return { name: this.__cleanText(state.name), keywords: cleanedKeywords, loaded };
      }

      // ✅ lazy-load 대응 (핵심): 더보기 클릭 + 자동 스크롤
      // ✅ 스크롤/펼치기 직후 1차 DOM smart로 먼저 시도(렌더 타이밍 때문에 중요)
if (!state.keywords.length) {
  const early = await this.__extractKeywordsFromDomSmart(frame).catch(() => []);
  if (early.length) state.keywords = early;
}

      // frame HTML
      const frameHtml = await frame.content().catch(() => "");

      // 이름 보강 (frame)
      if (frameHtml && !state.name) {
        const og = this.__extractOgTitle(frameHtml);
        if (og && !this.__isBannedName(og)) state.name = og;
      }
      if (frameHtml && !state.name) {
        const ld = this.__extractNameFromLdJson(frameHtml);
        if (ld && !this.__isBannedName(ld)) state.name = ld;
      }

      // NEXT_DATA 보강 (outer/frame)
      const nextOuter = this.__parseNextData(outer);
      if (nextOuter && !state.name) {
        const nm = this.__deepFindName(nextOuter);
        if (nm && !this.__isBannedName(nm)) state.name = nm;
      }
      if (nextOuter && !state.keywords.length) {
        for (const k of [
          "keywordList",
          "representKeywordList",
          "representKeywords",
          "keywords",
          "representativeKeywords",
          "representativeKeywordList"
        ]) {
          const arr = this.__deepFindStringArray(nextOuter, k);
          if (arr.length) {
            state.keywords = arr;
            break;
          }
        }
      }

      if (frameHtml) {
        const nextFrame = this.__parseNextData(frameHtml);
        if (nextFrame && !state.name) {
          const nm = this.__deepFindName(nextFrame);
          if (nm && !this.__isBannedName(nm)) state.name = nm;
        }
        if (nextFrame && !state.keywords.length) {
          for (const k of [
            "keywordList",
            "representKeywordList",
            "representKeywords",
            "keywords",
            "representativeKeywords",
            "representativeKeywordList"
          ]) {
            const arr = this.__deepFindStringArray(nextFrame, k);
            if (arr.length) {
              state.keywords = arr;
              break;
            }
          }
        }

        if (!state.keywords.length) {
          const fallback = this.__extractKeywordArrayByRegex(frameHtml);
          if (fallback.length) state.keywords = fallback;
        }
      }

      // ✅ DOM smart (대표키워드 칩)
      if (!state.keywords.length) {
        const domSmart = await this.__extractKeywordsFromDomSmart(frame).catch(() => []);
        if (domSmart.length) state.keywords = domSmart;
      }

      // 마지막 보루: 광범위 DOM
      if (!state.keywords.length) {
        const domWide = await this.__extractKeywordsFromDomWide(frame).catch(() => []);
        if (domWide.length) state.keywords = domWide;
      }

      const cleanedKeywords = this.__finalizeKeywords(state.keywords);

      console.log("[COMP][placeHome] extracted", {
        finalUrl,
        name: this.__cleanText(state.name),
        kwCount: cleanedKeywords.length,
        keywords: cleanedKeywords
      });

      return { name: this.__cleanText(state.name), keywords: cleanedKeywords, loaded };
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

  // ==========================
  // ✅ frame 찾기 강화
  // ==========================
  private async __resolveEntryFrame(page: Page, timeoutMs: number): Promise<Frame | null> {
    // 1) 표준 entryIframe
    const h1 = await page.waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(7000, timeoutMs) }).catch(() => null);
    const f1 = h1 ? await h1.contentFrame().catch(() => null) : null;
    if (f1) return f1;

    // 2) iframe 여러개 중 “place/hairshop/restaurant/cafe” 관련 src 가진 것
    const handles = await page.$$("iframe").catch(() => []);
    for (const h of handles) {
      const src = (await h.getAttribute("src").catch(() => "")) || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(src)) {
        const f = await h.contentFrame().catch(() => null);
        if (f) return f;
      }
    }

    // 3) 그래도 없으면 page.frames()에서 후보 찾기
    const frames = page.frames();
    for (const f of frames) {
      const u = f.url() || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(u)) return f;
    }

    return null;
  }

  // ==========================
  // ✅ lazy-load 유도: 더보기/펼치기 클릭 + 스크롤
  // ==========================
  private async __expandAndScrollFrame(frame: Frame, timeoutMs: number) {
  // ✅ “더보기/펼치기/정보 더보기” 류 버튼 최대한 클릭
  const clickTexts = ["더보기", "정보 더보기", "펼치기", "전체보기", "자세히", "더보기 버튼"];
  for (let round = 0; round < 2; round++) {
    for (const t of clickTexts) {
      try {
        const loc = frame.locator(`text=${t}`).first();
        if ((await loc.count().catch(() => 0)) > 0) {
          await loc.click({ timeout: Math.min(1200, timeoutMs) }).catch(() => {});
          await frame.waitForTimeout(200).catch(() => {});
        }
      } catch {}
    }
  }

  // ✅ lazy-load 유도: document 스크롤 + "스크롤 가능한 컨테이너"도 같이 스크롤
  const steps = 14;
  for (let i = 0; i < steps; i++) {
    try {
      await frame.evaluate((ratio) => {
        const d: any = (globalThis as any).document;
        if (!d) return;

        // 1) 기본 스크롤
        const root = d.scrollingElement || d.documentElement || d.body;
        if (root && root.scrollHeight) {
          root.scrollTop = Math.floor(root.scrollHeight * ratio);
        }

        // 2) overflow scroll 컨테이너들 스크롤
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

  // 상단 복귀
  try {
    await frame.evaluate(() => {
      const d: any = (globalThis as any).document;
      const root = d?.scrollingElement || d?.documentElement || d?.body;
      if (root) root.scrollTop = 0;
    });
  } catch {}
  await frame.waitForTimeout(150).catch(() => {});
}

    // 최상단으로 한 번 복귀
    try {
      await frame.evaluate(() => {
        const d: any = (globalThis as any).document;
        const el = d?.scrollingElement || d?.documentElement || d?.body;
        if (el) el.scrollTop = 0;
      });
    } catch {}
    await frame.waitForTimeout(120).catch(() => {});
  }

  private __finalizeKeywords(keywords: string[]) {
    const cleaned = (keywords || [])
      .map((k) => this.__cleanText(k))
      .filter(Boolean)
      .filter((k) => k.length >= 2 && k.length <= 25)
      .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k));

    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const s of cleaned) {
      const key = s.replace(/\s+/g, "");
      if (seen.has(key)) continue;
      seen.add(key);
      uniq.push(s);
    }
    return uniq.slice(0, 5);
  }

  // ==========================
  // ✅ DOM: 대표키워드 “칩/검색링크” 추출
  // ==========================
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
      // 해시태그 제거
      out.push(s.replace(/^#/, ""));
    };

    // ✅ 1) “대표키워드” 라벨/헤더 찾기
    const allNodes = Array.from(d.querySelectorAll("span, strong, h2, h3, div, p")) as any[];
    const header = allNodes.find((el) => {
      const t = clean(el?.innerText || el?.textContent);
      return t && t.includes("대표") && t.includes("키워드");
    });

    // ✅ 1-1) 헤더 근처(부모/형제)에서 짧은 칩 텍스트 수집
    const collectNear = (root: any) => {
      if (!root || !root.querySelectorAll) return;
      const nodes = Array.from(root.querySelectorAll("a, button, span")) as any[];
      for (const el of nodes) {
        const t = clean(el?.innerText || el?.textContent);
        if (!t) continue;
        if (t.length < 2 || t.length > 25) continue;
        // 버튼류/잡음 제거(최소)
        if (/^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(t)) continue;
        push(t);
        if (out.length >= 15) break;
      }
    };

    if (header) {
      // 부모 2단계까지 올려서 탐색
      let root: any = header;
      for (let i = 0; i < 2; i++) root = root?.parentElement || root;
      collectNear(root);

      // 형제/다음 섹션 탐색
      collectNear(header?.parentElement?.nextElementSibling);
      collectNear(header?.nextElementSibling);
    }

    // ✅ 2) 링크 기반(대표키워드가 검색 링크로 붙는 경우) — 패턴 확장
    if (out.length < 3) {
      const links = Array.from(
        d.querySelectorAll(
          'a[href*="query="], a[href*="search.naver.com"], a[href*="m.search.naver.com"], a[href*="map.naver.com"]'
        )
      ) as any[];

      for (const a of links) {
        const href = String(a?.getAttribute?.("href") || a?.href || "");
        if (!href) continue;
        // 검색/쿼리 링크로 보이는 것만
        if (!/(query=|search\.naver\.com|m\.search\.naver\.com|map\.naver\.com)/i.test(href)) continue;

        const t = clean(a?.innerText || a?.textContent);
        if (!t) continue;
        if (t.length < 2 || t.length > 25) continue;
        if (/^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(t)) continue;
        push(t);
        if (out.length >= 15) break;
      }
    }

    // ✅ 3) 해시태그(#) 형태 fallback
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

    // 중복 제거(원시)
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

    // 넓게 긁은 건 잡음이 많으니 finalize에서 중복/금칙만 정리
    return this.__finalizeKeywords(raw);
  }

  // iframe 못 잡았을 때, page DOM에서라도 칩 추출
  private async __extractKeywordsFromPageDomSmart(page: Page): Promise<string[]> {
    const raw: string[] = await page.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d || !d.querySelectorAll) return out;

      const push = (t: any) => {
        const s = String(t ?? "").replace(/\s+/g, " ").trim();
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        out.push(s.replace(/^#/, ""));
      };

      const nodes: any[] = Array.from(d.querySelectorAll('a[href*="search?query="], a[href*="/search?query="]'));
      for (const a of nodes) {
        const t = String(a?.innerText || a?.textContent || "").replace(/\s+/g, " ").trim();
        if (!t) continue;
        if (t.length > 25) continue;
        push(t);
        if (out.length >= 20) break;
      }
      return out;
    });

    return this.__finalizeKeywords(raw);
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

  private __extractOgTitle(html: string): string {
    const m1 = String(html || "").match(/property=["']og:title["'][^>]*content=["']([^"']{2,120})["']/i);
    if (!m1?.[1]) return "";
    const t = String(m1[1]).replace(/\s*:\s*네이버.*$/i, "").trim();
    return this.__cleanText(t);
  }

  private __extractNameFromLdJson(html: string): string {
    const s = String(html || "");
    const scripts = [...s.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
    for (const m of scripts) {
      const j = this.__safeJsonParse(m[1] || "");
      if (!j) continue;
      const nm = this.__deepFindName(j);
      if (nm) return nm;
    }
    return "";
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

    for (const m of text.matchAll(re1)) {
      const inside = m[1] || "";
      const parsed = this.__safeJsonParse(inside);
      if (Array.isArray(parsed)) {
        return this.__finalizeKeywords(
          parsed.map((v) => (typeof v === "string" ? v : v?.keyword ?? v?.name ?? v?.text ?? ""))
        );
      }

      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)].map((x) => x[1]).filter(Boolean);
      if (strs.length) return this.__finalizeKeywords(strs);
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
