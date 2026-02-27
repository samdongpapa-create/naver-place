// src/services/competitorService.ts
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type APIResponse } from "playwright";

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

type PlaceHomeExtract = { name: string; keywords: string[]; loaded: boolean };

export class CompetitorService {
  private browser: Browser | null = null;

  private async getBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"]
    });
    return this.browser;
  }

  async close(): Promise<void> {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
  }

  // ==========================
  // ✅ UA / Referer
  // ==========================
  private __pickRandomUA(): string {
    const pool = [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36"
    ];
    return pool[Math.floor(Math.random() * pool.length)];
  }

  private __buildMapReferer(query: string): string {
    const q = encodeURIComponent(query);
    return `https://map.naver.com/p/search/${q}?c=15.00,0,0,0,dh`;
  }

  private __nowMs(): number {
    return Date.now();
  }

  private __deadlineMs(totalTimeoutMs: number): number {
    return this.__nowMs() + Math.max(1000, totalTimeoutMs) - 350;
  }

  private __remaining(deadline: number, min = 1): number {
    return Math.max(min, deadline - this.__nowMs());
  }

  // ==========================
  // ✅ PlaceId util
  // ==========================
  private __normPlaceId(pid: string): string {
    return String(pid || "").trim();
  }

  private __isValidPlaceId(pid: string): boolean {
    const s = this.__normPlaceId(pid);
    return /^\d{7,12}$/.test(s);
  }

  // ==========================
  // ✅ Text util
  // ==========================
  private __cleanText(s: string): string {
    return String(s || "")
      .replace(/\\u003c/g, "<")
      .replace(/\\u003e/g, ">")
      .replace(/&quot;|&#34;/g, '"')
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ")
      .replace(/[^\w가-힣\s\-·]/g, "")
      .trim();
  }

  private __normNoSpace(s: string): string {
    return String(s || "").replace(/\s+/g, "").trim();
  }

  private __isBannedName(name: string): boolean {
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
  // - Railway에서 env가 비거나 이상하게 들어오면 400 (missing searchCoord) 터짐
  // - 무조건 안전한 기본값 반환
  // ==========================
  private __normalizeSearchCoord(): string {
    const raw = String(process.env.NAVER_MAP_SEARCH_COORD || "").trim();
    const fallback = "126.9780;37.5665"; // lng;lat (서울)

    // ✅ 가장 흔한 실수: "undefined", "null"
    if (!raw || raw === "undefined" || raw === "null") return fallback;

    const cleaned = raw.replace(/\s+/g, "");
    const parsePair = (a: string, b: string): string => {
      const n1 = Number(a);
      const n2 = Number(b);
      if (!Number.isFinite(n1) || !Number.isFinite(n2)) return fallback;

      // lng: 120~130 / lat: 33~38 (KR)
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

  private __parseNextData(html: string): any | null {
    const m = String(html || "").match(/<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
    if (!m?.[1]) return null;
    return this.__safeJsonParse(m[1]);
  }

  // ==========================
  // ✅ 0) allSearch JSON (map rank)
  // - 반드시 searchCoord 보장
  // - 503/HTML 응답은 JSON으로 안 보고 실패 처리
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const searchCoord = this.__normalizeSearchCoord(); // ✅ 무조건 값 반환
    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "").trim();

    const tryOnce = async (useBoundary: boolean, ms: number): Promise<string[]> => {
      const url = new URL("https://map.naver.com/p/api/search/allSearch");
      url.searchParams.set("query", q);
      url.searchParams.set("type", "all");
      url.searchParams.set("page", "1");
      url.searchParams.set("searchCoord", searchCoord); // ✅ 필수
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

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text().catch(() => "");

        if (!res.ok) {
          throw new Error(
            `[allSearch${useBoundary ? ":xy+boundary" : ":xy"}] status=${res.status} body=${String(text || "").slice(0, 220)}`
          );
        }

        // ✅ 503 같은 경우 html이 올 수 있음 → JSON 취급 금지
        if (ct.includes("text/html") || /<!doctype html/i.test(text)) {
          throw new Error(
            `[allSearch${useBoundary ? ":html+xy" : ":html"}] status=${res.status} body=${String(text || "").slice(0, 220)}`
          );
        }

        const data: any = this.__safeJsonParse(text) ?? null;
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
  // ✅ 1) 지도 TOP placeId (예산 기반)
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}): Promise<string[]> {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q = String(keyword || "").trim();
    if (!q) return [];

    // ✅ 단계 예산(기본 6초): 바깥 perTry보다 작게
    const budget = Math.max(2500, Math.min(9000, Number(opts.timeoutMs ?? 6000)));
    const startedAt = Date.now();
    const remaining = () => Math.max(400, budget - (Date.now() - startedAt));

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

    // 2) m.map (막힐 확률 높음) — 남은 예산만큼만 시도
    const left = remaining();
    if (left < 700) return [];

    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://m.map.naver.com/");
    const page = await this.__newLightPage(context, Math.min(left, 6000));

    const buf: string[] = [];

    const onRespMap = async (res: APIResponse) => {
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

    const onHttpFail = async (res: APIResponse) => {
      try {
        const st = res.status?.() ?? 0;
        const u = res.url?.() ?? "";
        if (st >= 400 && /naver\.com/.test(u)) console.warn("[COMP][mapRank][HTTP]", st, u);
      } catch {}
    };

    page.on("response", onRespMap);
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
        page.off("response", onRespMap);
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
  // ✅ 2) 메인: 키워드 경쟁사 TOP
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

    // 1) map rank (예산 전달)
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
      runLimited(() => this.__fetchPlaceHomeAndExtract(m.placeId, Math.min(18000, Math.max(6500, this.__remaining(deadline))))).catch(
        () => ({ name: "", keywords: [] as string[], loaded: false })
      )
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

      // ✅ placeName 기준으로 잡음/업체명/미용실단독 제거까지 수행
      const finalKeywords = this.__finalizeKeywords(enriched?.keywords || [], finalName);
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
          const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();

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
            const t = clean(n && (n.textContent || n.innerText));
            if (!t) continue;
            if (t.length < 2 || t.length > 40) continue;
            texts.push(t);
            if (texts.length >= 20) break;
          }

          const fallback = clean(el && (el.textContent || el.innerText));
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
  // - 네트워크(JSON) 우선 → NEXT_DATA → DOM(query= 링크 기반) fallback
  // ==========================
  private async __fetchPlaceHomeAndExtract(placeId: string, timeoutMs: number): Promise<PlaceHomeExtract> {
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

  private async __renderAndExtractFromPlaceHome(url: string, timeoutMs: number): Promise<PlaceHomeExtract> {
    const netState: { name: string; keywords: string[] } = { name: "", keywords: [] };
    let loaded = false;

    const context = await this.__newContext("https://m.place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    const onResponseKw = async (res: APIResponse) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const u = String(res.url?.() || "");
        if (!/m\.place\.naver\.com/.test(u)) return;

        // ✅ 키워드/keywordList 관련 엔드포인트/응답만
        const looksKeywordish =
          /keyword/i.test(u) ||
          /keywordList/i.test(u) ||
          /represent/i.test(u) ||
          /graphql/i.test(u) ||
          /\/api\//i.test(u);

        if (!looksKeywordish) return;

        const ct = (await res.headerValue("content-type").catch(() => "")) || "";
        if (!/json|javascript|text\/plain/i.test(ct)) return;

        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 20) return;

        // ✅ HTML이면 탈락
        if (/<!doctype html/i.test(txt)) return;

        // ✅ 실제로 키워드 단서가 있는 경우만
        if (!/(keywordList|representKeyword|representativeKeyword|representKeywordList|keywords)/i.test(txt)) return;

        const j = this.__safeJsonParse(txt);
        if (!j) return;

        if (!netState.name) {
          const nm = this.__deepFindName(j);
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

      // ✅ 1) outer NEXT_DATA
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

      // ✅ 2) entry iframe
      const frame = await this.__resolveEntryFrame(page, timeoutMs);

      if (!frame) {
        // iframe 못 잡으면 page 단에서 query 링크 기반으로만 가볍게
        const domFallback = await this.__extractKeywordsFromPageDomQueryLinks(page).catch(() => []);
        if (!netState.keywords.length && domFallback.length) netState.keywords = domFallback;

        if (!netState.name) {
          const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
          const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
          if (og && !this.__isBannedName(og)) netState.name = og;
        }

        const cleanedName = this.__cleanText(netState.name);
        const cleaned = this.__finalizeKeywords(netState.keywords, cleanedName);

        console.log("[COMP][placeHome] extracted", {
          finalUrl,
          name: cleanedName,
          kwCount: cleaned.length,
          keywords: cleaned
        });

        return { name: cleanedName, keywords: cleaned, loaded };
      }

      // ✅ 3) lazy-load
      await this.__expandAndScrollFrame(frame, timeoutMs).catch(() => {});

      // ✅ 4) DOM smart(query 링크/대표키워드 섹션 기반) 우선
      if (!netState.keywords.length) {
        const raw = await this.__extractKeywordsFromDomSmart(frame).catch(() => []);
        if (raw.length) netState.keywords = raw;
      }

      // ✅ 5) frame NEXT_DATA / regex
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

      // ✅ 6) wide fallback도 query 링크만 (UI 텍스트 금지)
      if (!netState.keywords.length) {
        const raw2 = await this.__extractKeywordsFromDomWide(frame).catch(() => []);
        if (raw2.length) netState.keywords = raw2;
      }

      if (!netState.name) {
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
        const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
        if (og && !this.__isBannedName(og)) netState.name = og;
      }

      const cleanedName = this.__cleanText(netState.name);
      const cleanedKeywords = this.__finalizeKeywords(netState.keywords, cleanedName);

      console.log("[COMP][placeHome] extracted", {
        finalUrl,
        name: cleanedName,
        kwCount: cleanedKeywords.length,
        keywords: cleanedKeywords
      });

      return { name: cleanedName, keywords: cleanedKeywords, loaded };
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

  private async __expandAndScrollFrame(frame: Frame, timeoutMs: number): Promise<void> {
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
        await frame.evaluate((ratio: number) => {
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

  // ==========================
  // ✅ DOM 키워드 추출 (핵심)
  // - 대표키워드 섹션 근처에서 "query=" 링크만 추출
  // - UI 텍스트(알림받기/리뷰/별점/업체명/미용실 단독) 주워오는 문제 제거
  // ==========================
  private async __extractKeywordsFromDomSmart(frame: Frame): Promise<string[]> {
    const raw: string[] = await frame.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const norm = (t: any) => clean(t).replace(/^#/, "");
      const push = (t: any) => {
        const s = norm(t);
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        out.push(s);
      };

      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t);

      // 1) "대표 키워드" 섹션 탐지
      const nodes = Array.from(d.querySelectorAll("span, strong, h2, h3, div, p")) as any[];
      const header = nodes.find((el) => {
        const t = clean(el?.innerText || el?.textContent);
        return t && t.includes("대표") && t.includes("키워드");
      });

      const collectQueryLinks = (root: any) => {
        if (!root || !root.querySelectorAll) return;
        const links = Array.from(root.querySelectorAll('a[href*="query="], a[href*="search.naver.com"]')) as any[];
        for (const a of links) {
          const href = String(a?.getAttribute?.("href") || a?.href || "");
          if (!href) continue;
          if (!/(query=)/i.test(href)) continue;

          const t = clean(a?.innerText || a?.textContent);
          if (!t || isNoise(t)) continue;
          if (t.length < 2 || t.length > 25) continue;

          push(t);
          if (out.length >= 12) break;
        }
      };

      // 대표키워드 섹션 근처에서 먼저
      if (header) {
        let root: any = header;
        for (let i = 0; i < 3; i++) root = root?.parentElement || root;
        collectQueryLinks(root);
        collectQueryLinks(header?.parentElement?.nextElementSibling);
        collectQueryLinks(header?.nextElementSibling);
      }

      // 그래도 없으면 페이지 전체에서 query 링크만
      if (out.length < 3) collectQueryLinks(d);

      // 마지막으로 해시태그 (노이즈 제외)
      if (out.length < 3) {
        const tags = Array.from(d.querySelectorAll("a, span, button")) as any[];
        for (const el of tags) {
          const t = clean(el?.innerText || el?.textContent);
          if (!t || !t.startsWith("#")) continue;
          const tt = t.replace(/^#/, "").trim();
          if (!tt || isNoise(tt)) continue;
          if (tt.length < 2 || tt.length > 25) continue;
          push(tt);
          if (out.length >= 12) break;
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
      return uniq.slice(0, 12);
    });

    return raw;
  }

  private async __extractKeywordsFromDomWide(frame: Frame): Promise<string[]> {
    // ✅ wide fallback도 query 링크만
    const raw: string[] = await frame.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t);

      const links = Array.from(d.querySelectorAll('a[href*="query="], a[href*="search.naver.com"]')) as any[];
      for (const a of links) {
        const href = String(a?.getAttribute?.("href") || a?.href || "");
        if (!href || !/(query=)/i.test(href)) continue;

        const t = clean(a?.innerText || a?.textContent).replace(/^#/, "");
        if (!t || isNoise(t)) continue;
        if (t.length < 2 || t.length > 25) continue;

        out.push(t);
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
      return uniq.slice(0, 12);
    });

    return raw;
  }

  private async __extractKeywordsFromPageDomQueryLinks(page: Page): Promise<string[]> {
    const raw: string[] = await page.evaluate(() => {
      const out: string[] = [];
      const d: any = (globalThis as any).document;
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t);

      const links = Array.from(d.querySelectorAll('a[href*="query="], a[href*="search.naver.com"]')) as any[];
      for (const a of links) {
        const href = String(a?.getAttribute?.("href") || a?.href || "");
        if (!href || !/(query=)/i.test(href)) continue;

        const t = clean(a?.innerText || a?.textContent).replace(/^#/, "");
        if (!t || isNoise(t)) continue;
        if (t.length < 2 || t.length > 25) continue;

        out.push(t);
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
      return uniq.slice(0, 12);
    });

    return raw;
  }

  // ==========================
  // ✅ 최종 키워드 정리(잡음 강력 제거)
  // ==========================
  private __finalizeKeywords(keywords: string[], placeName?: string): string[] {
    const nm = this.__normNoSpace(placeName || "");

    const cleaned = (keywords || [])
      .map((k) => this.__cleanText(k))
      .map((k) => k.replace(/^#/, "").trim())
      .filter(Boolean)
      .filter((k) => k.length >= 2 && k.length <= 25)

      // UI/잡음 제거
      .filter((k) => !/(알림받기|방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|리뷰\s*\d+|별점|평점|지도|저장|공유|길찾기|전화|예약|문의|쿠폰|이벤트|할인)/i.test(k))
      .filter((k) => !/^(홈|메뉴|가격|리뷰|사진|소개|소식|예약)$/i.test(k))

      // “미용실” 단독 같은 일반어 제거
      .filter((k) => !/^(미용실|헤어샵|헤어살롱|커트|컷)$/i.test(k))

      // 업체명/브랜드 자체 제거
      .filter((k) => {
        if (!nm) return true;
        const kk = this.__normNoSpace(k);
        if (!kk) return false;
        if (kk === nm) return false;
        if (nm.length >= 4 && kk.includes(nm)) return false;
        return true;
      });

    const uniq: string[] = [];
    const seen = new Set<string>();
    for (const s of cleaned) {
      const key = this.__normNoSpace(s);
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
            .catch(() => resolve((undefined as unknown) as T))
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

  // ==========================
  // deep find helpers
  // ==========================
  private __deepCollect(obj: any, predicate: (x: any) => boolean, out: any[] = []): any[] {
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
        .filter((s) => s.length >= 2 && s.length <= 25);

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

      if (Array.isArray(parsed)) {
        const picked = parsed
          .map((v: any) => {
            if (typeof v === "string") return v;
            if (v && typeof v === "object") return (v.keyword ?? v.name ?? v.text ?? v.title ?? "") as string;
            return "";
          })
          .filter(Boolean);

        if (picked.length) return picked.slice(0, 12);
      }

      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)].map((x) => x[1]).filter(Boolean);
      if (strs.length) return strs.slice(0, 12);
    }

    return [];
  }

  // ==========================
  // map parsing helpers
  // ==========================
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

  private __mergeInOrder(a: string[], b: string[]): string[] {
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
