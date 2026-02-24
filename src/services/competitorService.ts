// src/services/competitorService.ts
import { chromium, type Browser } from "playwright";

type FindTopIdsOptions = {
  excludePlaceId?: string;
  limit?: number;
};

type Competitor = {
  placeId: string;
  name: string;
  keywords: string[];
  source: "map_rank" | "place_home";
  rank: number;
};

type FindTopCompetitorsOpts = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number; // 전체 예산(상한)
};

export class CompetitorService {
  private browser: Browser | null = null;

  // ==========================
  // Browser lifecycle
  // ==========================
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
  // ✅ 1) 지도(=실제 노출) TOP placeId 추출
  // - 응답(JSON/텍스트) 스니핑 + HTML 보조
  // ==========================
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

    // 리소스 절약: 문서/스크립트/xhr/fetch만
    await page.route("**/*", (route) => {
      const req = route.request();
      const rtype = req.resourceType();
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") return route.continue();
      return route.abort();
    });

    const gotoTimeoutMs = Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000);
    page.setDefaultTimeout(gotoTimeoutMs);

    // ✅ 응답 스니핑 버퍼
    const buf: string[] = [];
    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const ct = (await res.headerValue("content-type")) || "";
        // 지도는 json 뿐 아니라 text/javascript 로 내려오는 경우도 있음
        if (!/json|javascript|text/i.test(ct)) return;

        const text = await res.text().catch(() => "");
        if (!text) return;

        // placeId or /place/123
        if (!/placeId|\/place\/\d{5,12}/.test(text)) return;

        buf.push(text);
        if (buf.length > 40) buf.shift();
      } catch {}
    };

    page.on("response", onResponse);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // 지도 검색 로딩 대기
      await page.waitForTimeout(1100);

      const mergedText = buf.join("\n");
      let ids = this.__extractPlaceIdsFromAnyTextInOrder(mergedText);

      // 부족하면 html 보조
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
    } catch {
      return [];
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
  // ✅ 2) 메인: “지도 TOP5” 기반 경쟁사 추출 + 대표키워드 크롤링
  // ==========================
  public async findTopCompetitorsByKeyword(keyword: string, opts: FindTopCompetitorsOpts = {}): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = String(opts.excludePlaceId || "").trim();

    const totalTimeoutMs = Math.max(
      7000,
      Math.min(45000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 12000))
    );
    const deadline = Date.now() + totalTimeoutMs - 250;

    // ✅ TOP5는 “지도”에서만
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, { excludePlaceId: exclude, limit }).catch(() => []);

    if (!mapIds.length) return [];

    // ✅ enrich 병렬 제한
    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    // ✅ 병렬로 돌리되, 전체 예산 내에서 끊기게
    const tasks = mapIds.slice(0, limit).map((pid) =>
      runLimited(async () => {
        const remaining = Math.max(2500, Math.min(15000, deadline - Date.now()));
        return await this.__fetchPlaceHomeAndExtract(pid, remaining);
      }).catch(() => ({ name: "", keywords: [] }))
    );

    const results: Array<{ placeId: string; name: string; keywords: string[] }> = [];
    for (let i = 0; i < tasks.length; i++) {
      if (Date.now() > deadline) break;
      const remaining = Math.max(1, deadline - Date.now());
      const r = await this.__withTimeout(tasks[i], remaining).catch(() => ({ name: "", keywords: [] }));
      results.push({ placeId: mapIds[i], name: r?.name || "", keywords: Array.isArray(r?.keywords) ? r.keywords : [] });
    }

    const out: Competitor[] = [];
    for (let i = 0; i < results.length && out.length < limit; i++) {
      const pid = mapIds[i];
      const r = results[i];

      out.push({
        placeId: pid,
        name: this.__cleanText(r?.name || "") || "",
        keywords: this.__cleanKeywords(r?.keywords || []).slice(0, 5),
        source: "place_home",
        rank: out.length + 1
      });
    }

    return out;
  }

  // ==========================
  // ✅ place home: 업종 경로 후보 → iframe + (네트워크 스니핑) + DOM fallback
  // ==========================
  private async __fetchPlaceHomeAndExtract(placeId: string, timeoutMs: number): Promise<{ name: string; keywords: string[] }> {
    const pid = String(placeId).trim();
    if (!pid) return { name: "", keywords: [] };

    const candidates = [
      `https://m.place.naver.com/hairshop/${pid}/home`,
      `https://m.place.naver.com/restaurant/${pid}/home`,
      `https://m.place.naver.com/cafe/${pid}/home`,
      `https://m.place.naver.com/place/${pid}/home`
    ];

    // 각 후보는 너무 오래 끌지 않게 분할 예산
    const perTry = Math.max(2500, Math.min(12000, Math.floor(timeoutMs / Math.max(1, candidates.length)) + 1500));

    let best: { name: string; keywords: string[] } = { name: "", keywords: [] };

    for (const url of candidates) {
      const r = await this.__renderAndExtractFromPlaceHome(url, perTry);
      // keywords 있으면 확정
      if (r.keywords.length) return r;
      // name만이라도 확보해두기
      if (r.name && !best.name) best.name = r.name;
    }

    return best;
  }

  private async __renderAndExtractFromPlaceHome(
    url: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[] }> {
    let context: any = null;
    let page: any = null;

    // 네트워크에서 키워드가 오는 케이스(그래프QL / apollo state / json)
    const netState = { name: "", keywords: [] as string[] };
    const responseSnippets: string[] = []; // (최후) 문자열 fallback용

    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const ct = (await res.headerValue("content-type")) || "";
        if (!/json|javascript|text/i.test(ct)) return;

        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 20) return;

        // 스니펫 저장(최후 문자열 regex)
        if (/keywordList|representKeywordList|representKeywords|keywords|__APOLLO_STATE__|placeId/.test(txt)) {
          responseSnippets.push(txt);
          if (responseSnippets.length > 25) responseSnippets.shift();
        }

        // JSON parse 가능한 경우만 우선 처리
        let j: any = null;
        try {
          j = JSON.parse(txt);
        } catch {
          // graphql 응답이 JSON이 아닐 수도 있어서 그냥 패스(스니펫은 저장됨)
          return;
        }

        if (!netState.name) {
          const nm = this.__deepFindName(j);
          if (nm) netState.name = nm;
        }

        if (!netState.keywords.length) {
          for (const k of ["keywordList", "representKeywordList", "representKeywords", "keywords"]) {
            const arr = this.__deepFindStringArray(j, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }
      } catch {}
    };

    try {
      const browser = await this.getBrowser();
      context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        viewport: { width: 390, height: 844 },
        locale: "ko-KR"
      });

      page = await context.newPage();

      await page.route("**/*", (route: any) => {
        const req = route.request();
        const rtype = req.resourceType();
        if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") return route.continue();
        return route.abort();
      });

      page.setDefaultTimeout(timeoutMs);
      page.on("response", onResponse);

      await page.goto(url, { waitUntil: "domcontentloaded" });

      // 약간 대기(iframe + xhr 채움)
      await page.waitForTimeout(900);

      // 1) entryIframe 확보 (없을 수도 있음)
      const iframeHandle = await page
        .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(6500, timeoutMs) })
        .catch(() => null);

      let frame: any = null;
      if (iframeHandle) frame = await iframeHandle.contentFrame().catch(() => null);

      // 2) iframe 내부에서 __NEXT_DATA__ 먼저
      let frameHtml = "";
      if (frame) {
        await frame.waitForLoadState("domcontentloaded").catch(() => {});
        // next data script가 늦게 생기는 케이스
        await frame.waitForSelector('script#__NEXT_DATA__', { timeout: Math.min(5500, timeoutMs) }).catch(() => {});
        frameHtml = await frame.content().catch(() => "");
      }

      let name = "";
      let keywords: string[] = [];

      // ✅ 우선순위 A: 네트워크 스니핑 (가장 자주 살아남음)
      if (netState.name) name = netState.name;
      if (netState.keywords.length) keywords = netState.keywords;

      // ✅ 우선순위 B: iframe __NEXT_DATA__
      if ((!name || !keywords.length) && frameHtml) {
        const next = this.__parseNextData(frameHtml);
        if (!name) name = this.__deepFindName(next) || name;

        if (!keywords.length) {
          for (const k of ["keywordList", "representKeywordList", "representKeywords", "keywords"]) {
            const arr = this.__deepFindStringArray(next, k);
            if (arr.length) {
              keywords = arr;
              break;
            }
          }
        }

        // next에 없으면 regex fallback
        if (!keywords.length) {
          const fallback = this.__extractKeywordArrayByRegex(frameHtml);
          if (fallback.length) keywords = fallback;
        }
      }

      // ✅ 우선순위 C: response snippets regex (graphql/apollo 등)
      if (!keywords.length && responseSnippets.length) {
        const merged = responseSnippets.join("\n");
        const fallback = this.__extractKeywordArrayByRegex(merged);
        if (fallback.length) keywords = fallback;
      }

      // ✅ 우선순위 D: DOM 직접 긁기(칩/태그)
      if (frame && !keywords.length) {
        const domKeywords = await this.__extractKeywordsFromDom(frame).catch(() => []);
        if (domKeywords.length) keywords = domKeywords;
      }

      // name fallback: og:title
      if (!name) {
        const outer = await page.content().catch(() => "");
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,120})["']/);
        if (m1?.[1]) name = this.__cleanText(m1[1]);
      }

      return { name: this.__cleanText(name), keywords: this.__cleanKeywords(keywords).slice(0, 5) };
    } catch {
      return { name: "", keywords: [] };
    } finally {
      try {
        if (page) {
          page.off("response", onResponse);
          await page.close();
        }
      } catch {}
      try {
        if (context) await context.close();
      } catch {}
    }
  }

  // ==========================
  // ✅ DOM 기반 대표키워드 추출(iframe 내부) - 서버 TS(Non-DOM lib) 안전
  // ==========================
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

      // 대표키워드 “칩”은 a/button/span/div에 박히는 경우가 많음
      const selectors = [
        'a[role="button"]',
        'a[href*="query="]',
        'button',
        'span',
        'div'
      ];

      const LIMIT = 700;
      const nodeSet: any[] = [];
      for (const sel of selectors) {
        try {
          const nodes = Array.from(d.querySelectorAll(sel));
          for (const n of nodes) {
            nodeSet.push(n);
            if (nodeSet.length >= LIMIT) break;
          }
        } catch {}
        if (nodeSet.length >= LIMIT) break;
      }

      for (const el of nodeSet) {
        const t = (el?.innerText ?? el?.textContent ?? "") as any;
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
      if (/(미용실|헤어|살롱|펌|염색|커트|컷|클리닉|카페|맛집|식당|디저트|브런치)/.test(s)) sc += 2;
      if (/[가-힣]/.test(s)) sc += 1;
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
  // helpers
  // ==========================
  private __cleanKeywords(list: string[]): string[] {
    return (Array.isArray(list) ? list : [])
      .map((k) => this.__cleanText(k))
      .filter(Boolean)
      .filter((k) => k.length >= 2 && k.length <= 25)
      .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
      .slice(0, 10);
  }

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
      const strs = arr.map((v: any) => this.__cleanText(String(v ?? ""))).filter(Boolean);
      if (strs.length) return Array.from(new Set(strs));
    }
    return [];
  }

  private __deepFindName(obj: any): string {
    const keyCandidates = ["name", "placeName", "businessName", "title", "storeName"];
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
          if (t && t.length >= 2 && t.length <= 80) return t;
        }
      }
    }
    return "";
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

  /**
   * ✅ 문자열에서 대표키워드 배열 추출 (Next/GraphQL/HTML/스니펫 공용)
   */
  private __extractKeywordArrayByRegex(text: string): string[] {
    const src = String(text || "");

    // 1) "representKeywordList":["a","b"] 형태
    const re1 = /"(?:representKeywordList|keywordList|representKeywords|keywords)"\s*:\s*\[([^\]]{1,5000})\]/g;
    for (const m of src.matchAll(re1)) {
      const inside = m[1] || "";
      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean);

      const cleaned = this.__cleanKeywords(strs);
      if (cleaned.length) return Array.from(new Set(cleaned));
    }

    return [];
  }

  /**
   * ✅ 어떤 텍스트든 placeId를 “등장 순서대로” 뽑기 (map 응답/HTML 공용)
   */
  private __extractPlaceIdsFromAnyTextInOrder(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();
    const src = String(text || "");

    for (const m of src.matchAll(/\/place\/(\d{5,12})/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 120) break;
    }

    if (ids.length < 10) {
      for (const m of src.matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
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
      if (!x || seen.has(x)) continue;
      seen.add(x);
      out.push(x);
    }
    return out;
  }
}
