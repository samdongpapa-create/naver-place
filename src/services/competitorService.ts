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
      .replace(/[^\w가-힣\s\-·]/g, "")
      .trim();
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

      // lng는 보통 120~130대, lat는 33~38대
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
  // ✅ 0) allSearch JSON (map rank)
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

    const budget = Math.max(1500, Math.min(4500, timeoutMs));
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
  // ✅ 1) 지도 TOP placeId
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
  const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
  const exclude = this.__normPlaceId(opts.excludePlaceId || "");
  const q = String(keyword || "").trim();
  if (!q) return [];

  // ✅ 이 단계 전체 예산(기본 6초): 바깥 perTry보다 작게
  const budget = Math.max(2500, Math.min(9000, Number(opts.timeoutMs ?? 6000)));
  const started = Date.now();
  const remaining = () => Math.max(400, budget - (Date.now() - started));

  // 1) allSearch (최대 3초)
  try {
    const ids = await this.__findTopPlaceIdsViaAllSearch(q, limit + 5, Math.min(3000, remaining()));
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

  // 2) m.map (막힐 확률 높음) — ✅ 여기서 25초 쓰면 바깥 timeout에 잘림
  //    그래서 남은 예산만큼만 시도
  const left = remaining();
  if (left < 700) return [];

  const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

  const context = await this.__newContext("https://m.map.naver.com/");
  const page = await this.__newLightPage(context, Math.min(left, 6000));

  const buf: string[] = [];
  const onResponse = async (res: any) => {
  try {
    const req = res.request();
    const rt = req.resourceType();
    if (rt !== "xhr" && rt !== "fetch") return;

    const u = String(res.url?.() || "");

    // ✅ 대표키워드가 뜨는 API만 우선적으로 잡기 (잡음 제거)
    // 네이버가 종종 /api/graphql, /api/v3, /api/search 등으로 내려줌
    const looksRelevant =
      /m\.place\.naver\.com/.test(u) &&
      /(graphql|api|_next\/data|keyword|home|place)/i.test(u);

    if (!looksRelevant) return;

    const ct = (await res.headerValue("content-type")) || "";
    if (!/json|javascript/i.test(ct)) return;

    const txt = await res.text().catch(() => "");
    if (!txt || txt.length < 20) return;

    // ✅ 키워드 관련 단어가 아예 없으면 패스
    if (!/(keywordList|representKeyword|representativeKeyword|representKeywordList|keywords)/i.test(txt)) return;

    const j = this.__safeJsonParse(txt);
    if (!j) return;

    // ✅ name
    if (!state.name) {
      const nm = this.__deepFindName(j);
      if (nm && !this.__isBannedName(nm)) state.name = nm;
    }

    // ✅ keywords: string[] 뿐 아니라 object[]도 처리 (현재 deepFindStringArray가 이미 처리)
    if (!state.keywords.length) {
      for (const k of [
        "representKeywordList",
        "representativeKeywordList",
        "representKeywords",
        "representativeKeywords",
        "keywordList",
        "keywords"
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
      Math.min(45000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || process.env.COMPETITOR_TOTAL_TIMEOUT_MS || 18000))
    );
    const deadline = this.__deadlineMs(totalTimeoutMs);

    // 1) map rank
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, {
  excludePlaceId: exclude,
  limit,
  timeoutMs: Math.min(6500, Math.max(2500, this.__remaining(deadline))) // ✅ perTry 예산 안에서 끝내기
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

      let finalName = this.__cleanText(enriched?.name || candidateMetas[i].name || "");
      if (this.__isBannedName(finalName)) finalName = "";
      if (!finalName) finalName = `place_${pid}`;

      const finalKeywords = (enriched?.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .filter((k) => !/(이전\s*페이지|다음\s*페이지|동영상|이미지|갯수|페이지|홈\s*으로|공지|업데이트)/.test(k))
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
  private async __findTopPlaceMetasFromSearchWherePlaceRendered(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
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
            const t = String((n && (n.textContent || n.innerText)) || "").replace(/\s+/g, " ").trim();
            if (!t) continue;
            if (t.length < 2 || t.length > 40) continue;
            texts.push(t);
            if (texts.length >= 20) break;
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

  // ✅ 이름 충돌 방지: onResponse 변수명 고유화
  const onResponseKw = async (res: any) => {
    try {
      const req = res.request();
      const rt = req.resourceType();
      if (rt !== "xhr" && rt !== "fetch") return;

      const u = String(res.url?.() || "");
      // ✅ 너무 무관한 응답 제외 (잡음 줄이기)
      if (!/m\.place\.naver\.com/.test(u)) return;

      const ct = (await res.headerValue("content-type")) || "";
      if (!/json|javascript/i.test(ct)) return;

      const txt = await res.text().catch(() => "");
      if (!txt || txt.length < 20) return;

      // ✅ 키워드 힌트 없으면 패스
      if (!/(keywordList|representKeyword|representativeKeyword|representKeywordList|keywords)/i.test(txt)) return;

      const j = this.__safeJsonParse(txt);
      if (!j) return;

      // name
      if (!netState.name) {
        const nm = this.__deepFindName(j);
        if (nm && !this.__isBannedName(nm)) netState.name = nm;
      }

      // keywords
      if (!netState.keywords.length) {
        for (const k of [
          "representKeywordList",
          "representativeKeywordList",
          "representKeywords",
          "representativeKeywords",
          "keywordList",
          "keywords"
        ]) {
          const arr = this.__deepFindStringArray(j, k);
          if (arr.length) {
            netState.keywords = arr;
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

    // ✅ entry iframe/frame 얻기
    const frame = await this.__resolveEntryFrame(page, timeoutMs);

    // 1) outer NEXT_DATA에서도 한번 시도
    const nextOuter = this.__parseNextData(outer);
    if (nextOuter) {
      if (!netState.name) {
        const nm = this.__deepFindName(nextOuter);
        if (nm && !this.__isBannedName(nm)) netState.name = nm;
      }
      if (!netState.keywords.length) {
        for (const k of [
          "representKeywordList",
          "representativeKeywordList",
          "representKeywords",
          "representativeKeywords",
          "keywordList",
          "keywords"
        ]) {
          const arr = this.__deepFindStringArray(nextOuter, k);
          if (arr.length) {
            netState.keywords = arr;
            break;
          }
        }
      }
    }

    // ✅ 프레임이 없으면 페이지 DOM에서라도 시도하고 끝
    if (!frame) {
      const domFallback = await this.__extractKeywordsFromPageDomSmart(page).catch(() => []);
      if (!netState.keywords.length && domFallback.length) netState.keywords = domFallback;

      const cleaned = this.__finalizeKeywords(netState.keywords);
      console.log("[COMP][placeHome] extracted", {
        finalUrl,
        name: this.__cleanText(netState.name),
        kwCount: cleaned.length,
        keywords: cleaned
      });
      return { name: this.__cleanText(netState.name), keywords: cleaned, loaded };
    }

    // ✅ lazy-load: 더보기/스크롤
    await this.__expandAndScrollFrame(frame, timeoutMs).catch(() => {});

    // 2) 스크롤 직후 DOM smart 우선
    if (!netState.keywords.length) {
      const early = await this.__extractKeywordsFromDomSmart(frame).catch(() => []);
      if (early.length) netState.keywords = early;
    }

    // 3) frame html의 NEXT_DATA/regex
    const frameHtml = await frame.content().catch(() => "");
    if (frameHtml) {
      const nextFrame = this.__parseNextData(frameHtml);
      if (nextFrame) {
        if (!netState.name) {
          const nm = this.__deepFindName(nextFrame);
          if (nm && !this.__isBannedName(nm)) netState.name = nm;
        }
        if (!netState.keywords.length) {
          for (const k of [
            "representKeywordList",
            "representativeKeywordList",
            "representKeywords",
            "representativeKeywords",
            "keywordList",
            "keywords"
          ]) {
            const arr = this.__deepFindStringArray(nextFrame, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }
      }

      if (!netState.keywords.length) {
        const byRe = this.__extractKeywordArrayByRegex(frameHtml);
        if (byRe.length) netState.keywords = byRe;
      }
    }

    // 4) DOM wide 마지막 보루
    if (!netState.keywords.length) {
      const domWide = await this.__extractKeywordsFromDomWide(frame).catch(() => []);
      if (domWide.length) netState.keywords = domWide;
    }

    // og:title fallback name
    if (!netState.name) {
      const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
      const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
      if (og && !this.__isBannedName(og)) netState.name = og;
    }

    const cleanedKeywords = this.__finalizeKeywords(netState.keywords);

    console.log("[COMP][placeHome] extracted", {
      finalUrl,
      name: this.__cleanText(netState.name),
      kwCount: cleanedKeywords.length,
      keywords: cleanedKeywords
    });

    return { name: this.__cleanText(netState.name), keywords: cleanedKeywords, loaded };
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
    // 1) 표준 entryIframe
    const h1 = await page
      .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(7000, timeoutMs) })
      .catch(() => null);
    const f1 = h1 ? await h1.contentFrame().catch(() => null) : null;
    if (f1) return f1;

    // 2) iframe 중 place/hairshop/restaurant/cafe 관련 src
    const handles = await page.$$("iframe").catch(() => []);
    for (const h of handles) {
      const src = (await h.getAttribute("src").catch(() => "")) || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(src)) {
        const f = await h.contentFrame().catch(() => null);
        if (f) return f;
      }
    }

    // 3) page.frames 후보
    const frames = page.frames();
    for (const f of frames) {
      const u = f.url() || "";
      if (/(place|hairshop|restaurant|cafe)/i.test(u)) return f;
    }

    return null;
  }

  // ✅ lazy-load 유도: 더보기/펼치기 + 스크롤(컨테이너 포함)
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

  // ✅ “대표키워드” 섹션 근처를 직접 훑어서 칩 텍스트 추출
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

      // 1) “대표키워드” 헤더 찾기
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

      // 2) 링크 기반(혹시 검색 링크면)
      if (out.length < 3) {
        const links = Array.from(
          d.querySelectorAll(
            'a[href*="query="], a[href*="search.naver.com"], a[href*="m.search.naver.com"], a[href*="map.naver.com"]'
          )
        ) as any[];
        for (const a of links) {
          const href = String(a?.getAttribute?.("href") || a?.href || "");
          if (!href) continue;
          if (!/(query=|search\.naver\.com|m\.search\.naver\.com|map\.naver\.com)/i.test(href)) continue;

          const t = clean(a?.innerText || a?.textContent);
          if (!t) continue;
          if (t.length < 2 || t.length > 25) continue;
          if (bad(t)) continue;
          push(t);
          if (out.length >= 15) break;
        }
      }

      // 3) #해시태그 fallback
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

    return this.__finalizeKeywords(raw);
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
  const re =
    /"(?:representKeywordList|keywordList|representKeywords|keywords|representativeKeywords|representativeKeywordList)"\s*:\s*(\[[\s\S]*?\])/gi;

  for (const m of text.matchAll(re)) {
    const inside = m[1] || "";
    const parsed = this.__safeJsonParse(inside);

    // ✅ 배열이 JSON으로 파싱되면 object[]까지 처리
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

    // fallback: 문자열만 뽑기
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
