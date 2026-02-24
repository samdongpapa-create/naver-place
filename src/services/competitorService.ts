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
  // - HTML 파싱 X
  // - JSON 응답 스니핑으로 placeId를 “등장 순서대로” 추출
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

    const timeoutMs = Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000);
    page.setDefaultTimeout(timeoutMs);

    // ✅ 응답 스니핑 버퍼
    const buf: string[] = [];
    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const ct = (await res.headerValue("content-type")) || "";
        if (!/json|javascript/i.test(ct)) return;

        const text = await res.text().catch(() => "");
        if (!text) return;
        if (!/placeId|\/place\/\d{5,12}/.test(text)) return;

        buf.push(text);
        // 너무 쌓이지 않게 컷
        if (buf.length > 25) buf.shift();
      } catch {}
    };

    page.on("response", onResponse);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // 지도 검색은 로딩이 약간 늦어서 짧게 기다림
      await page.waitForTimeout(900);

      // ✅ 버퍼에서 placeId 추출 (등장 순)
      const mergedText = buf.join("\n");
      let ids = this.__extractPlaceIdsFromAnyTextInOrder(mergedText);

      // 그래도 부족하면 html에서도 한번 보조(최후)
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

    // ✅ 2-1) TOP5는 무조건 지도에서
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, { excludePlaceId: exclude, limit }).catch(() => []);

    // 지도에서 못가져오면 fallback(최후)
    const candidateIds = mapIds.length ? mapIds : [];

    if (!candidateIds.length) return [];

    // ✅ enrich 병렬 제한
    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    // ✅ TOP5만 필요하니, 그대로 TOP5만 enrich
    const enrichPromises = candidateIds.map((pid) =>
      runLimited(() => this.__fetchPlaceHomeAndExtract(pid, Math.min(12000, Math.max(6000, deadline - Date.now()))))
        .catch(() => ({ name: "", keywords: [] })) // 절대 reject 금지
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
      // 키워드가 있으면 확정
      if (r.keywords.length) return r;
      // name만 있으면 다음 후보도 시도
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
        .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(7000, timeoutMs) })
        .catch(() => null);

      let frame: any = null;
      if (iframeHandle) frame = await iframeHandle.contentFrame().catch(() => null);

      // ✅ iframe 내부가 완성될 때까지 “__NEXT_DATA__”를 기다렸다가 읽기 (핵심)
      if (frame) {
        await frame.waitForLoadState("domcontentloaded").catch(() => {});
        await frame.waitForSelector('script#__NEXT_DATA__', { timeout: Math.min(6000, timeoutMs) }).catch(() => {});
      }

      // 1) iframe HTML에서 NextData 파싱
      let frameHtml = frame ? await frame.content().catch(() => "") : "";

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

      // 2) 그래도 없으면: ✅ DOM에서 “대표키워드 칩” 텍스트 직접 긁기 (가장 강력한 최후수단)
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

// ✅ DOM 기반 대표키워드 추출(iframe 내부) - Node TS(Non-DOM lib) 호환 버전
private async __extractKeywordsFromDom(frame: any): Promise<string[]> {
  const raw: string[] = await frame.evaluate(() => {
    // ⚠️ 여기서는 DOM 타입을 절대 쓰지 말 것 (document/HTMLElement 타입 참조 금지)
    const texts: string[] = [];

    const push = (t: unknown) => {
      const s = String(t ?? "").replace(/\s+/g, " ").trim();
      if (!s) return;
      // 너무 긴 건 제외
      if (s.length < 2 || s.length > 25) return;
      texts.push(s.replace(/^#/, ""));
    };

    // document를 쓰되 "타입"으로 참조하지 않도록 any로 우회
    const doc: any = globalThis as any;
    const d = doc.document;
    if (!d || !d.querySelectorAll) return texts;

    const nodes = Array.from(d.querySelectorAll("a, button, span, div"));
    for (const el of nodes as any[]) {
      const t = (el?.innerText ?? el?.textContent ?? "") as string;
      push(t);
    }

    return texts;
  });

  // 이하 서버에서 정리 로직(기존 그대로)
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
    if (/(미용실|헤어|살롱|펌|염색|커트|컷|클리닉)/.test(s)) sc += 2;
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

  // ✅ 어떤 텍스트든 placeId를 “등장 순서대로” 뽑는 유틸 (map 응답/HTML 공용)
  private __extractPlaceIdsFromAnyTextInOrder(text: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    // /place/12345
    for (const m of String(text || "").matchAll(/\/place\/(\d{5,12})/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 80) break;
    }

    // placeId:"12345"
    if (ids.length < 10) {
      for (const m of String(text || "").matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
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
