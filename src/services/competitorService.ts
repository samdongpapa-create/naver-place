// src/services/competitorService.ts
import type { Industry } from "../lib/scoring/types";
import { ModularCrawler } from "./modularCrawler";
import { chromium, type Browser, type Page } from "playwright";

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

/**
 * JSON 전체에서 5~12자리 숫자 후보 수집
 */
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

/**
 * 네이버 모바일 지도 검색 URL
 */
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
   * ✅ Playwright로 m.map.naver.com 검색 페이지를 열고
   * 네트워크 응답(JSON)을 가로채 placeId 후보를 뽑는다.
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
    const hardTimeoutMs = Number(process.env.COMPETITOR_SEARCH_HARD_TIMEOUT_MS || 6500);

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
        extraHTTPHeaders: {
          "accept-language": "ko-KR,ko;q=0.9,en;q=0.7"
        },
        viewport: { width: 420, height: 860 }
      });

      page = await context.newPage();

      // ✅ 네트워크 응답에서 placeId 후보 수집
      page.on("response", async (res) => {
        try {
          if (Date.now() - started > hardTimeoutMs) return;

          const url = res.url();
          const ct = (res.headers()["content-type"] || "").toLowerCase();

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

          let ids = collectIdCandidatesFromAnyJson(json);
          ids = ids.filter((id) => /^\d{5,12}$/.test(id));
          ids = ids.filter((id) => id !== excludePlaceId);

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

      await withTimeout(
        page.goto(url, { waitUntil: "domcontentloaded" }),
        Number(process.env.COMPETITOR_PW_GOTO_TIMEOUT_MS || 4000),
        "pw-goto-timeout"
      );

      // XHR 유도 대기
      await page.waitForTimeout(Number(process.env.COMPETITOR_PW_WAIT_MS || 1200));

      // ✅ DOM(window/document) 없이 스크롤 유도 (TS 에러 방지)
      try {
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(600);
        await page.mouse.wheel(0, 1600);
        await page.waitForTimeout(600);
      } catch {}

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

  /**
   * ✅ 후보 placeId들을 실제로 크롤링해서 "성공한 애들만" 경쟁사로 확정
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean);
    if (!candidates.length) return [];

    const out: Competitor[] = [];
    const tried = new Set<string>();

    const hardTimeoutMs = Number(process.env.COMPETITOR_CRAWL_HARD_TIMEOUT_MS || 7000);
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
