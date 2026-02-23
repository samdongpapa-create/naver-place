// src/services/competitorService.ts
import type { Industry } from "../lib/scoring/types";
import { ModularCrawler } from "./modularCrawler";
import { chromium, type Browser, type Page, type Route } from "playwright";

type Competitor = {
  placeId: string;
  name?: string;
  address?: string;
  keywords?: string[];
  reviewCount?: number;
  photoCount?: number;
  url?: string;
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function buildCompetitorUrl(placeId: string) {
  return `https://m.place.naver.com/place/${placeId}/home`;
}

function collectIdCandidatesFromAnyJson(json: any): string[] {
  if (!json) return [];
  let s = "";
  try {
    s = JSON.stringify(json);
  } catch {
    s = "";
  }
  if (!s) return [];
  const ids = s.match(/\b\d{5,12}\b/g) || [];
  return uniq(ids);
}

function buildMobileMapSearchUrl(query: string) {
  const q = encodeURIComponent((query || "").trim());
  return `https://m.map.naver.com/search2/search.naver?query=${q}`;
}

async function safeClosePage(p?: Page | null) {
  try {
    if (p) await p.close();
  } catch {}
}

async function safeCloseBrowser(b?: Browser | null) {
  try {
    if (b) await b.close();
  } catch {}
}

async function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let t: NodeJS.Timeout | null = null;
  const tp = new Promise<T>((_r, rej) => {
    t = setTimeout(() => rej(new Error(label)), ms);
  });
  try {
    return await Promise.race([p, tp]);
  } finally {
    if (t) clearTimeout(t);
  }
}

function shouldAbortResource(route: Route): boolean {
  const req = route.request();
  const rt = req.resourceType();
  // 지도 페이지가 무거워서 리소스 로딩을 공격적으로 줄임
  if (rt === "image" || rt === "media" || rt === "font" || rt === "stylesheet") return true;

  const url = req.url();
  // 광고/트래킹/지도 타일 이미지 등도 컷 (너무 과하면 JSON 못 잡을 수 있으니 최소한만)
  if (/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i.test(url)) return true;

  return false;
}

export class CompetitorService {
  private crawler: ModularCrawler;

  constructor() {
    this.crawler = new ModularCrawler();
  }

  async close() {
    try {
      const anyCrawler = this.crawler as any;
      if (typeof anyCrawler.close === "function") await anyCrawler.close();
    } catch {}
  }

  /**
   * ✅ Playwright로 m.map.naver.com 검색 페이지를 “가볍게” 열고,
   * 네트워크 응답(JSON)을 가로채 placeId 후보를 수집한다.
   *
   * pw-goto-timeout 방지 핵심:
   * - waitUntil: "commit" (DOMContentLoaded까지 기다리지 않음)
   * - 이미지/폰트/스타일 로딩 차단
   * - 짧게 1차 시도 → 실패하면 1회만 긴 타임아웃 재시도
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const MAX_CANDIDATES = Math.max(limit * 20, 80);
    const collected: string[] = [];
    const tried = new Set<string>();

    let browser: Browser | null = null;
    let page: Page | null = null;

    const started = Date.now();
    const hardTimeoutMs = Number(process.env.COMPETITOR_SEARCH_HARD_TIMEOUT_MS || 8000);

    // 네트워크/XHR 기다리는 시간 (너무 길게 잡지 말 것)
    const waitMs1 = Number(process.env.COMPETITOR_PW_WAIT_MS || 1200);
    const waitMs2 = Number(process.env.COMPETITOR_PW_WAIT_MS2 || 1600);

    // goto 타임아웃(짧게) + 재시도(길게)
    const gotoTimeoutFast = Number(process.env.COMPETITOR_PW_GOTO_TIMEOUT_FAST_MS || 2500);
    const gotoTimeoutSlow = Number(process.env.COMPETITOR_PW_GOTO_TIMEOUT_SLOW_MS || 9000);

    try {
      const headless = process.env.PLAYWRIGHT_HEADLESS !== "false";

      browser = await chromium.launch({
        headless,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
          "--disable-blink-features=AutomationControlled"
        ]
      });

      const context = await browser.newContext({
        userAgent:
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        locale: "ko-KR",
        extraHTTPHeaders: { "accept-language": "ko-KR,ko;q=0.9,en;q=0.7" },
        viewport: { width: 420, height: 860 }
      });

      // navigation timeout 기본값도 살짝 줄여서 빨리 실패/재시도하게
      context.setDefaultNavigationTimeout(gotoTimeoutSlow);

      page = await context.newPage();

      // ✅ 무거운 리소스 차단
      await page.route("**/*", async (route) => {
        try {
          if (shouldAbortResource(route)) return await route.abort();
          return await route.continue();
        } catch {
          try {
            return await route.continue();
          } catch {}
        }
      });

      // ✅ 네트워크 응답에서 placeId 후보 수집
      page.on("response", async (res) => {
        try {
          if (Date.now() - started > hardTimeoutMs) return;

          const url = res.url();
          const ct = (res.headers()["content-type"] || "").toLowerCase();

          // json / text/plain(json) 만
          if (!ct.includes("application/json") && !ct.includes("text/plain")) return;
          if (!/naver\.com/i.test(url)) return;

          const txt = await res.text();
          if (!txt || txt.length < 20) return;

          let json: any = null;
          try {
            json = JSON.parse(txt);
          } catch {
            json = null;
          }
          if (!json) return;

          let ids = collectIdCandidatesFromAnyJson(json)
            .filter((id) => /^\d{5,12}$/.test(id))
            .filter((id) => id !== excludePlaceId);

          for (const id of ids) {
            if (tried.has(id)) continue;
            tried.add(id);
            collected.push(id);
            if (collected.length >= MAX_CANDIDATES) return;
          }
        } catch {
          // ignore
        }
      });

      const url = buildMobileMapSearchUrl(q);
      console.log("[COMP][PW-search] goto:", url);

      // ✅ 1차: 빠른 시도 (commit까지만)
      try {
        await withTimeout(page.goto(url, { waitUntil: "commit", timeout: gotoTimeoutFast }), gotoTimeoutFast + 300, "pw-goto-timeout");
      } catch (e: any) {
        // ✅ 2차: 느린 재시도 (commit 유지 + 타임아웃만 늘림)
        console.log("[COMP][PW-search] goto retry (slow) because:", e?.message || String(e));
        await withTimeout(page.goto(url, { waitUntil: "commit", timeout: gotoTimeoutSlow }), gotoTimeoutSlow + 500, "pw-goto-timeout");
      }

      // XHR/응답 수집 대기
      await page.waitForTimeout(waitMs1);

      // 스크롤 유도 (window/document 없이)
      try {
        await page.mouse.wheel(0, 1800);
        await page.waitForTimeout(500);
        await page.mouse.wheel(0, 1800);
      } catch {}

      await page.waitForTimeout(waitMs2);

      const finalIds = uniq(collected)
        .filter((id) => id !== excludePlaceId)
        .slice(0, Math.max(limit * 5, 25));

      console.log("[COMP][PW-search] candidates:", finalIds.length, finalIds.slice(0, 15));
      return finalIds;
    } catch (e: any) {
      console.log("[COMP][PW-search] error:", e?.message || String(e));
      return [];
    } finally {
      await safeClosePage(page);
      await safeCloseBrowser(browser);
    }
  }

  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean);
    if (!candidates.length) return [];

    const out: Competitor[] = [];
    const tried = new Set<string>();

    const hardTimeoutMs = Number(process.env.COMPETITOR_CRAWL_HARD_TIMEOUT_MS || 8000);
    const started = Date.now();

    for (const id of candidates) {
      if (out.length >= limit) break;
      if (Date.now() - started > hardTimeoutMs) break;

      if (tried.has(id)) continue;
      tried.add(id);

      if (!/^\d{5,12}$/.test(id)) continue;

      try {
        const url = buildCompetitorUrl(id);
        console.log("[COMP][crawl] try:", id, url);

        const r = await this.crawler.crawlPlace(url);
        if (!r?.success || !r?.data?.name) continue;

        out.push({
          placeId: id,
          url,
          name: r.data.name,
          address: r.data.address,
          keywords: Array.isArray(r.data.keywords) ? r.data.keywords : [],
          reviewCount: Number(r.data.reviewCount || 0),
          photoCount: Number(r.data.photoCount || 0)
        });

        console.log("[COMP][crawl] ok:", id, r.data.name);
      } catch (e: any) {
        console.log("[COMP][crawl] error:", id, e?.message || String(e));
      }
    }

    console.log("[COMP][crawl] final competitors:", out.length);
    return out;
  }
}
