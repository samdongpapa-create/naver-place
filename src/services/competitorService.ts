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

  // ==========================
  // ✅ 브라우저(싱글톤)
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
  // - 5자리(13008 등) 오탐이 자주 섞여서 기본 차단
  // ==========================
  private __normPlaceId(pid: string) {
    return String(pid || "").trim();
  }

  private __isValidPlaceId(pid: string) {
    const s = this.__normPlaceId(pid);
    return /^\d{7,12}$/.test(s);
  }

  // ==========================
  // ✅ 공통: Playwright Context 생성(차단 완화)
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

    // webdriver 숨김(완벽하진 않지만 조금 도움)
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

    // 리소스 절약: 이미지/폰트/미디어 차단
    await page.route("**/*", (route) => {
      const rt = route.request().resourceType();
      if (rt === "image" || rt === "font" || rt === "media") return route.abort();
      return route.continue();
    });

    return page;
  }

  // ==========================
  // ✅ 0) Naver Map allSearch JSON으로 TOP placeId 추출 (가장 빠르고 안정적 시도)
  // ==========================
  private async __findTopPlaceIdsViaAllSearch(keyword: string, limit: number, timeoutMs: number): Promise<string[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = new URL("https://map.naver.com/p/api/search/allSearch");

    // ✅ 기본은 서울시청 근처, 필요하면 env로 교체
    const searchCoord = String(process.env.NAVER_MAP_SEARCH_COORD || "126.9780;37.5665"); // lng;lat
    const boundary = String(process.env.NAVER_MAP_BOUNDARY || "");

    url.searchParams.set("query", q);
    url.searchParams.set("type", "all");
    url.searchParams.set("page", "1");
    url.searchParams.set("searchCoord", searchCoord);
    if (boundary) url.searchParams.set("boundary", boundary);

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), Math.max(1, timeoutMs));

    try {
      const res = await fetch(url.toString(), {
        method: "GET",
        headers: {
          accept: "application/json, text/plain, */*",
          "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
          "user-agent": this.__pickRandomUA(),
          referer: this.__buildMapReferer(q)
        },
        redirect: "follow",
        signal: ctrl.signal
      });

      if (!res.ok) {
        const txt = await res.text().catch(() => "");
        throw new Error(`[allSearch] status=${res.status} body=${txt.slice(0, 240)}`);
      }

      const data: any = await res.json().catch(() => null);
      const list: any[] = data?.result?.place?.list || [];

      const ids = list
        .map((x) => (x?.id ? String(x.id) : ""))
        .map((id) => this.__normPlaceId(id))
        .filter((id) => this.__isValidPlaceId(id));

      return Array.from(new Set(ids)).slice(0, limit);
    } finally {
      clearTimeout(t);
    }
  }

  // ==========================
  // ✅ 1) 지도(=실제 노출) TOP placeId 추출
  // - 1순위: allSearch JSON
  // - 2순위: m.map playwright 스니핑 (Railway에서 500이 자주 나서 최후순위)
  // ==========================
  async findTopPlaceIdsFromMapRank(keyword: string, opts: FindTopIdsOptions = {}) {
    const limit = Math.max(1, Math.min(20, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");
    const q = String(keyword || "").trim();
    if (!q) return [];

    // ✅ 1순위: allSearch (짧게)
    try {
      const ids = await this.__findTopPlaceIdsViaAllSearch(q, limit + 5, 4500);
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

    // ✅ 2순위: m.map (막힐 확률 높음)
    const url = `https://m.map.naver.com/search2/search.naver?query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://m.map.naver.com/");
    const page = await this.__newLightPage(context, Number(process.env.MAP_GOTO_TIMEOUT_MS || 25000));

    // xhr/fetch에서 placeId 텍스트만 모은다
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

        if (!/(placeId|\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/\d{5,12})/.test(text))
          return;

        buf.push(text);
        if (buf.length > 50) buf.shift();
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
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1200);

      try {
        const title = await page.title().catch(() => "");
        const htmlLen = (await page.content().catch(() => "")).length;
        console.log("[COMP][mapRank] finalUrl:", page.url());
        console.log("[COMP][mapRank] title:", title);
        console.log("[COMP][mapRank] htmlLen:", htmlLen);
      } catch {}

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
  // ✅ 2) 메인: 경쟁사 추출 + 대표키워드 크롤링
  // - 핵심: 키워드 수집 실패해도 경쟁사 목록(최소 placeId+name) 반환
  // ==========================
  public async findTopCompetitorsByKeyword(keyword: string, opts: FindTopCompetitorsOpts = {}): Promise<Competitor[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const limit = Math.max(1, Math.min(10, opts.limit ?? 5));
    const exclude = this.__normPlaceId(opts.excludePlaceId || "");

    const totalTimeoutMs = Math.max(
      7000,
      Math.min(45000, opts.timeoutMs ?? Number(process.env.COMPETITOR_TIMEOUT_MS || 18000))
    );
    const deadline = this.__deadlineMs(totalTimeoutMs);

    // 1) 지도(노출 순) 1차 시도
    const mapIds = await this.findTopPlaceIdsFromMapRank(q, { excludePlaceId: exclude, limit }).catch(() => []);

    // 2) fallback: search where=place (fetch → 안되면 playwright 렌더)
    let metas: PlaceMeta[] = [];
    if (!mapIds.length) {
      const remain = Math.min(12000, Math.max(5000, this.__remaining(deadline)));
      metas = await this.__findTopPlaceMetasFromSearchWherePlaceFetch(q, remain).catch(() => []);
      if (!metas.length) {
        metas = await this.__findTopPlaceMetasFromSearchWherePlaceRendered(q, remain).catch(() => []);
      }
    }

    // 후보 메타
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
      if (m.placeId && m.name) nameMap.set(m.placeId, this.__cleanText(m.name));
    }

    // enrich 병렬 제한
    const enrichConcurrency = Math.max(1, Math.min(4, Number(process.env.COMPETITOR_ENRICH_CONCURRENCY || 2)));
    const runLimited = this.__createLimiter(enrichConcurrency);

    const enrichPromises = candidateMetas.map((m) =>
      runLimited(() => this.__fetchPlaceHomeAndExtract(m.placeId, Math.min(15000, Math.max(7000, this.__remaining(deadline)))))
    );

    const allowEmpty = String(process.env.ALLOW_EMPTY_COMP_KEYWORDS || "") === "1";

    const out: Competitor[] = [];
    for (let i = 0; i < candidateMetas.length && out.length < limit; i++) {
      if (this.__nowMs() > deadline) break;

      const pid = candidateMetas[i].placeId;
      const remaining = this.__remaining(deadline);

      const enriched = await this.__withTimeout(enrichPromises[i], remaining).catch(() => ({ name: "", keywords: [] as string[] }));
      const fallbackName = nameMap.get(pid) || "";

      const finalName = this.__cleanText(enriched?.name || fallbackName || "") || `place_${pid}`;

      const finalKeywords = (enriched?.keywords || [])
        .map((k) => this.__cleanText(k))
        .filter(Boolean)
        .filter((k) => k.length >= 2 && k.length <= 25)
        .filter((k) => !/(네이버|플레이스|예약|문의|할인|이벤트|가격|베스트|추천)/.test(k))
        .slice(0, 5);

      // ✅ 상위에서 keywords.length로 필터하면 0 나와버리니, 기본은 플레이스홀더 1개 넣어줌
      const safeKeywords = finalKeywords.length ? finalKeywords : allowEmpty ? [] : ["키워드수집실패"];

      out.push({
        placeId: pid,
        name: finalName,
        keywords: safeKeywords,
        source: safeKeywords.length && safeKeywords[0] !== "키워드수집실패" ? "place_home" : "search_html",
        rank: out.length + 1
      });
    }

    return out;
  }

  // ==========================
  // ✅ fallback(1): where=place HTML(fetch)에서 placeId+name 추출
  // - 네이버가 초기 HTML에 링크를 안 박는 케이스가 많아서 "있으면 쓰고, 없으면 렌더로 넘어감"
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceFetch(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;
    const html = await this.__fetchHtml(url, timeoutMs);

    const reAnyPlaceId =
      /https?:\/\/(?:m\.place\.naver\.com|pcmap\.place\.naver\.com|place\.naver\.com)\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/g;

    const banned = /^(저장|길찾기|예약|전화|공유|블로그|리뷰|사진|홈|메뉴|가격)$/i;

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
        .filter((t) => !banned.test(t));

      const ariaMatches = [...chunk.matchAll(/aria-label=["']([^"']{2,80})["']/gi)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean)
        .filter((t) => !banned.test(t));

      const textMatches = [...chunk.matchAll(/>\s*([가-힣A-Za-z0-9][^<>]{1,50})\s*</g)]
        .map((x) => this.__cleanText(x[1]))
        .filter(Boolean)
        .filter((t) => !banned.test(t));

      const name = titleMatches[0] || ariaMatches[0] || textMatches[0] || "";
      metas.push({ placeId: pid, name });

      if (metas.length >= 10) break;
    }

    return metas;
  }

  // ==========================
  // ✅ fallback(2): where=place (Playwright 렌더)에서 placeId+name 추출
  // - "브라우저에선 보이는데 서버 fetch는 빈값" 문제 해결용 핵심
  // ==========================
  private async __findTopPlaceMetasFromSearchWherePlaceRendered(keyword: string, timeoutMs: number): Promise<PlaceMeta[]> {
    const q = String(keyword || "").trim();
    if (!q) return [];

    const url = `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`;

    const context = await this.__newContext("https://search.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

    try {
      await page.goto(url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(700);

      const rows = await page.evaluate(() => {
        const out: Array<{ href: string; text: string }> = [];
        const anchors = Array.from(
          document.querySelectorAll<HTMLAnchorElement>(
            'a[href*="place.naver.com"], a[href*="m.place.naver.com"], a[href*="pcmap.place.naver.com"]'
          )
        );
        for (const a of anchors) {
          const href = a.href || "";
          const text = (a.textContent || "").replace(/\s+/g, " ").trim();
          if (!href) continue;
          if (!text || text.length < 2) continue;
          out.push({ href, text });
          if (out.length >= 300) break;
        }
        return out;
      });

      const banned = /^(저장|길찾기|예약|전화|공유|블로그|리뷰|사진|홈|메뉴|가격)$/i;
      const rePid = /\/(?:place|hairshop|restaurant|cafe|accommodation|hospital|pharmacy|beauty|bakery)\/(\d{5,12})/;

      const metas: PlaceMeta[] = [];
      const seen = new Set<string>();

      for (const r of rows) {
        const m = r.href.match(rePid);
        const pid = this.__normPlaceId(m?.[1] || "");
        if (!this.__isValidPlaceId(pid)) continue;
        if (seen.has(pid)) continue;

        const name = this.__cleanText(r.text);
        if (!name || banned.test(name)) continue;

        seen.add(pid);
        metas.push({ placeId: pid, name });
        if (metas.length >= 10) break;
      }

      // ✅ name이 다 비면 id만이라도 뽑아서 반환
      if (!metas.length) {
        const ids = rows
          .map((r) => this.__normPlaceId(r.href.match(rePid)?.[1] || ""))
          .filter((id) => this.__isValidPlaceId(id));
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
  // - universal /place 먼저 시도(리다이렉트가 잘 됨)
  // ==========================
  private async __fetchPlaceHomeAndExtract(placeId: string, timeoutMs: number): Promise<{ name: string; keywords: string[] }> {
    const pid = this.__normPlaceId(placeId);
    if (!pid) return { name: "", keywords: [] };

    const candidates = [
      `https://m.place.naver.com/place/${pid}/home`,
      `https://m.place.naver.com/hairshop/${pid}/home`,
      `https://m.place.naver.com/restaurant/${pid}/home`,
      `https://m.place.naver.com/cafe/${pid}/home`
    ];

    for (const url of candidates) {
      const r = await this.__renderAndExtractFromPlaceHome(url, Math.max(2500, Math.min(20000, timeoutMs)));
      if (r.keywords.length || r.name) return r;
    }

    return { name: "", keywords: [] };
  }

  private async __renderAndExtractFromPlaceHome(url: string, timeoutMs: number): Promise<{ name: string; keywords: string[] }> {
    const netState = { name: "", keywords: [] as string[] };

    const context = await this.__newContext("https://m.place.naver.com/");
    const page = await this.__newLightPage(context, timeoutMs);

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

    page.on("response", onResponse);

    try {
      const resp = await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => null);

      const status = resp?.status?.() ?? -1;
      const finalUrl = page.url();
      const outer = await page.content().catch(() => "");
      const pageTitle = await page.title().catch(() => "");

      console.log("[COMP][placeHome] goto", { status, url, finalUrl, title: pageTitle, htmlLen: outer.length });
      if (outer.length < 500) console.warn("[COMP][placeHome] suspicious htmlLen", outer.length, "url=", url, "title=", pageTitle);

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

      if (frame && !netState.keywords.length) {
        const domKeywords = await this.__extractKeywordsFromDom(frame).catch(() => []);
        if (domKeywords.length) netState.keywords = domKeywords;
      }

      if (!netState.name) {
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
  // ✅ DOM 기반 대표키워드 추출(iframe 내부)
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
  // helpers
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
    for (const k of Object.keys(obj)) this.__deepCollect((obj as any)[k], predicate, out);
    return out;
  }

  private __deepFindStringArray(obj: any, keyName: string): string[] {
    const hits = this.__deepCollect(obj, (x) => x && typeof x === "object" && Array.isArray((x as any)[keyName]), []);
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
      const strs = [...inside.matchAll(/"([^"]{2,40})"/g)].map((x) => this.__cleanText(x[1])).filter(Boolean);
      if (strs.length) return Array.from(new Set(strs));
    }
    return [];
  }

  // ✅ 어떤 텍스트든 placeId를 “등장 순서대로” 뽑는 유틸
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
