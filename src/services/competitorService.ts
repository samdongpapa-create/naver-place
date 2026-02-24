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
  source: "search_html" | "place_home";
  rank: number;
};

type FindTopCompetitorsOpts = {
  excludePlaceId?: string;
  limit?: number;
  timeoutMs?: number; // 전체 예산(상한) - 내부에서 search/enrich로 분배
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
  // (옵션) 지도 TOP5 고도화용
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

    page.setDefaultTimeout(Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      const ids = await this.waitAndExtractPlaceIdsFromMapPage(page, 8000);

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
        await page.close();
      } catch {}
      try {
        await context.close();
      } catch {}
    }
  }

  private async waitAndExtractPlaceIdsFromMapPage(page: Page, maxWaitMs: number) {
    const started = Date.now();
    let html = "";

    while (Date.now() - started < maxWaitMs) {
      html = await page.content();

      const ids1 = [...html.matchAll(/\/place\/(\d{5,12})/g)].map((m) => m[1]);
      const ids2 = [...html.matchAll(/placeId[=:"']+(\d{5,12})/g)].map((m) => m[1]);

      const merged = this.mergeByFirstAppearance(html, [...ids1, ...ids2]);
      if (merged.length >= 5) return merged;

      await page.waitForTimeout(250);
    }

    const ids1 = [...html.matchAll(/\/place\/(\d{5,12})/g)].map((m) => m[1]);
    const ids2 = [...html.matchAll(/placeId[=:"']+(\d{5,12})/g)].map((m) => m[1]);
    return this.mergeByFirstAppearance(html, [...ids1, ...ids2]);
  }

  private mergeByFirstAppearance(html: string, ids: string[]) {
    const seen = new Set<string>();
    const uniq: string[] = [];
    for (const id of ids) {
      if (!id) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniq.push(id);
    }
    uniq.sort((a, b) => html.indexOf(a) - html.indexOf(b));
    return uniq;
  }

  // ==========================
  // ✅ 핵심: where=place 검색 → TOP placeId → 대표키워드(keywordList) 보강(안정형)
  // - timeout 예산 분리 (a)
  // - enrich 병렬 제한(세마포어, b)
  // ==========================
  public async findTopCompetitorsByKeyword(keyword: string, opts: FindTopCompetitorsOpts = {}): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = String(opts.excludePlaceId || "").trim();

    // ✅ 전체 예산(상한)
    const totalTimeoutMs = Math.max(3000, Math.min(30000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 12000)));

    // ✅ (a) 예산 분리: search는 짧고 고정, enrich는 조금 더 길게
    // - search는 실패해도 다음 쿼리/로직으로 갈 수 있으니 “짧게”
    // - enrich는 iframe/xhr 기다려야 하니 “조금 길게”
    const searchTimeoutMs = Math.max(2500, Math.min(7000, Math.floor(totalTimeoutMs * 0.45)));
    const enrichTimeoutMs = Math.max(6000, Math.min(12000, totalTimeoutMs)); // place 1개당 상한

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

    let html = "";
    try {
      html = await this.__fetchHtml(url, searchTimeoutMs);
    } catch {
      // search 자체 실패면 그대로 빈 결과
      return [];
    }

    const placeIds = this.__extractPlaceIdsInOrder(html);

    // search html에서도 __NEXT_DATA__에 들어있으면 name/keywords 일부는 캐치 가능
    const searchNext = this.__parseNextData(html);

    // 너무 많이 잡아서 무한 시도 방지: limit*3 정도만 후보로
    const maxCandidates = Math.min(30, Math.max(10, limit * 3));
    const candidateIds: string[] = [];
    const seenPid = new Set<string>();

    for (const pid of placeIds) {
      if (!pid) continue;
      if (exclude && pid === exclude) continue;
      if (seenPid.has(pid)) continue;
      seenPid.add(pid);
      candidateIds.push(pid);
      if (candidateIds.length >= maxCandidates) break;
    }

    // ✅ (b) enrich 병렬 제한
    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    // 후보별 기본값 + (필요시) enrich promise를 미리 만들어 둔다
    const base = candidateIds.map((pid) => {
      const name = this.__findNameForPlaceId(searchNext, pid) || "";
      const keywords = this.__findKeywordsForPlaceId(searchNext, pid).slice(0, 5);
      const need = this.__needKeywordEnrich(keywords, name);
      return { pid, name, keywords, need };
    });

    const enrichPromises = new Map<string, Promise<{ name: string; keywords: string[] }>>();
    for (const c of base) {
      if (!c.need) continue;
      // limiter를 통해 동시에 N개만 실행
      enrichPromises.set(
        c.pid,
        runLimited(() => this.__fetchPlaceHomeAndExtract(c.pid, enrichTimeoutMs))
      );
    }

    // ✅ 순서 유지하면서 결과 채우기 (TOP5)
    const out: Competitor[] = [];
    for (const c of base) {
      if (out.length >= limit) break;

      let name = c.name;
      let keywords = c.keywords;

      const p = enrichPromises.get(c.pid);
      if (p) {
        try {
          const enriched = await p;
          if (enriched?.name && !name) name = enriched.name;
          if (enriched?.keywords?.length) keywords = enriched.keywords.slice(0, 5);
        } catch {
          // ignore
        }
      }

      const cleanedName = this.__cleanText(name);
      const cleanedKeywords = (keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k && k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5);

      out.push({
        placeId: c.pid,
        name: cleanedName,
        keywords: cleanedKeywords,
        source: p ? "place_home" : "search_html",
        rank: out.length + 1
      });
    }

    // ✅ 오염 방지(마지막 필터 한번 더)
    return out.map((c) => ({
      ...c,
      keywords: (c.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter((k) => k && k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5)
    }));
  }

  // ==========================
  // private utils
  // ==========================

  private async __fetchHtml(url: string, timeoutMs: number): Promise<string> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
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

  private __extractPlaceIdsInOrder(html: string): string[] {
    const ids: string[] = [];
    const seen = new Set<string>();

    for (const m of html.matchAll(/\/place\/(\d{5,12})/g)) {
      const id = m[1];
      if (!id || seen.has(id)) continue;
      seen.add(id);
      ids.push(id);
      if (ids.length >= 80) break;
    }

    if (ids.length < 10) {
      for (const m of html.matchAll(/placeId["']?\s*[:=]\s*["'](\d{5,12})["']/g)) {
        const id = m[1];
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= 80) break;
      }
    }

    return ids;
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

  // ✅ 키워드가 아예 없거나, 브랜드명만 있으면 보강 필요
  private __needKeywordEnrich(keywords: string[], name: string) {
    const ks = Array.isArray(keywords) ? keywords.filter(Boolean) : [];
    if (ks.length >= 3) return false;
    if (ks.length === 0) return true;

    const nm = this.__cleanText(name).replace(/\s+/g, "");
    const allBrandLike = ks.every((k) => {
      const kk = this.__cleanText(k).replace(/\s+/g, "");
      if (!kk) return true;
      if (nm && (kk === nm || nm.includes(kk) || kk.includes(nm))) return true;
      if (/(네이버|플레이스|예약|문의|할인|이벤트|가격)/.test(kk)) return true;
      const hasSignal = /(역|동|구|미용실|카페|맛집|헤어|살롱|클리닉|펌|염색|커트|컷)/.test(kk);
      return !hasSignal;
    });

    return allBrandLike;
  }

  // ==========================
  // ✅ __NEXT_DATA__ 파싱 + 딥서치
  // ==========================
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

  private __findNameForPlaceId(next: any, placeId: string): string {
    if (!next) return "";
    const pid = String(placeId);

    const hits = this.__deepCollect(
      next,
      (x) =>
        x &&
        typeof x === "object" &&
        (String((x as any).id || (x as any).placeId || (x as any).businessId || "") === pid ||
          String((x as any).placeId || "") === pid),
      []
    );

    for (const h of hits) {
      const nm = this.__deepFindName(h);
      if (nm) return nm;
    }

    return "";
  }

  private __findKeywordsForPlaceId(next: any, placeId: string): string[] {
    if (!next) return [];
    const pid = String(placeId);

    const hits = this.__deepCollect(
      next,
      (x) =>
        x &&
        typeof x === "object" &&
        (String((x as any).id || (x as any).placeId || (x as any).businessId || "") === pid ||
          String((x as any).placeId || "") === pid),
      []
    );

    for (const h of hits) {
      const keys = ["keywordList", "representKeywordList", "representKeywords", "keywords"];
      for (const k of keys) {
        const arr = this.__deepFindStringArray(h, k);
        if (arr.length) return arr;
      }
    }

    return [];
  }

  // ==========================
  // ✅ 핵심 개선: place home은 “iframe + 네트워크 응답 스니핑”으로 대표키워드 추출
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
      // name만 있고 keywords 없으면 다음 후보도 더 시도
    }

    return { name: "", keywords: [] };
  }

  private async __renderAndExtractFromPlaceHome(
    url: string,
    timeoutMs: number
  ): Promise<{ name: string; keywords: string[] }> {
    const browser = await this.getBrowser();
    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      viewport: { width: 390, height: 844 },
      locale: "ko-KR"
    });

    const page = await context.newPage();

    // 리소스 절약 (단, script/xhr/fetch는 살려야 키워드가 로드될 수 있음)
    await page.route("**/*", (route) => {
      const req = route.request();
      const rtype = req.resourceType();
      if (rtype === "document" || rtype === "script" || rtype === "xhr" || rtype === "fetch") return route.continue();
      return route.abort();
    });

    page.setDefaultTimeout(timeoutMs);

    // ✅ 네트워크 응답에서 대표키워드/이름을 “가로채기”
    const netState = {
      name: "",
      keywords: [] as string[]
    };

    const onResponse = async (res: any) => {
      try {
        const req = res.request();
        const rt = req.resourceType();
        if (rt !== "xhr" && rt !== "fetch") return;

        const ct = (await res.headerValue("content-type")) || "";
        if (!/json|javascript/i.test(ct)) return;

        const txt = await res.text();
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
          const keys = ["keywordList", "representKeywordList", "representKeywords", "keywords"];
          for (const k of keys) {
            const arr = this.__deepFindStringArray(j, k);
            if (arr.length) {
              netState.keywords = arr;
              break;
            }
          }
        }
      } catch {
        // ignore
      }
    };

    page.on("response", onResponse);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });

      // ✅ 핵심: entryIframe 대기 → iframe 내부 HTML/NextData도 파싱
      let frameHtml = "";
      const iframeHandle = await page
        .waitForSelector('iframe#entryIframe, iframe[name="entryIframe"]', { timeout: Math.min(7000, timeoutMs) })
        .catch(() => null);

      if (iframeHandle) {
        const frame = await iframeHandle.contentFrame().catch(() => null);
        if (frame) {
          await frame.waitForLoadState("domcontentloaded").catch(() => {});
          await frame.waitForTimeout(400).catch(() => {});
          frameHtml = await frame.content().catch(() => "");
        }
      }

      // ✅ 키워드가 “늦게” 오는 케이스 대응: 최대 timeout까지 폴링
      const started = Date.now();
      while (Date.now() - started < Math.min(timeoutMs, 12000)) {
        if (netState.keywords.length) break;

        if (frameHtml) {
          const next = this.__parseNextData(frameHtml);

          if (!netState.name) netState.name = this.__deepFindName(next) || netState.name;

          if (!netState.keywords.length) {
            const keys = ["keywordList", "representKeywordList", "representKeywords", "keywords"];
            for (const k of keys) {
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

        if (netState.keywords.length) break;

        // iframe html 갱신 시도 (가끔 늦게 hydration)
        if (iframeHandle) {
          const frame = await iframeHandle.contentFrame().catch(() => null);
          if (frame) frameHtml = await frame.content().catch(() => frameHtml);
        }

        await page.waitForTimeout(250);
      }

      // ✅ 마지막 name fallback (outer html에서도 og:title 등)
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

      return {
        name: this.__cleanText(netState.name),
        keywords: cleanedKeywords
      };
    } catch {
      return { name: "", keywords: [] };
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

  /**
   * ✅ HTML에 들어있는 대표키워드 배열을 직접 뽑는 fallback
   * - 예: "representKeywordList":["서대문역미용실","..."]
   * - 또는 "keywordList":[{...}] 형태라도 문자열만 최대한 긁는다
   */
  private __extractKeywordArrayByRegex(html: string): string[] {
    const text = String(html || "");

    // 1) 가장 흔한 문자열 배열 형태
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

  // ==========================
  // ✅ (b) 세마포어/리미터: 동시에 N개만 실행
  // ==========================
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
      return await new Promise<T>((resolve, reject) => {
        const run = () => {
          fn()
            .then(resolve)
            .catch(reject)
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
}
