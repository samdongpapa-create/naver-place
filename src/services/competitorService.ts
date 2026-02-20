import { chromium, Browser } from "playwright";
import { UrlConverter } from "./modules/urlConverter";
import { ModularCrawler } from "./modularCrawler";
import type { Industry } from "../lib/scoring/types";

export type CompetitorSummary = {
  name: string;
  address: string;
  keywords: string[];
  reviewCount: number;
  photoCount: number;
};

export class CompetitorService {
  private browser: Browser | null = null;

  private async ensureBrowser() {
    if (this.browser) return;
    this.browser = await chromium.launch({
      headless: true,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-zygote",
        "--single-process"
      ]
    });
  }

  async close() {
    try {
      await this.browser?.close();
    } catch {}
    this.browser = null;
  }

  /**
   * 네이버 플레이스 검색 결과에서 상위 placeId들을 뽑는다.
   * - 중복 제거
   * - 내 placeId 제외
   */
  async findTopPlaceIds(searchQuery: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    await this.ensureBrowser();
    const page = await this.browser!.newPage();

    try {
      const url = `https://m.place.naver.com/search?query=${encodeURIComponent(searchQuery)}`;
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(2000);

      // href에서 placeId 추출
      const hrefs = await page.$$eval("a[href]", as =>
        as.map(a => (a as HTMLAnchorElement).getAttribute("href") || "").filter(Boolean)
      );

      const ids: string[] = [];
      const seen = new Set<string>();

      for (const h of hrefs) {
        // /place/1234567
        let m = h.match(/\/place\/(\d+)/);
        if (!m) {
          // /hairshop/1234567/home 같은 패턴
          m = h.match(/\/(restaurant|cafe|hairshop)\/(\d+)\//);
          if (m?.[2]) {
            const id = m[2];
            if (id !== excludePlaceId && !seen.has(id)) {
              seen.add(id);
              ids.push(id);
            }
          }
        } else if (m?.[1]) {
          const id = m[1];
          if (id !== excludePlaceId && !seen.has(id)) {
            seen.add(id);
            ids.push(id);
          }
        }

        if (ids.length >= limit) break;
      }

      return ids.slice(0, limit);
    } finally {
      await page.close().catch(() => {});
    }
  }

  /**
   * placeId 리스트를 실제 크롤링해서 competitors 데이터로 만든다.
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<CompetitorSummary[]> {
    const out: CompetitorSummary[] = [];
    for (const id of placeIds.slice(0, limit)) {
      try {
        // 모바일 표준 URL로
        const url = `https://m.place.naver.com/place/${id}`;
        const crawler = new ModularCrawler();
        const r = await crawler.crawlPlace(UrlConverter.convertToMobileUrl(url));
        if (!r.success || !r.data) continue;

        out.push({
          name: r.data.name || "업체명 없음",
          address: r.data.address || "",
          keywords: Array.isArray(r.data.keywords) ? r.data.keywords.slice(0, 5) : [],
          reviewCount: r.data.reviewCount || 0,
          photoCount: r.data.photoCount || 0
        });
      } catch {
        continue;
      }
    }
    return out;
  }
}
