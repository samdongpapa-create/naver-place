import { ModularCrawler } from "./modularCrawler";
import type { Industry } from "../lib/scoring/types";

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

function pickPlaceIdsFromText(text: string): string[] {
  const ids: string[] = [];
  if (!text) return ids;

  // 다양한 패턴을 최대한 포괄
  const patterns = [
    /\/place\/(\d{5,12})/g,
    /"placeId"\s*:\s*"(\d{5,12})"/g,
    /"id"\s*:\s*"(\d{5,12})"/g,
    /\bplaceId=(\d{5,12})\b/g
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      if (m[1]) ids.push(m[1]);
    }
  }
  return ids;
}

async function fetchText(url: string, extraHeaders?: Record<string, string>) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
      ...extraHeaders
    }
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text, finalUrl: res.url };
}

async function fetchJson(url: string, extraHeaders?: Record<string, string>) {
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      accept: "application/json,text/plain,*/*",
      ...extraHeaders
    }
  });

  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text, finalUrl: res.url };
}

function buildCompetitorUrl(industry: Industry, placeId: string) {
  // slug 없어도 /place/{id}/home로 들어가면 리다이렉트 됨
  // 하지만 crawler가 slug 있는 URL도 잘 처리하니 place/home로 통일
  return `https://m.place.naver.com/place/${placeId}/home`;
}

export class CompetitorService {
  private crawler: ModularCrawler;

  constructor() {
    this.crawler = new ModularCrawler();
  }

  async close() {
    // ModularCrawler가 내부 브라우저를 들고 있을 수 있으니 close가 있으면 호출
    try {
      const anyCrawler = this.crawler as any;
      if (typeof anyCrawler.close === "function") await anyCrawler.close();
    } catch {}
  }

  /**
   * 검색어로 경쟁사 placeId TopN 뽑기
   * - excludePlaceId: 내 플레이스 제외
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const encoded = encodeURIComponent(q);

    // 1) m.map.naver.com 검색 HTML (상대적으로 placeId 링크가 잘 나옴)
    const url1 = `https://m.map.naver.com/search2/search.naver?query=${encoded}`;
    console.log("[COMP][findTopPlaceIds] try #1:", url1);

    try {
      const r1 = await fetchText(url1);
      console.log("[COMP][#1] status:", r1.status, "final:", r1.finalUrl, "len:", r1.text?.length || 0);

      let ids = pickPlaceIdsFromText(r1.text);
      ids = uniq(ids).filter((id) => id !== excludePlaceId);
      if (ids.length) {
        console.log("[COMP][#1] ids:", ids.slice(0, limit));
        return ids.slice(0, limit);
      }
    } catch (e: any) {
      console.log("[COMP][#1] error:", e?.message || String(e));
    }

    // 2) m.place.naver.com 검색 HTML
    const url2 = `https://m.place.naver.com/search?query=${encoded}`;
    console.log("[COMP][findTopPlaceIds] try #2:", url2);

    try {
      const r2 = await fetchText(url2);
      console.log("[COMP][#2] status:", r2.status, "final:", r2.finalUrl, "len:", r2.text?.length || 0);

      let ids = pickPlaceIdsFromText(r2.text);
      ids = uniq(ids).filter((id) => id !== excludePlaceId);
      if (ids.length) {
        console.log("[COMP][#2] ids:", ids.slice(0, limit));
        return ids.slice(0, limit);
      }
    } catch (e: any) {
      console.log("[COMP][#2] error:", e?.message || String(e));
    }

    // 3) map.naver.com p/api 검색 JSON (최후 fallback)
    // - 구조가 바뀔 수 있어서 best-effort로만 시도
    const url3 = `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&searchCoord=&boundary=&displayCount=${Math.max(
      limit * 2,
      10
    )}`;
    console.log("[COMP][findTopPlaceIds] try #3 (json):", url3);

    try {
      const r3 = await fetchJson(url3, {
        referer: "https://map.naver.com/",
        "x-requested-with": "XMLHttpRequest"
      });
      console.log("[COMP][#3] status:", r3.status, "final:", r3.finalUrl);

      // json에서 placeId(혹은 id)를 최대한 파싱
      const rawText = r3.json ? JSON.stringify(r3.json) : r3.text;
      let ids = pickPlaceIdsFromText(rawText || "");
      ids = uniq(ids).filter((id) => id !== excludePlaceId);
      if (ids.length) {
        console.log("[COMP][#3] ids:", ids.slice(0, limit));
        return ids.slice(0, limit);
      }
    } catch (e: any) {
      console.log("[COMP][#3] error:", e?.message || String(e));
    }

    console.log("[COMP][findTopPlaceIds] no ids found for query:", q);
    return [];
  }

  /**
   * placeId 배열로 경쟁사 데이터 크롤링
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const ids = (placeIds || []).filter(Boolean).slice(0, limit);
    if (!ids.length) return [];

    const out: Competitor[] = [];
    for (const id of ids) {
      try {
        const url = buildCompetitorUrl(industry, id);
        console.log("[COMP][crawl] start:", id, url);

        const r = await this.crawler.crawlPlace(url);
        if (!r?.success || !r?.data) {
          console.log("[COMP][crawl] fail:", id, r?.error || "no data");
          continue;
        }

        out.push({
          placeId: id,
          url,
          name: r.data.name,
          address: r.data.address,
          keywords: Array.isArray(r.data.keywords) ? r.data.keywords : [],
          reviewCount: Number(r.data.reviewCount || 0),
          photoCount: Number(r.data.photoCount || 0)
        });

        console.log("[COMP][crawl] ok:", id, r.data?.name || "");
      } catch (e: any) {
        console.log("[COMP][crawl] error:", id, e?.message || String(e));
      }
    }

    return out;
  }
}
