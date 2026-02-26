/* src/services/competitorService.ts
   Naver Place Optimizer - Competitor Service (FINAL SINGLE FILE)
   Env: Node18 + TypeScript + Playwright (headless)
   tsconfig: lib=["ES2020"] (NO DOM LIB)
*/

import type { Browser, Page, Response } from "playwright";

export type CompetitorMeta = {
  rank: number;
  placeId: string;
  name: string;
  keywords: string[];
  kwCount: number;
  source?: string; // "mapSearch2" | "placeSearch" | "allSearch" | "unknown"
};

export type FindCompetitorsParams = {
  query: string;
  myPlaceId?: string;
  topN?: number; // default 5
  timeoutMs?: number; // default 12000
  remainingMs?: number; // just for logging; optional
  existingPage?: Page; // if you already have a shared page/context, pass it
  locale?: "ko-KR" | string;
};

type Logger = {
  log: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
};

const DEFAULT_CENTER = {
  // Seoul City Hall (safe default)
  x: "126.9783882",
  y: "37.5666103",
};

const NAVER_MOBILE_UA =
  "Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function normalizeKeyword(s: string) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/[·•ㆍ]+/g, " ")
    .replace(/[^\p{L}\p{N}\s#\-_.]/gu, " ")
    .trim();
}

/** Strong noise filter tuned for Naver Place pages */
function isNoiseKeyword(k: string) {
  const s = normalizeKeyword(k);
  if (!s) return true;

  // too short / too long
  if (s.length < 2) return true;
  if (s.length > 22) return true;

  // purely numeric or mostly numeric
  if (/^\d+$/.test(s)) return true;
  if (/^\d+(\.\d+)?(km|m|분|초|개|명|원|%|회)$/i.test(s)) return true;

  // common UI / navigation noise
  const noisePatterns: RegExp[] = [
    /^(홈|정보|리뷰|사진|동영상|메뉴|가격|예약|전화|길찾기|지도|공유|저장|더보기)$/i,
    /(이전|다음)페이지/i,
    /(사진|동영상|리뷰|블로그)\s*\d+\s*(개|건|개+)/i,
    /(영업|휴무|휴일|브레이크)\s*(시간|중)/i,
    /(주차|무선인터넷|화장실|반려동물|포장|배달|단체|예약가능)/i,
    /(네이버|플레이스|스마트플레이스|N예약|N페이)/i,
    /(대표|추천)\s*(키워드)?\s*없음/i,
    /(로드뷰|거리뷰|위성|교통)/i,
    /(업데이트|수정|신고|제보)/i,
  ];
  for (const re of noisePatterns) {
    if (re.test(s)) return true;
  }

  // emojis / weird remnants
  if (/[\u{1F300}-\u{1FAFF}]/u.test(s)) return true;

  return false;
}

function cleanKeywords(raw: string[], max: number) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k0 of raw) {
    const k = normalizeKeyword(k0);
    if (isNoiseKeyword(k)) continue;
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= max) break;
  }
  return out;
}

/** Extract placeIds from any text/html/json string */
function extractPlaceIdsFromText(text: string): string[] {
  if (!text) return [];
  const ids = new Set<string>();

  // placeId: "123"
  const re1 = /placeId["']?\s*[:=]\s*["'](\d{5,})["']/g;
  let m: RegExpExecArray | null;
  while ((m = re1.exec(text))) ids.add(m[1]);

  // /place/123 or /hairshop/123
  const re2 = /\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|clinic)\/(\d{5,})/g;
  while ((m = re2.exec(text))) ids.add(m[1]);

  // m.place.naver.com/place/123
  const re3 = /m\.place\.naver\.com\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|clinic|beauty)\/(\d{5,})/g;
  while ((m = re3.exec(text))) ids.add(m[1]);

  // "id":"123" near "place"
  const re4 = /"id"\s*:\s*"(\d{5,})"\s*,\s*"type"\s*:\s*"(?:place|business)"/g;
  while ((m = re4.exec(text))) ids.add(m[1]);

  return Array.from(ids);
}

/** Deep-walk JSON and collect likely keyword strings */
function deepCollectKeywords(node: any, out: string[], depth = 0) {
  if (!node || depth > 14) return;

  if (typeof node === "string") {
    // don't add arbitrary strings; only accept if caller explicitly passes string arrays
    return;
  }

  if (Array.isArray(node)) {
    for (const v of node) deepCollectKeywords(v, out, depth + 1);
    return;
  }

  if (typeof node === "object") {
    // If object looks like keyword item
    const candidates: any[] = [];

    // common fields
    const keys = Object.keys(node);
    for (const k of keys) {
      const lk = k.toLowerCase();

      if (lk.includes("keyword") || lk.includes("tag") || lk.includes("hash")) {
        candidates.push(node[k]);
      }
      // Naver sometimes uses "name" / "text" in keyword list nodes
      if (lk === "name" || lk === "text" || lk === "title") {
        candidates.push(node[k]);
      }
    }

    for (const c of candidates) {
      if (typeof c === "string") out.push(c);
      else if (Array.isArray(c)) {
        for (const v of c) {
          if (typeof v === "string") out.push(v);
          else if (v && typeof v === "object") {
            // typical forms: { keyword: "..." } / { name: "..." } / { text: "..." }
            if (typeof v.keyword === "string") out.push(v.keyword);
            if (typeof v.name === "string") out.push(v.name);
            if (typeof v.text === "string") out.push(v.text);
            if (typeof v.title === "string") out.push(v.title);
          }
        }
      } else if (c && typeof c === "object") {
        if (typeof c.keyword === "string") out.push(c.keyword);
        if (typeof c.name === "string") out.push(c.name);
        if (typeof c.text === "string") out.push(c.text);
      }
    }

    // continue deep
    for (const k of keys) deepCollectKeywords(node[k], out, depth + 1);
  }
}

/** Parse __NEXT_DATA__ from HTML */
function extractNextDataJson(html: string): any | null {
  if (!html) return null;
  const m = html.match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i
  );
  if (!m || !m[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function safeGoto(page: Page, url: string, timeoutMs: number) {
  const attempts = 2;
  let lastErr: any = null;

  for (let i = 0; i < attempts; i++) {
    try {
      const resp = await page.goto(url, {
        waitUntil: "domcontentloaded",
        timeout: timeoutMs,
      });
      if (!resp) return { ok: false, status: 0, url, finalUrl: page.url(), title: "", htmlLen: 0 };

      // Some Naver pages return 200 but block content sometimes; still try.
      const status = resp.status();
      const title = await page.title().catch(() => "");
      const html = await page.content().catch(() => "");
      return {
        ok: status >= 200 && status < 400,
        status,
        url,
        finalUrl: page.url(),
        title,
        htmlLen: html.length,
        html,
      };
    } catch (e) {
      lastErr = e;
      await sleep(200 + i * 300);
    }
  }
  return { ok: false, status: 0, url, finalUrl: page.url(), title: "", htmlLen: 0, error: String(lastErr) };
}

async function safeJson(resp: Response): Promise<any | null> {
  try {
    const ct = (await resp.headerValue("content-type")) || "";
    if (!ct.includes("application/json") && !ct.includes("text/json")) {
      // sometimes graphql returns application/json; ok. otherwise ignore.
      // but we still try if url hints json.
      const u = resp.url();
      if (!/graphql|api|allSearch|search/i.test(u)) return null;
    }
    return await resp.json();
  } catch {
    return null;
  }
}

function buildPlaceHomeUrl(placeId: string) {
  return `https://m.place.naver.com/place/${placeId}/home`;
}

function buildMapSearch2Url(query: string) {
  const q = encodeURIComponent(query);
  return `https://m.map.naver.com/search2/search.naver?query=${q}`;
}

function buildPlaceSearchUrl(query: string) {
  const q = encodeURIComponent(query);
  return `https://m.place.naver.com/search?query=${q}`;
}

/**
 * Naver map "allSearch" endpoint variant.
 * NOTE: This endpoint shape changes; we make it resilient:
 * - Always include x/y (center)
 * - Try two param formats (searchCoord vs x/y)
 */
function buildAllSearchUrls(query: string, topN: number, center = DEFAULT_CENTER) {
  const q = encodeURIComponent(query);
  const display = clamp(topN, 1, 10);

  // Variant A (searchCoord)
  const u1 =
    `https://map.naver.com/p/api/search/allSearch?` +
    `query=${q}` +
    `&type=place` +
    `&page=1` +
    `&displayCount=${display}` +
    `&isPlaceSearch=true` +
    `&searchCoord=${center.x};${center.y}`;

  // Variant B (x/y)
  const u2 =
    `https://map.naver.com/p/api/search/allSearch?` +
    `query=${q}` +
    `&type=place` +
    `&page=1` +
    `&displayCount=${display}` +
    `&isPlaceSearch=true` +
    `&x=${center.x}` +
    `&y=${center.y}`;

  return [u1, u2];
}

function parseAllSearchPlaceIds(json: any): string[] {
  if (!json) return [];
  // We do broad extraction to survive structure changes
  const raw = JSON.stringify(json);
  return extractPlaceIdsFromText(raw);
}

async function domExtractRepresentativeKeywords(page: Page): Promise<string[]> {
  // DOM fallback (no DOM lib typings; use any)
  try {
    // Try to find keyword chips near "대표키워드"
    const kw = await page.evaluate(() => {
      const txt = (el: any) => (el && el.textContent ? String(el.textContent).trim() : "");
      const normalize = (s: string) => s.replace(/\s+/g, " ").trim();

      const root = document.body;
      if (!root) return [];

      // Find an element containing "대표키워드"
      const candidates: any[] = Array.from(root.querySelectorAll("*"));
      const anchor = candidates.find((el) => normalize(txt(el)) === "대표키워드" || normalize(txt(el)).includes("대표키워드"));
      if (!anchor) return [];

      // Look around the anchor: parent/sibling regions
      const region = anchor.closest("section, article, div") || anchor.parentElement || root;

      // Collect chip-like texts (a/span/button)
      const chips: any[] = Array.from(region.querySelectorAll("a, span, button, div"))
        .slice(0, 200);

      const raw: string[] = [];
      for (const el of chips) {
        const t = normalize(txt(el));
        if (!t) continue;
        // Skip if it's just the label itself
        if (t === "대표키워드") continue;
        // Heuristic: hashtag-like or short phrases
        if (t.startsWith("#")) raw.push(t.slice(1));
        else if (t.length >= 2 && t.length <= 24) raw.push(t);
      }

      return raw;
    });
    if (Array.isArray(kw)) return kw.map((s: any) => String(s));
    return [];
  } catch {
    return [];
  }
}

export class CompetitorService {
  private browser: Browser;
  private logger: Logger;

  constructor(browser: Browser, logger?: Partial<Logger>) {
    this.browser = browser;
    this.logger = {
      log: logger?.log || console.log,
      warn: logger?.warn || console.warn,
      error: logger?.error || console.error,
    };
  }

  /**
   * Main entry:
   * 1) query -> top5 placeIds
   * 2) exclude myPlaceId
   * 3) crawl representative keywords (max 5) for each competitor
   */
  async findTopCompetitorsByKeyword(params: FindCompetitorsParams): Promise<CompetitorMeta[]> {
    const {
      query,
      myPlaceId,
      topN = 5,
      timeoutMs = 12000,
      existingPage,
      locale = "ko-KR",
    } = params;

    const N = clamp(topN, 1, 10);

    let page: Page | null = null;
    let owned = false;

    if (existingPage) {
      page = existingPage;
    } else {
      owned = true;
      const context = await this.browser.newContext({
        locale,
        userAgent: NAVER_MOBILE_UA,
        viewport: { width: 420, height: 900 },
      });
      page = await context.newPage();
    }

    try {
      // 1) TOP placeIds
      const { placeIds, source } = await this.findTopPlaceIds(page!, query, N, timeoutMs);

      // 2) exclude myPlaceId
      const filtered = placeIds.filter((id) => (myPlaceId ? id !== String(myPlaceId) : true));
      const finalIds = filtered.slice(0, N);

      // 3) crawl keywords for each competitor
      const metas: CompetitorMeta[] = [];
      for (let i = 0; i < finalIds.length; i++) {
        const placeId = finalIds[i];
        const rank = i + 1;

        const { name, keywords, kwSource } = await this.crawlPlaceRepresentativeKeywords(
          page!,
          placeId,
          timeoutMs
        );

        metas.push({
          rank,
          placeId,
          name: name || `place_${placeId}`,
          keywords,
          kwCount: keywords.length,
          source: kwSource ? `${source}+${kwSource}` : source,
        });
      }

      return metas;
    } finally {
      if (owned && page) {
        await page.context().close().catch(() => {});
      }
    }
  }

  /**
   * Map rank topN placeId extraction:
   * - Try m.map search2 (fast) but can 500 on Railway
   * - Fallback m.place search
   * - Fallback allSearch (with guaranteed coords)
   */
  private async findTopPlaceIds(
    page: Page,
    query: string,
    topN: number,
    timeoutMs: number
  ): Promise<{ placeIds: string[]; source: string }> {
    const q = query.trim();

    // A) m.map search2
    {
      const url = buildMapSearch2Url(q);
      const r = await safeGoto(page, url, timeoutMs);
      if (r.ok && r.htmlLen > 1000 && r.html) {
        const ids = extractPlaceIdsFromText(r.html);
        if (ids.length) {
          const out = ids.slice(0, topN);
          this.logger.log("[COMP] mapIds:", out);
          return { placeIds: out, source: "mapSearch2" };
        }
      } else {
        // Common: Railway 500
        this.logger.warn("[COMP] mapSearch2 failed:", { status: r.status, url, err: (r as any).error });
      }
    }

    // B) m.place search
    {
      const url = buildPlaceSearchUrl(q);
      const r = await safeGoto(page, url, timeoutMs);
      if (r.ok && r.htmlLen > 1000 && r.html) {
        const ids = extractPlaceIdsFromText(r.html);
        if (ids.length) {
          const out = ids.slice(0, topN);
          this.logger.log("[COMP] placeSearch ids:", out);
          return { placeIds: out, source: "placeSearch" };
        }
      } else {
        this.logger.warn("[COMP] placeSearch failed:", { status: r.status, url, err: (r as any).error });
      }
    }

    // C) allSearch (robust coords)
    {
      const urls = buildAllSearchUrls(q, topN, DEFAULT_CENTER);
      for (const url of urls) {
        try {
          const resp = await page.request.get(url, {
            headers: {
              "user-agent": NAVER_MOBILE_UA,
              "accept": "application/json, text/plain, */*",
              "accept-language": "ko-KR,ko;q=0.9",
              "referer": "https://map.naver.com/",
            },
            timeout: timeoutMs,
          });

          const status = resp.status();
          if (status >= 200 && status < 300) {
            const json = await resp.json().catch(() => null);
            const ids = parseAllSearchPlaceIds(json);
            if (ids.length) {
              const out = ids.slice(0, topN);
              this.logger.log("[COMP] allSearch ids:", out);
              return { placeIds: out, source: "allSearch" };
            }
          } else {
            // 400 searchCoord error etc
            this.logger.warn("[COMP] allSearch non-2xx:", { status, url });
          }
        } catch (e) {
          this.logger.warn("[COMP] allSearch request error:", { url, err: String(e) });
        }
      }
    }

    // D) nothing found
    return { placeIds: [], source: "unknown" };
  }

  /**
   * Representative keywords extraction (max 5)
   * Priority:
   * 1) network JSON sniffing (graphql/api/json)
   * 2) __NEXT_DATA__ parsing
   * 3) DOM fallback near "대표키워드"
   */
  private async crawlPlaceRepresentativeKeywords(
    page: Page,
    placeId: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[]; kwSource: string }> {
    const url = buildPlaceHomeUrl(placeId);

    const collectedFromNetwork: string[] = [];
    let bestName = "";

    // Network listener (single, no duplicate declarations)
    const onResp = async (resp: Response) => {
      const u = resp.url();
      // reduce overhead: only inspect likely endpoints
      if (!/m\.place\.naver\.com|map\.naver\.com|graphql|api|next-data|allSearch|keyword/i.test(u)) return;

      const json = await safeJson(resp);
      if (!json) return;

      // name hints
      try {
        const s = JSON.stringify(json);
        // very rough: title/name fields appear frequently
        const m = s.match(/"name"\s*:\s*"([^"]{2,40})"/);
        if (m && !bestName) bestName = m[1];
      } catch {}

      const raw: string[] = [];
      try {
        deepCollectKeywords(json, raw);
      } catch {}

      if (raw.length) collectedFromNetwork.push(...raw);
    };

    page.on("response", onResp);

    try {
      const g = await safeGoto(page, url, timeoutMs);
      this.logger.log("[COMP][placeHome] goto", {
        status: g.status,
        url,
        finalUrl: g.finalUrl,
        title: g.title,
        htmlLen: g.htmlLen,
      });

      // Give network a tiny window to finish late json
      await page.waitForTimeout(300).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 2500 }).catch(() => {});
      await page.waitForTimeout(150).catch(() => {});
      await sleep(80);

      const html = g.html || (await page.content().catch(() => "")) || "";

      // 1) Network JSON
      const netKeywords = cleanKeywords(collectedFromNetwork, 12); // keep more, we cut to 5 later
      if (netKeywords.length) {
        const keywords = cleanKeywords(netKeywords, 5);
        return {
          name: bestName || "",
          keywords: keywords.length ? keywords : ["대표키워드없음"],
          kwSource: "netJSON",
        };
      }

      // 2) __NEXT_DATA__
      const nd = extractNextDataJson(html);
      if (nd) {
        const raw: string[] = [];
        try {
          deepCollectKeywords(nd, raw);
        } catch {}
        const keywords = cleanKeywords(raw, 5);
        if (keywords.length) {
          return { name: bestName || "", keywords, kwSource: "nextData" };
        }
      }

      // 3) DOM fallback
      const domRaw = await domExtractRepresentativeKeywords(page);
      const domKeywords = cleanKeywords(domRaw, 5);
      if (domKeywords.length) {
        return { name: bestName || "", keywords: domKeywords, kwSource: "dom" };
      }

      return { name: bestName || "", keywords: ["대표키워드없음"], kwSource: "none" };
    } catch (e) {
      this.logger.warn("[COMP][placeHome] crawl error:", String(e));
      return { name: bestName || "", keywords: ["대표키워드없음"], kwSource: "error" };
    } finally {
      page.off("response", onResp);
    }
  }
}

export default CompetitorService;
