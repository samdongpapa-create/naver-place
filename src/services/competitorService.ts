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
  source: "map_rank" | "search_html" | "place_home";
  rank: number;
};

type FindTopCompetitorsOpts = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number; // 전체 예산(상한)
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

  // ==========================
  // ✅ 1) 지도(=실제 노출) TOP placeId 추출
  // - 응답 URL 필터링 + (JSON 파싱 시도) + (텍스트 regex)
  // - "엉뚱한 placeId 섞임" 줄이기
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

    await page.route("**/*", (route) => {
      const req = route.request();
      const rtype = req.resourceType();
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") return route.continue();
      return route.abort();
    });

    const timeoutMs = Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000);
    page.setDefaultTimeout(timeoutMs);

    // ✅ map 응답 버퍼(텍스트) + placeId 버퍼(확정)
    const textBuf: string[] = [];
    const foundIds: string[] = [];
    const foundSet = new Set<string>();

    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const resUrl = String(res.url?.() || "");
        // ✅ 지도 검색 관련 응답만 최대한
        const looksLikeMapSearch =
          /m\.map\.naver\.com/i.test(resUrl) &&
          /(search2\/|search\/|api\/|graphql|query=|placeId)/i.test(resUrl);

        if (!looksLikeMapSearch) return;

        const ct = (await res.headerValue("content-type")) || "";
        if (!/json|javascript/i.test(ct)) return;

        const text = await res.text().catch(() => "");
        if (!text || text.length < 20) return;
        if (!/placeId|\/place\/\d{5,12}|"id"\s*:\s*"\d{5,12}"/.test(text)) return;

        textBuf.push(text);
        if (textBuf.length > 30) textBuf.shift();

        // ✅ 1) JSON 파싱이 되면 placeId/id를 딥서치해서 즉시 축적
        let j: any = null;
        try {
          j = JSON.parse(text);
        } catch {
          j = null;
        }

        if (j) {
          // placeId/id를 찾는 딥서치
          const hits = this.__deepCollect(
            j,
            (x) =>
              x &&
              typeof x === "object" &&
              (typeof (x as any).placeId === "string" ||
                typeof (x as any).placeId === "number" ||
                typeof (x as any).id === "string" ||
                typeof (x as any).id === "number"),
            []
          );

          for (const h of hits) {
            const cand = String((h as any).placeId || (h as any).id || "").trim();
            if (!/^\d{5,12}$/.test(cand)) continue;
            if (foundSet.has(cand)) continue;
            foundSet.add(cand);
            foundIds.push(cand);
            if (foundIds.length >= 20) break;
          }
        }

        // ✅ 2) JSON 파싱이 안돼도 텍스트 regex로 보조(등장 순 유지)
        if (foundIds.length < 10) {
          const ids = this.__extractPlaceIdsFromAnyTextInOrder(text);
          for (const id of ids) {
            if (!id) continue;
            if (foundSet.has(id)) continue;
            foundSet.add(id);
            foundIds.push(id);
            if (foundIds.length >= 20) break;
          }
        }
      } catch {}
    };

    page.on("response", onResponse);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // 지도 검색 로딩 여유
      await page.waitForTimeout(1200);

      // ✅ 최종 후보 ids: foundIds 우선, 부족하면 버퍼 텍스트에서 추출
      let ids = [...foundIds];

      if (ids.length < 5) {
        const mergedText = textBuf.join("\n");
        ids = this.__mergeInOrder(ids, this.__extractPlaceIdsFromAnyTextInOrder(mergedText));
      }

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
  // ✅ 2) 메인: “지도팩 TOP5” 기반 경쟁사 추출 + 대표키워드 크롤링
  // ==========================
  public async findTopCompetitorsByKeyword(keyword: string, opts: FindTopCompetitorsOpts = {}): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = String(opts.excludePlaceId || "").trim();

    const totalTimeoutMs = Math.max(
      5000,
      Math.min(30000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 12000))
    );

    const deadline = Date.now() + totalTimeoutMs - 300;

    // ✅ TOP5는 무조건 지도에서
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, { excludePlaceId: exclude, limit }).catch(() => []);
    const candidateIds = mapIds.length ? mapIds : [];

    if (!candidateIds.length) return [];

    // ✅ enrich 병렬 제한
    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    // ✅ TOP5만 enrich
    const enrichPromises = candidateIds.map((pid) =>
      runLimited(() => this.__fetchPlaceHomeAndExtract(pid, Math.min(12000, Math.max(6000, deadline - Date.now()))))
        .catch(() => ({ name: "", keywords: [] }))
    );

    const out: Competitor[] = [];

    for (let i = 0; i < candidateIds.length && out.length < limit; i++) {
      if (Date.now() > deadline) break;

      const pid = candidateIds[i];
      const remaining = Math.max(1, deadline - Date.now());
      const enriched = await this.__withTimeout(enrichPromises[i], remaining).catch(() => ({ name: "", keywords: [] }));

      out.push({
        placeId: pid,
        name: this.__cleanText(enriched?.name || ""),
        keywords: (enriched?.keywords || [])
          .map((k) => this.__cleanText(k))
          .filter(Boolean)
          .filter((k) => k.length >= 2 && k.length <= 25)
          .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
          .slice(0, 5),
        source: "place_home",
        rank: out.length + 1
      });
    }

    return out;
  }

  // ==========================
  // ✅ place home: 업종 경로 후보 → iframe + 데이터 + DOM fallback
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

    for (const url of candidates) {
      const r = await this.__renderAndExtractFromPlaceHome(url, Math.max(2500, Math.min(15000, timeoutMs)));
      if (r.keywords.length) return r;
    }

    return { name: "", keywords: [] };
  }

  private async __renderAndExtractFromPlaceHome(
    url: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[] }> {
    let context: any = null;
    let page: any = null;

    const netState = { name: "", keywords: [] as string[] };

    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const ct = (await res.headerValue("content-type")) || "";
        if (!/json|javascript/i.test(ct)) return;

        const txt = await res.text().catch(() => "");
        if (!txt || txt.length < 20) return;
        if (!/(keywordList|representKeywordList|representKeywords|keywords)/.test(txt)) return;

        let j: any = null;
        try {
          j = JSON.parse(txt);
        } catch {
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

      // ✅ entryIframe 확보
      const iframeHandle = await page
        .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(8000, timeoutMs) })
        .catch(() => null);

      let frame: any = null;
      if (iframeHandle) frame = await iframeHandle.contentFrame().catch(() => null);

      // ✅ iframe 내부가 "진짜" 올라올 때까지 더 확실히 대기
      // - __NEXT_DATA__가 없는 케이스도 있으니 짧게 반복
      let frameHtml = "";
      if (frame) {
        await frame.waitForLoadState("domcontentloaded").catch(() => {});

        const started = Date.now();
        while (Date.now() - started < Math.min(6500, timeoutMs)) {
          // script#__NEXT_DATA__ 있으면 빠르게
          const hasNext = await frame
            .waitForSelector('script#__NEXT_DATA__', { timeout: 600 })
            .then(() => true)
            .catch(() => false);

          frameHtml = await frame.content().catch(() => frameHtml);

          if (hasNext && frameHtml && frameHtml.includes("__NEXT_DATA__")) break;
          // next 없더라도 HTML이 충분히 길어지면(렌더 완료 신호) 탈출
          if (frameHtml && frameHtml.length > 200000) break;

          await frame.waitForTimeout(250).catch(() => {});
        }
      }

      // 1) iframe HTML에서 NextData 파싱
      if (frameHtml) {
        const next = this.__parseNextData(frameHtml);
        if (!netState.name) netState.name = this.__deepFindName(next) || netState.name;

        if (!netState.keywords.length) {
          for (const k of ["keywordList", "representKeywordList", "representKeywords", "keywords"]) {
            const arr = this.__deepFindStringArray(next, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }

        if (!netState.keywords.length) {
          const fallback = this.__extractKeywordArrayByRegex(frameHtml);
          if (fallback.length) netState.keywords = fallback;
        }
      }

      // 2) 그래도 없으면: DOM에서 키워드처럼 보이는 것만 먼저 추출 → 마지막에 넓게
      if (frame && !netState.keywords.length) {
        const domKeywords = await this.__extractKeywordsFromDom(frame).catch(() => []);
        if (domKeywords.length) netState.keywords = domKeywords;
      }

      // name fallback (og:title)
      if (!netState.name) {
        const outer = await page.content().catch(() => "");
        const m1 = outer.match(/property=["']og:title["'][^>]*content=["']([^"']{2,80})["']/);
        if (m1?.[1]) netState.name = this.__cleanText(m1[1]);
      }

      const cleanedKeywords = (netState.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5);

      return { name: this.__cleanText(netState.name), keywords: cleanedKeywords };
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

// ✅ DOM 기반 대표키워드 추출(iframe 내부) - 서버 TS(Non-DOM lib) 안전 버전
private async __extractKeywordsFromDom(frame: any): Promise<string[]> {
  const raw: string[] = await frame.evaluate(() => {
    const texts: string[] = [];

    const push = (t: unknown) => {
      const s = String(t ?? "").replace(/\s+/g, " ").trim();
      if (!s) return;
      if (s.length < 2 || s.length > 25) return;
      texts.push(s.replace(/^#/, ""));
    };

    // ✅ 여기서 document는 "타입"이 아니라 런타임 전역이므로 TS DOM lib 없이도 안전하게 접근 가능
    const d: any = (globalThis as any).document;
    if (!d || !d.querySelectorAll) return texts;

    // 대표키워드는 보통 칩/태그/링크/버튼 형태
    const selectors = [
      'a[role="button"]',
      "a",
      "button",
      "span",
      "div"
    ];

    // 너무 과하게 긁지 않도록 상한
    const LIMIT = 600;

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

  // 서버에서 정리 로직
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
      if (/(미용실|헤어|살롱|펌|염색|커트|컷|클리닉|카페|맛집|식당|요리|커피|디저트)/.test(s)) sc += 2;
      if (/[가-힣]/.test(s)) sc += 1;
      // 너무 일반 단어 패널티
      if (/(주차|화장실|예약|문의|영업|휴무)/.test(s)) sc -= 2;
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

  private __extractKeywordArrayByRegex(html: string): string[] {
    const text = String(html || "");
    const re1 = /"(?:representKeywordList|keywordList|representKeywords|keywords)"\s*:\s*\[([^\]]{1,2000})\]/g;

    for (const m of text.matchAll(re1)) {
      const inside = m[1] || "";
      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean);
      if (strs.length) return Array.from(new Set(strs));
    }
    return [];
  }

  private __extractPlaceIdsFromAnyTextInOrder(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const m of String(text || "").matchAll(/\/place\/(\d{5,12})/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 80) break;
    }

    if (ids.length < 10) {
      for (const m of String(text || "").matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 80) break;
      }
    }

    // id:"12345" (map 쪽 응답에서 placeId 대신 id만 있는 케이스 보조)
    if (ids.length < 10) {
      for (const m of String(text || "").matchAll(/"id"\s*:\s*"(\d{5,12})"/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 80) break;
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
