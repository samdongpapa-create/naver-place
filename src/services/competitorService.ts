// src/services/competitorService.ts
import { chromium, type Browser, type BrowserContext, type Page, type Frame, type Response } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number;
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
  timeoutMs?: number;
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
  // ✅ query-param 기반 키워드만 추출 (DOM에 query 링크가 없을 때의 최후 보강)
  // - “URL의 query/q 파라미터 값”만 채택 => 요구사항 2 유지
  // ==========================
  private __extractKeywordsFromAnyTextByQueryParam(text: string): string[] {
    const s = String(text || "");
    if (!s) return [];

    const out: string[] = [];
    const seen = new Set<string>();

    const isNoise = (t: string) =>
      /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
      /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t) ||
      /^(내비게이션|네비게이션|navigation)$/i.test(t) ||
      /(로그인|동의|확인|취소|닫기)/i.test(t);

    const isPromoLike = (t: string) => /(원|만원|%|할인|쿠폰|이벤트|특가)/.test(t) && /\d/.test(t);

    const push = (raw: string) => {
      const v = this.__cleanText(raw).replace(/^#/, "").trim();
      if (!v) return;
      if (v.length < 2 || v.length > 25) return;
      if (isNoise(v)) return;
      if (isPromoLike(v)) return;

      const key = this.__normNoSpace(v);
      if (!key || seen.has(key)) return;
      seen.add(key);
      out.push(v);
    };

    // 1) URL-like 조각에서 query/q 값을 파싱
    const urlLike = s.match(/(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\b/g) || [];
    for (const u0 of urlLike) {
      if (!/(query=|[?&]q=)/i.test(u0)) continue;
      try {
        const u = new URL(u0, "https://m.place.naver.com/");
        const q = u.searchParams.get("query") || u.searchParams.get("q") || "";
        if (q) push(decodeURIComponent(q));
      } catch {
        const m = u0.match(/[?&](?:query|q)=([^&]+)/i);
        if (m?.[1]) {
          try {
            push(decodeURIComponent(m[1]));
          } catch {
            push(m[1]);
          }
        }
      }
      if (out.length >= 16) break;
    }

    // 2) JSON-ish 형태에서도 query/q 값만 (예: "query":"서대문역 미용실")
    if (out.length < 5) {
      const reJson = /["'](?:query|q)["']\s*:\s*["']([^"']{2,60})["']/gi;
      for (const m of s.matchAll(reJson)) {
        const v = m[1] || "";
        push(v);
        if (out.length >= 16) break;
      }
    }

    return out.slice(0, 16);
  }

  // ==========================
  // ✅ Debug logger
  // ==========================
  private __dbg(stage: string, payload: any) {
    try {
      console.log(`[COMP][DBG] ${stage}`, payload);
    } catch {}
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

  private __sleep(ms: number): Promise<void> {
    const t = Math.max(0, Math.floor(ms));
    return new Promise((r) => setTimeout(r, t));
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

  private __stripNaverSuffix(name: string): string {
    return this.__cleanText(name).replace(/\s*네이버\s*$/i, "").trim();
  }

  // ✅ 이름 오염(가격/프로모션/메뉴) 강력 차단
  private __isBannedName(name: string): boolean {
    const n0 = this.__cleanText(name);
    const n = n0.replace(/\s*네이버\s*$/i, "").trim();
    if (!n) return true;

    // 기본 UI 잡음
    if (/^(광고|저장|길찾기|예약|전화|공유|블로그|리뷰|사진|홈|메뉴|가격|더보기)$/i.test(n)) return true;
    if (/^네이버\s*플레이스$/i.test(n)) return true;
    if (/네이버\s*플레이스/i.test(n) && n.length <= 12) return true;

    // 리뷰/거리/시간
    if (/^방문\s*리뷰\s*\d+/i.test(n)) return true;
    if (/^블로그\s*리뷰\s*\d+/i.test(n)) return true;
    if (/리뷰\s*\d+/i.test(n) && n.length <= 15) return true;
    if (/^\d+(\.\d+)?\s*(m|km)$/i.test(n)) return true;
    if (/^\d+\s*분$/.test(n)) return true;

    // ✅ 가격/프로모션/시술가격류 문구 강력 차단
    if (/(^|[\s])\d{1,3}(,\d{3})+\s*원\b/.test(n)) return true; // 10,000원
    if (/(^|[\s])\d+\s*원\b/.test(n)) return true; // 3000원
    if (/(^|[\s])\d+\s*(천|만)\s*원\b/.test(n)) return true; // 8만원, 3천원
    if (/(^|[\s])\d+\s*만\s*\d+\s*천\s*원\b/.test(n)) return true; // 8만4천원
    if (/(^|[\s])\d+(\.\d+)?\s*(만원|원)\b/.test(n)) return true; // 5.9만원
    if (/(할인|특가|이벤트|쿠폰|%|원부터|~|부터)/.test(n) && /\d/.test(n)) return true;

    // ✅ 시술명+가격 패턴(상호명 오인 방지)
    if (/(커트|컷|펌|염색|클리닉|드라이|매직|셋팅|볼륨|뿌리|다운펌|아이롱)\s*\d/.test(n)) return true;

    // ✅ 숫자가 너무 많은 짧은 텍스트도 배제
    const digits = (n.match(/\d/g) || []).length;
    if (digits >= 4 && n.length <= 20) return true;

    return false;
  }

  // ==========================
  // ✅ Query variants (긴 쿼리 블록/분산 방지)
  // ==========================
  private __buildQueryVariants(keyword: string): string[] {
    const q0 = String(keyword || "").trim().replace(/\s+/g, " ");
    if (!q0) return [];

    const tokens = q0.split(" ").filter(Boolean);
    const out: string[] = [];

    const push = (s: string) => {
      const v = String(s || "").trim().replace(/\s+/g, " ");
      if (!v) return;
      if (!out.includes(v)) out.push(v);
    };

    push(q0);

    const station = tokens.find((t) => /역$/.test(t)) || (q0.match(/[가-힣A-Za-z0-9]+역/)?.[0] ?? "");
    const industry = /미용실|헤어샵|헤어살롱|헤어/.test(q0) ? "미용실" : "";

    if (station && industry) push(`${station} ${industry}`);
    if (tokens.length >= 2) push(`${tokens[0]} ${tokens[1]}`);
    if (tokens.length >= 3) push(`${tokens[0]} ${tokens[1]} ${tokens[2]}`);

    if (tokens.length >= 4) push(tokens.slice(0, tokens.length - 1).join(" "));
    if (tokens.length >= 5) push(tokens.slice(0, tokens.length - 2).join(" "));

    if (/파인트리/i.test(q0) && q0.includes("서대문역")) push("서대문역 미용실");

    return out.slice(0, 6);
  }

  // ==========================
  // ✅ env: searchCoord 정규화 (allSearch 필수)
  // ==========================
  private __normalizeSearchCoord(): string {
    const raw = String(process.env.NAVER_MAP_SEARCH_COORD || "").trim();
    const fallback = "126.9780;37.5665"; // lng;lat (서울)
    if (!raw || raw === "undefined" || raw === "null") return fallback;

    const cleaned = raw.replace(/\s+/g, "");
    const parsePair = (a: string, b: string): string => {
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
    if (/^-?\d+(\.\d+)?, -?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(",");
      return parsePair(a, b);
    }
    if (/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(cleaned)) {
      const [a, b] = cleaned.split(",");
      return parsePair(a, b);
    }
    return fallback;
  }

  private __searchCoordCandidates(): string[] {
    const env = this.__normalizeSearchCoord();
    const presets = ["126.9780;37.5665", "126.9900;37.5700", "126.9700;37.5600"];
    const out: string[] = [];
    const push = (s: string) => {
      const v = String(s || "").trim();
      if (!v) return;
      if (!out.includes(v)) out.push(v);
    };
    push(env);
    for (const p of presets) push(p);
    return out.slice(0, 4);
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
  // ✅ Fetch HTML helper
  // ==========================
  private async __fetchHtml(url: string, timeoutMs: number): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent": this.__pickRandomUA(),
          "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
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
  // ✅ util: merge unique until limit
  // ==========================
  private __pushUnique(out: string[], seen: Set<string>, ids: string[], limit: number, exclude?: string) {
    for (const raw of ids) {
      const id = this.__normPlaceId(raw);
      if (!this.__isValidPlaceId(id)) continue;
      if (exclude && id === exclude) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(id);
      if (out.length >= limit) break;
    }
  }

  // ==========================
  // ✅ 0) allSearch JSON (map rank)
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "").trim();
    const coords = this.__searchCoordCandidates();

    const tryOnce = async (searchCoord: string, useBoundary: boolean, ms: number): Promise<string[]> => {
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

        const ct = (res.headers.get("content-type") || "").toLowerCase();
        const text = await res.text().catch(() => "");

        if (!res.ok) {
          throw new Error(
            `[allSearch${useBoundary ? ":xy+boundary" : ":xy"}] status=${res.status} body=${String(text || "").slice(0, 220)}`
          );
        }
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

    const budget = Math.max(1600, Math.min(5200, timeoutMs));
    const step = Math.max(700, Math.floor(budget / 4));

    for (const useBoundary of [true, false]) {
      for (const c of coords) {
        try {
          const ids = await tryOnce(c, useBoundary, step);
          if (ids.length) return ids;
        } catch (e) {
          console.warn("[COMP][mapRank] allSearch failed:", e);
        }
        await this.__sleep(120);
      }
    }

    return [];
  }

  // ==========================
  // ✅ fallback A: m.place 검색 HTML(fetch)
  // ==========================
  private async __findTopPlaceIdsViaMPlaceSearchHtml(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];
    const url = `https://m.place.naver.com/search?query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs).catch(() => "");
    if (!html) return [];
    const ids = this.__extractPlaceIdsFromAnyTextInOrder(html);
    return ids.slice(0, limit);
  }

  // ==========================
  // ✅ fallback A-2: m.place 검색 렌더링(Playwright)
  // ==========================
  private async __findTopPlaceIdsViaMPlaceSearchRendered(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const searchUrl = `https://m.place.naver.com/search?query=${encodeURIComponent(q)}`;

    const runOnce = async (): Promise<{ status: number; html: string }> => {
      const context = await this.__newContext("https://m.place.naver.com/");
      const page = await this.__newLightPage(context, timeoutMs);

      try {
        await page.goto("https://m.place.naver.com/", { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 4500) }).catch(
          () => null
        );
        await page.waitForTimeout(450);

        const resp = await page.goto(searchUrl, { waitUntil: "domcontentloaded", timeout: Math.min(timeoutMs, 7000) }).catch(
          () => null
        );

        const st = resp?.status?.() ?? -1;
        if (st >= 400) console.warn("[COMP][mplaceSearch] goto status", st, searchUrl);

        await page.waitForTimeout(700);

        const html = await page.content().catch(() => "");
        return { status: st, html };
      } finally {
        try {
          await page.close();
        } catch {}
        try {
          await context.close();
        } catch {}
      }
    };

    const r1 = await runOnce().catch(() => ({ status: -1, html: "" }));
    if (r1.status !== 404 && r1.html) {
      const ids = this.__extractPlaceIdsFromAnyTextInOrder(r1.html);
      return Array.from(new Set(ids)).slice(0, limit);
    }

    if (r1.status === 404) {
      await this.__sleep(600 + Math.floor(Math.random() * 400));
      const r2 = await runOnce().catch(() => ({ status: -1, html: "" }));
      if (r2.status !== 404 && r2.html) {
        const ids = this.__extractPlaceIdsFromAnyTextInOrder(r2.html);
        return Array.from(new Set(ids)).slice(0, limit);
      }
    }

    return [];
  }

  // ==========================
  // ✅ fallback B: place.naver.com 검색 HTML(fetch)
  // ==========================
  private async __findTopPlaceIdsViaPcPlaceSearchHtml(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];
    const url = `https://place.naver.com/search?query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs).catch(() => "");
    if (!html) return [];
    const ids = this.__extractPlaceIdsFromAnyTextInOrder(html);
    return ids.slice(0, limit);
  }

  // ==========================
  // ✅ fallback B-2: place.naver.com 검색 렌더링(Playwright)
  // ==========================
  private async __findTopPlaceIdsViaPcPlaceSearchRendered(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];
    const url = `https://place.naver.com/search?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
      const st = resp?.status?.() ?? -1;
      if (st >= 400) console.warn("[COMP][pcPlaceSearch] goto status", st, url);

      await page.waitForTimeout(700);

      const html = await page.content().catch(() => "");
      const ids = this.__extractPlaceIdsFromAnyTextInOrder(html);

      return Array.from(new Set(ids)).slice(0, limit);
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
  // ✅ 최후 보루: where=place (fetch)
  // ✅ 변경: "텍스트 긁어서 name 추출" 제거 -> 속성(title/aria-label)만 제한적으로
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceFetch(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs).catch(() => "");
    if (!html) return [];

    const reAnyPlaceId =
      /https?:\/\/(?:m\.place\.naver\.com|pcmap\.place\.naver\.com|place\.naver\.com)\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/g;

    const metas: PlaceMeta[] = [];
    const seen = new Set<string>();

    // ✅ 안전 name: title/aria-label만 (그리고 banned면 빈 문자열)
    const pickSafeNameNearIndex = (idx: number): string => {
      if (idx < 0) return "";
      const chunk = html.slice(Math.max(0, idx - 900), Math.min(html.length, idx + 900));

      const titleCand = [...chunk.matchAll(/title=["']([^"']{2,80})["']/gi)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean);

      for (const t of titleCand) {
        if (!this.__isBannedName(t)) return t;
      }

      const ariaCand = [...chunk.matchAll(/aria-label=["']([^"']{2,80})["']/gi)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean);

      for (const t of ariaCand) {
        if (!this.__isBannedName(t)) return t;
      }

      // ✅ 텍스트에서 name 뽑는 건 "오염 원인"이라 금지
      return "";
    };

    for (const m of html.matchAll(reAnyPlaceId)) {
      const pid = this.__normPlaceId(m[1]);
      if (!this.__isValidPlaceId(pid)) continue;
      if (seen.has(pid)) continue;
      seen.add(pid);

      const idx = m.index ?? -1;
      const name = pickSafeNameNearIndex(idx);
      metas.push({ placeId: pid, name: name && !this.__isBannedName(name) ? name : "" });

      if (metas.length >= 12) break;
    }

    this.__dbg("where=place(fetch)", { query: q, metas: metas.length, sample: metas.slice(0, 3) });
    return metas;
  }

  // ==========================
  // ✅ 최후 보루: where=place (render)
  // ✅ 변경: container 텍스트 기반 name 추출 제거 -> aria-label/title만
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceRendered(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://search.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);
      const st = resp?.status?.() ?? -1;
      if (st >= 400) console.warn("[COMP][where=place] goto status", st, url);

      await page.waitForTimeout(800);

      const items = await page.evaluate(() => {
        const d: any = (globalThis as any).document;
        const out: Array<{ placeId: string; name: string }> = [];
        if (!d || !d.querySelectorAll) return out;

        const linkNodes: any[] = Array.from(
          d.querySelectorAll('a[href*="place.naver.com"], a[href*="m.place.naver.com"], a[href*="pcmap.place.naver.com"]')
        );

        const rePid = /\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/;

        const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();

        const pickSafeName = (a: any) => {
          // ✅ 안전한 속성 기반만
          const t1 = clean(a?.getAttribute?.("title"));
          if (t1) return t1;

          const t2 = clean(a?.getAttribute?.("aria-label"));
          if (t2) return t2;

          // 검색결과에서는 a 안에 "광고/가격" 텍스트가 섞이기 쉬워서 innerText 금지
          return "";
        };

        for (const a of linkNodes) {
          const href = String(a?.href || "");
          const m = href.match(rePid);
          const pid = String(m?.[1] || "").trim();
          if (!pid) continue;

          const name = pickSafeName(a);
          out.push({ placeId: pid, name });

          if (out.length >= 200) break;
        }

        return out;
      });

      const metas: PlaceMeta[] = [];
      const seen = new Set<string>();

      for (const it of items) {
        const pid = String(it.placeId || "").trim();
        if (!/^\d{7,12}$/.test(pid)) continue;
        if (seen.has(pid)) continue;

        const name = this.__cleanText(it.name || "");
        seen.add(pid);

        // ✅ banned면 무조건 빈 문자열
        metas.push({ placeId: pid, name: this.__isBannedName(name) ? "" : name });

        if (metas.length >= 10) break;
      }

      if (!metas.length) {
        const ids = items.map((x) => String(x.placeId || "").trim()).filter((id) => /^\d{7,12}$/.test(id));
        const uniq = Array.from(new Set(ids)).slice(0, 10);
        const out = uniq.map((id) => ({ placeId: id, name: "" }));
        this.__dbg("where=place(rendered:fallback_ids_only)", { query: q, ids: out.length, sample: out.slice(0, 3) });
        return out;
      }

      this.__dbg("where=place(rendered)", { query: q, metas: metas.length, sample: metas.slice(0, 3) });
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
  // ✅ 1) TOP5 placeId "안정 수집" (부분 성공 유지)
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}): Promise<string[]> {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q0 = String(keyword || "").trim();
    if (!q0) return [];

    const budget = Math.max(4000, Math.min(22000, Number(opts.timeoutMs ?? 9000)));
    const startedAt = Date.now();
    const remaining = () => Math.max(350, budget - (Date.now() - startedAt));

    const out: string[] = [];
    const seen = new Set<string>();
    const variants = this.__buildQueryVariants(q0);

    const stagePush = (stage: string, before: number, after: number, extra?: any) => {
      this.__dbg("top5_stage", { stage, added: Math.max(0, after - before), total: after, ...extra });
    };

    // 1) allSearch
    for (const q of variants) {
      if (out.length >= limit) break;
      if (remaining() < 650) break;

      const before = out.length;
      try {
        const ids = await this.__findTopPlaceIdsViaAllSearch(q, limit + 30, Math.min(5200, remaining()));
        this.__pushUnique(out, seen, ids, limit, exclude);
      } catch (e) {
        console.warn("[COMP][mapRank] allSearch failed:", e);
      }
      stagePush("allSearch", before, out.length, { q });

      await this.__sleep(120);
    }

    // 2) m.map sniff (한 번만)
    if (out.length < limit && remaining() > 900) {
      const q = variants[0] || q0;
      const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

      const context = await this.__newContext("https://m.map.naver.com/");
      const page = await this.__newLightPage(context, Math.min(remaining(), 6500));

      const buf: string[] = [];
      const onRespMap = async (res: Response) => {
        try {
          const req = res.request();
          const rt = req.resourceType();
          if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

          const u = String(res.url() || "");
          if (!/naver\.com/.test(u)) return;

          const text = await res.text().catch(() => "");
          if (!text) return;

          if (
            !/(placeId|\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/\d{5,12})/.test(text)
          )
            return;

          buf.push(text);
          if (buf.length > 90) buf.shift();
        } catch {}
      };

      const onHttpFail = async (res: Response) => {
        try {
          const st = res.status();
          const u = res.url();
          if (st >= 400 && /naver\.com/.test(u)) console.warn("[COMP][mapRank][HTTP]", st, u);
        } catch {}
      };

      page.on("response", onRespMap);
      page.on("response", onHttpFail);

      const before = out.length;
      try {
        const gotoBudget = Math.min(remaining(), 6000);
        const resp = await page.goto(url, { waitUntil: "domcontentloaded", timeout: gotoBudget }).catch(() => null);
        const st = resp?.status?.() ?? -1;
        if (st >= 400) console.warn("[COMP][mapRank] m.map goto status", st, url);

        await page.waitForTimeout(Math.min(700, remaining()));

        const mergedText = buf.join("\n");
        let ids = this.__extractPlaceIdsFromAnyTextInOrder(mergedText);

        if (ids.length < 10) {
          const html = await page.content().catch(() => "");
          ids = this.__mergeInOrder(ids, this.__extractPlaceIdsFromAnyTextInOrder(html));
        }

        this.__pushUnique(out, seen, ids, limit, exclude);
        stagePush("m.map_sniff", before, out.length, { q, httpStatus: st });
      } catch (e) {
        console.warn("[COMP][mapRank] m.map sniff failed:", e);
        stagePush("m.map_sniff_failed", before, out.length, { q });
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

    // 3) m.place / pc place fallback
    for (const q of variants) {
      if (out.length >= limit) break;
      if (remaining() < 900) break;

      {
        const before = out.length;
        try {
          const ids = await this.__findTopPlaceIdsViaMPlaceSearchHtml(q, limit + 80, Math.min(2500, remaining()));
          this.__pushUnique(out, seen, ids, limit, exclude);
        } catch {}
        stagePush("m.place_fetch", before, out.length, { q });
      }

      if (out.length < limit && remaining() > 1400) {
        const before = out.length;
        try {
          const ids = await this.__findTopPlaceIdsViaMPlaceSearchRendered(q, limit + 120, Math.min(7500, remaining()));
          this.__pushUnique(out, seen, ids, limit, exclude);
        } catch {}
        stagePush("m.place_render", before, out.length, { q });
      }

      if (out.length < limit && remaining() > 1100) {
        const before = out.length;
        try {
          const ids = await this.__findTopPlaceIdsViaPcPlaceSearchHtml(q, limit + 120, Math.min(2500, remaining()));
          this.__pushUnique(out, seen, ids, limit, exclude);
        } catch {}
        stagePush("pc.place_fetch", before, out.length, { q });
      }

      if (out.length < limit && remaining() > 1400) {
        const before = out.length;
        try {
          const ids = await this.__findTopPlaceIdsViaPcPlaceSearchRendered(q, limit + 180, Math.min(8500, remaining()));
          this.__pushUnique(out, seen, ids, limit, exclude);
        } catch {}
        stagePush("pc.place_render", before, out.length, { q });
      }

      await this.__sleep(120);
    }

    // 4) ✅ 최후 보루: where=place (id 확보용, name은 오염 방지로 거의 비움)
    if (out.length < limit && remaining() > 900) {
      for (const q of variants) {
        if (out.length >= limit) break;
        if (remaining() < 650) break;

        {
          const before = out.length;
          try {
            const metas1 = await this.__findTopPlaceMetasFromSearchWherePlaceFetch(q, Math.min(2500, remaining()));
            const ids1 = metas1.map((m) => m.placeId).filter((id) => this.__isValidPlaceId(id));
            this.__pushUnique(out, seen, ids1, limit, exclude);
          } catch {}
          stagePush("where=place_fetch", before, out.length, { q });
        }

        if (out.length < limit && remaining() > 1300) {
          const before = out.length;
          try {
            const metas2 = await this.__findTopPlaceMetasFromSearchWherePlaceRendered(q, Math.min(7500, remaining()));
            const ids2 = metas2.map((m) => m.placeId).filter((id) => this.__isValidPlaceId(id));
            this.__pushUnique(out, seen, ids2, limit, exclude);
          } catch {}
          stagePush("where=place_render", before, out.length, { q });
        }

        await this.__sleep(120);
      }
    }

    this.__dbg("top5_result", { query: q0, ids: out.slice(0, limit) });
    return out.slice(0, limit);
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

    const mapIds = await this.findTopPlaceIdsFromMapRank(q, {
      excludePlaceId: exclude,
      limit,
      timeoutMs: Math.min(18000, Math.max(3500, this.__remaining(deadline)))
    }).catch(() => []);

    let candidateMetas: PlaceMeta[] = mapIds.map((id) => ({ placeId: id, name: "" }));

    // mapIds가 0이면 where=place로 id라도 확보
    if (!candidateMetas.length) {
      const remain = Math.min(9000, Math.max(2500, this.__remaining(deadline)));
      const metas =
        (await this.__findTopPlaceMetasFromSearchWherePlaceFetch(q, Math.min(2500, remain)).catch(() => [])) ||
        (await this.__findTopPlaceMetasFromSearchWherePlaceRendered(q, Math.min(7500, remain)).catch(() => []));
      candidateMetas = (metas || []).slice(0, limit);
    }

    candidateMetas = candidateMetas
      .map((x) => ({ placeId: this.__normPlaceId(x.placeId), name: this.__cleanText(x.name || "") }))
      .filter((x) => this.__isValidPlaceId(x.placeId))
      .filter((x) => !(exclude && x.placeId === exclude))
      .slice(0, limit);

    // ✅ name 오염 방지: 여기서도 한번 더 정리 (banned면 공백)
    candidateMetas = candidateMetas.map((m) => ({ placeId: m.placeId, name: this.__isBannedName(m.name) ? "" : m.name }));

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

      let finalName = this.__stripNaverSuffix(enriched?.name || candidateMetas[i].name || "");
      finalName = this.__cleanText(finalName);
      if (this.__isBannedName(finalName)) finalName = "";
      if (!finalName) finalName = `place_${pid}`;

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
  // ✅ place home: 대표키워드 추출
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

  /**
   * ✅ 변경 핵심:
   * - 대표키워드: query param 기반만 채택
   *   1) frame/page DOM에서 query링크 탐색
   *   2) 실패 시: 네트워크 응답 body에서 query/q 파라미터만 “문자열 스캔”으로 추출 (query-param 원칙 유지)
   */
    private async __renderAndExtractFromPlaceHome(url: string, timeoutMs: number): Promise<PlaceHomeExtract> {
    const netState: {
      name: string;
      keywords: string[];
      kwSource:
        | "query_links_frame"
        | "query_links_page"
        | "query_sniff"
        | "json_sniff_fallback"
        | "regex_fallback"
        | "none";
    } = { name: "", keywords: [], kwSource: "none" };

    let loaded = false;

    const context = await this.__newContext("https://m.place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    // ✅ query-param 스캔용 버퍼
    const queryBuf: string[] = [];
    // ✅ json keywordList fallback 버퍼
    const jsonKeywordBuf: string[] = [];

    const sniffJsonKeywords = (j: any): string[] => {
      const keys = [
        "representKeywordList",
        "representativeKeywordList",
        "representKeywords",
        "representativeKeywords",
        "keywordList",
        "keywords"
      ];
      for (const k of keys) {
        const arr = this.__deepFindStringArray(j, k);
        if (arr?.length) return arr;
      }
      return [];
    };

    const extractQueryParamKeywordsFromAnyText = (text: string): string[] => {
      const s = String(text || "");
      if (!s) return [];

      const out: string[] = [];
      const seen = new Set<string>();

      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t) ||
        /^(내비게이션|네비게이션|navigation)$/i.test(t) ||
        /(로그인|동의|확인|취소|닫기)/i.test(t);

      const isPromoLike = (t: string) => /(원|만원|%|할인|쿠폰|이벤트|특가)/.test(t) && /\d/.test(t);

      const push = (raw: string) => {
        const v = this.__cleanText(raw).replace(/^#/, "").trim();
        if (!v) return;
        if (v.length < 2 || v.length > 25) return;
        if (isNoise(v)) return;
        if (isPromoLike(v)) return;

        const key = this.__normNoSpace(v);
        if (!key || seen.has(key)) return;
        seen.add(key);
        out.push(v);
      };

      // URL-like 조각에서 query/q 값만
      const urlLike = s.match(/(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\b/g) || [];
      for (const u0 of urlLike) {
        if (!/(query=|[?&]q=)/i.test(u0)) continue;
        try {
          const u = new URL(u0, "https://m.place.naver.com/");
          const q = u.searchParams.get("query") || u.searchParams.get("q") || "";
          if (q) push(decodeURIComponent(q));
        } catch {
          const m = u0.match(/[?&](?:query|q)=([^&]+)/i);
          if (m?.[1]) {
            try {
              push(decodeURIComponent(m[1]));
            } catch {
              push(m[1]);
            }
          }
        }
        if (out.length >= 16) break;
      }

      // JSON-ish: "query":"..."
      if (out.length < 5) {
        const reJson = /["'](?:query|q)["']\s*:\s*["']([^"']{2,60})["']/gi;
        for (const m of s.matchAll(reJson)) {
          push(m[1] || "");
          if (out.length >= 16) break;
        }
      }

      return out.slice(0, 16);
    };

    const onRespSniff = async (res: Response) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch" && rt !== "script") return;

        const u = String(res.url() || "");
        if (!/naver\.com/.test(u)) return;

        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 30) return;
        if (/<!doctype html/i.test(txt)) return;

        // 1) query param 흔적 버퍼
        if (/(query=|[?&]q=)/i.test(txt)) {
          queryBuf.push(txt);
          if (queryBuf.length > 60) queryBuf.shift();
        }

        // 2) json keywordList fallback 버퍼(최후 fallback용)
        if (/(keywordList|representKeyword|representativeKeyword|keywords)/i.test(txt)) {
          const j = this.__safeJsonParse(txt);
          if (j) {
            if (!netState.name) {
              const nm = this.__deepFindName(j);
              if (nm && !this.__isBannedName(nm)) netState.name = nm;
            }
            const arr = sniffJsonKeywords(j);
            if (arr.length) {
              // 그대로 저장해두고, 최후에만 사용
              jsonKeywordBuf.push(JSON.stringify(arr));
              if (jsonKeywordBuf.length > 30) jsonKeywordBuf.shift();
            }
          }
        }
      } catch {}
    };

    page.on("response", onRespSniff);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);

      const status = resp?.status?.() ?? -1;
      const finalUrl = page.url();
      const outer = await page.content().catch(() => "");
      loaded = status === 200 && outer.length > 500;

      const nextOuter = this.__parseNextData(outer);
      if (nextOuter && !netState.name) {
        const nm = this.__deepFindName(nextOuter);
        if (nm && !this.__isBannedName(nm)) netState.name = nm;
      }

      const frame = await this.__resolveEntryFrame(page, timeoutMs);

      // 1) frame DOM query-links
      if (frame) {
        await this.__expandAndScrollFrame(frame, timeoutMs).catch(() => {});
        const kw1 = await this.__extractKeywordsFromQueryLinks(frame).catch(() => []);
        if (kw1.length) {
          netState.keywords = kw1;
          netState.kwSource = "query_links_frame";
        }
      }

      // 2) page DOM query-links
      if (!netState.keywords.length) {
        const kw2 = await this.__extractKeywordsFromPageDomQueryLinks(page).catch(() => []);
        if (kw2.length) {
          netState.keywords = kw2;
          netState.kwSource = "query_links_page";
        }
      }

      // 3) query-param sniff (HTML + frameHTML + response bodies)
      if (!netState.keywords.length) {
        const frameHtml = frame ? await frame.content().catch(() => "") : "";
        const merged = [outer, frameHtml, queryBuf.join("\n")].filter(Boolean).join("\n");
        const kw3 = extractQueryParamKeywordsFromAnyText(merged);
        if (kw3.length) {
          netState.keywords = kw3;
          netState.kwSource = "query_sniff";
        }
      }

      // 4) ✅ 최후 fallback: json keywordList sniff (query param이 “진짜 0개”일 때만)
      if (!netState.keywords.length && jsonKeywordBuf.length) {
        const mergedJsonArrText = jsonKeywordBuf.join("\n");
        // jsonKeywordBuf에는 stringify된 배열이 있으니 regex로 문자열만 뽑아도 됨
        const byRe = this.__extractKeywordArrayByRegex(mergedJsonArrText);
        if (byRe.length) {
          netState.keywords = byRe;
          netState.kwSource = "json_sniff_fallback";
        }
      }

      // 5) 마지막 regex fallback (frame/page HTML에서 keywordList 직접)
      if (!netState.keywords.length) {
        const frameHtml = frame ? await frame.content().catch(() => "") : "";
        const byRe = this.__extractKeywordArrayByRegex([outer, frameHtml].join("\n"));
        if (byRe.length) {
          netState.keywords = byRe;
          netState.kwSource = "regex_fallback";
        }
      }

      if (!netState.name) {
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
        const og = m1?.[1] ? this.__cleanText(m1[1]) : "";
        if (og && !this.__isBannedName(og)) netState.name = og;
      }

      const cleanedName = this.__stripNaverSuffix(netState.name);
      const finalName = this.__cleanText(cleanedName);
      const cleanedKeywords = this.__finalizeKeywords(netState.keywords, finalName);

      console.log("[COMP][placeHome] extracted", {
        finalUrl,
        name: finalName,
        kwCount: cleanedKeywords.length,
        keywordSource: netState.kwSource,
        keywords: cleanedKeywords
      });

      return { name: finalName, keywords: cleanedKeywords, loaded };
    } catch {
      return { name: "", keywords: [], loaded: false };
    } finally {
      try {
        page.off("response", onRespSniff);
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
      .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(6500, timeoutMs) })
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

    const steps = 12;
    for (let i = 0; i < steps; i++) {
      try {
        await frame.evaluate((ratio: number) => {
          const d: any = (globalThis as any).document;
          if (!d) return;

          const root = d.scrollingElement || d.documentElement || d.body;
          if (root && root.scrollHeight) root.scrollTop = Math.floor(root.scrollHeight * ratio);
        }, (i + 1) / steps);
      } catch {}
      await frame.waitForTimeout(220).catch(() => {});
    }
  }

  // ==========================
  // ✅ 대표키워드: query= 링크 기반 (+ query param 값도 추출)
  // ✅ 강화: a[href] 뿐 아니라 data-href/data-url/onclick/script 안의 URL도 스캔
  // ==========================
  private async __extractKeywordsFromQueryLinks(frame: Frame): Promise<string[]> {
    const raw: string[] = await frame.evaluate(() => {
      const d: any = (globalThis as any).document;
      const out: string[] = [];
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const norm = (t: any) => clean(t).replace(/^#/, "");

      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t) ||
        /^(내비게이션|네비게이션|navigation)$/i.test(t) ||
        /(로그인|동의|확인|취소|닫기)/i.test(t);

      const isPromoLike = (s: string) => /(원|만원|%|할인|쿠폰|이벤트|특가)/.test(s) && /\d/.test(s);

      const tryPush = (t: string) => {
        const s = norm(t);
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        if (isNoise(s)) return;
        if (isPromoLike(s)) return;
        out.push(s);
      };

      const base = (() => {
        try {
          return String(d?.baseURI || "https://m.place.naver.com/");
        } catch {
          return "https://m.place.naver.com/";
        }
      })();

      const parseQueryParamFromUrl = (href: string): string => {
        const h = String(href || "").trim();
        if (!h) return "";
        try {
          const u = new URL(h, base);
          const q = u.searchParams.get("query") || u.searchParams.get("q") || "";
          return decodeURIComponent(q || "").trim();
        } catch {
          const m = h.match(/[?&](?:query|q)=([^&]+)/i);
          if (!m?.[1]) return "";
          try {
            return decodeURIComponent(m[1]).trim();
          } catch {
            return String(m[1] || "").trim();
          }
        }
      };

      // ✅ URL 문자열에서 query/q 뽑기 (문자열 안에 URL이 여러 개 있어도 다 뽑음)
      const extractFromTextBlob = (blob: string) => {
        const s = String(blob || "");
        if (!s) return;

        // URL-like 조각에서 query/q 있는 것만
        const re = /(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\b/g;
        const urls = s.match(re) || [];
        for (const u of urls) {
          if (!/(query=|[?&]q=)/i.test(u)) continue;
          const qp = parseQueryParamFromUrl(u);
          if (qp) tryPush(qp);
          if (out.length >= 20) break;
        }
      };

      // 1) a[href] + data-href/data-url/onclick 등 "속성 기반 URL" 전수 스캔
      const nodes: any[] = Array.from(d.querySelectorAll("*"));
      const urlAttrs = ["href", "data-href", "data-url", "data-link", "onclick"];

      for (const el of nodes) {
        if (out.length >= 20) break;

        for (const attr of urlAttrs) {
          const v = clean(el?.getAttribute?.(attr));
          if (!v) continue;
          if (!/(query=|[?&]q=)/i.test(v)) continue;

          const qp = parseQueryParamFromUrl(v);
          if (qp) tryPush(qp);

          // 텍스트도 보조로 (단, 노이즈/프로모션 컷)
          const txt = clean(el?.innerText || el?.textContent);
          if (txt && !isNoise(txt) && !isPromoLike(txt)) tryPush(txt);

          if (out.length >= 20) break;
        }
      }

      // 2) script 내부에서 query/q URL 흔적 스캔 (keywordList JSON은 안 봄. URL만 봄)
      if (out.length < 5) {
        const scripts: any[] = Array.from(d.querySelectorAll("script"));
        for (const sc of scripts) {
          if (out.length >= 20) break;
          const t = sc && (sc.textContent || "");
          if (!t) continue;
          if (!/(query=|[?&]q=)/i.test(t)) continue;
          extractFromTextBlob(t);
        }
      }

      // 3) 마지막 안전장치: document HTML에서 query/q URL만 스캔
      if (out.length < 5) {
        const html = d.documentElement ? d.documentElement.outerHTML : "";
        if (html && /(query=|[?&]q=)/i.test(html)) extractFromTextBlob(html);
      }

      const uniq: string[] = [];
      const seen = new Set<string>();
      for (const s of out) {
        const k = s.replace(/\s+/g, "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      return uniq.slice(0, 16);
    });

    return raw;
  }

  private async __extractKeywordsFromPageDomQueryLinks(page: Page): Promise<string[]> {
    const raw: string[] = await page.evaluate(() => {
      const d: any = (globalThis as any).document;
      const out: string[] = [];
      if (!d) return out;

      const clean = (t: any) => String(t ?? "").replace(/\s+/g, " ").trim();
      const norm = (t: any) => clean(t).replace(/^#/, "");

      const isNoise = (t: string) =>
        /^(저장|공유|길찾기|전화|예약|리뷰|사진|홈|메뉴|가격|더보기|쿠폰|이벤트|알림받기)$/i.test(t) ||
        /(방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|별점|평점)/i.test(t) ||
        /^(내비게이션|네비게이션|navigation)$/i.test(t) ||
        /(로그인|동의|확인|취소|닫기)/i.test(t);

      const isPromoLike = (s: string) => /(원|만원|%|할인|쿠폰|이벤트|특가)/.test(s) && /\d/.test(s);

      const tryPush = (t: string) => {
        const s = norm(t);
        if (!s) return;
        if (s.length < 2 || s.length > 25) return;
        if (isNoise(s)) return;
        if (isPromoLike(s)) return;
        out.push(s);
      };

      const base = (() => {
        try {
          return String(d?.baseURI || "https://m.place.naver.com/");
        } catch {
          return "https://m.place.naver.com/";
        }
      })();

      const parseQueryParamFromUrl = (href: string): string => {
        const h = String(href || "").trim();
        if (!h) return "";
        try {
          const u = new URL(h, base);
          const q = u.searchParams.get("query") || u.searchParams.get("q") || "";
          return decodeURIComponent(q || "").trim();
        } catch {
          const m = h.match(/[?&](?:query|q)=([^&]+)/i);
          if (!m?.[1]) return "";
          try {
            return decodeURIComponent(m[1]).trim();
          } catch {
            return String(m[1] || "").trim();
          }
        }
      };

      const extractFromTextBlob = (blob: string) => {
        const s = String(blob || "");
        if (!s) return;
        const re = /(https?:\/\/[^\s"'<>]+|\/[^\s"'<>]+)\b/g;
        const urls = s.match(re) || [];
        for (const u of urls) {
          if (!/(query=|[?&]q=)/i.test(u)) continue;
          const qp = parseQueryParamFromUrl(u);
          if (qp) tryPush(qp);
          if (out.length >= 20) break;
        }
      };

      const nodes: any[] = Array.from(d.querySelectorAll("*"));
      const urlAttrs = ["href", "data-href", "data-url", "data-link", "onclick"];

      for (const el of nodes) {
        if (out.length >= 20) break;

        for (const attr of urlAttrs) {
          const v = clean(el?.getAttribute?.(attr));
          if (!v) continue;
          if (!/(query=|[?&]q=)/i.test(v)) continue;

          const qp = parseQueryParamFromUrl(v);
          if (qp) tryPush(qp);

          const txt = clean(el?.innerText || el?.textContent);
          if (txt && !isNoise(txt) && !isPromoLike(txt)) tryPush(txt);

          if (out.length >= 20) break;
        }
      }

      if (out.length < 5) {
        const scripts: any[] = Array.from(d.querySelectorAll("script"));
        for (const sc of scripts) {
          if (out.length >= 20) break;
          const t = sc && (sc.textContent || "");
          if (!t) continue;
          if (!/(query=|[?&]q=)/i.test(t)) continue;
          extractFromTextBlob(t);
        }
      }

      if (out.length < 5) {
        const html = d.documentElement ? d.documentElement.outerHTML : "";
        if (html && /(query=|[?&]q=)/i.test(html)) extractFromTextBlob(html);
      }

      const uniq: string[] = [];
      const seen = new Set<string>();
      for (const s of out) {
        const k = s.replace(/\s+/g, "");
        if (!k || seen.has(k)) continue;
        seen.add(k);
        uniq.push(s);
      }
      return uniq.slice(0, 16);
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
      .filter(
        (k) =>
          !/(알림받기|방문자\s*리뷰|방문자리뷰|블로그\s*리뷰|블로그리뷰|리뷰\s*\d+|별점|평점|지도|저장|공유|길찾기|전화|예약|문의|쿠폰|이벤트|할인|내비게이션|네비게이션|navigation)/i.test(
            k
          )
      )
      .filter((k) => !/^(홈|메뉴|가격|리뷰|사진|소개|소식|예약)$/i.test(k))
      .filter((k) => !/^(미용실|헤어샵|헤어살롱|커트|컷)$/i.test(k))
      .filter((k) => !/(로그인|동의|확인|취소|닫기)/i.test(k))
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
      if (ids.length >= 250) break;
    }

    if (ids.length < 10) {
      const rePlaceId = /placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g;
      for (const m of s.matchAll(rePlaceId)) {
        const id = this.__normPlaceId(m[1]);
        if (!id || seen.has(id)) continue;
        if (!this.__isValidPlaceId(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 250) break;
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
        if (ids.length >= 250) break;
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
