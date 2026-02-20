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

function isPlaceIdLike(v: unknown): v is string | number {
  if (typeof v === "number") {
    // 5~12자리 숫자
    return Number.isInteger(v) && v >= 10000 && v <= 999999999999;
  }
  if (typeof v === "string") {
    const s = v.trim();
    return /^\d{5,12}$/.test(s);
  }
  return false;
}

function toPlaceIdString(v: string | number): string {
  return typeof v === "number" ? String(v) : v.trim();
}

/**
 * ✅ allSearch JSON에서 placeId를 "재귀적으로" 수집
 * - key가 id/placeId/bizId 등으로 다양할 수 있음
 * - 숫자(number)로 오는 케이스도 포함
 */
function collectPlaceIdsFromJson(json: any): string[] {
  const out: string[] = [];
  const seen = new Set<any>();

  const goodKey = (k: string) => {
    const low = k.toLowerCase();
    // place 관련 id 후보들
    return (
      low === "placeid" ||
      low.endsWith("placeid") ||
      low === "id" ||
      low.endsWith("id") ||
      low.includes("bizid") ||
      low.includes("place_id")
    );
  };

  const walk = (node: any, parentKey?: string) => {
    if (node == null) return;
    if (typeof node !== "object") return;
    if (seen.has(node)) return;
    seen.add(node);

    if (Array.isArray(node)) {
      for (const item of node) walk(item, parentKey);
      return;
    }

    for (const [k, v] of Object.entries(node)) {
      // 1) 키 기반 id 후보
      if (goodKey(k) && isPlaceIdLike(v)) {
        out.push(toPlaceIdString(v as any));
      }

      // 2) value가 객체/배열이면 계속 순회
      if (v && typeof v === "object") {
        walk(v, k);
      } else {
        // 3) 아주 드물게 URL 문자열에 /place/1234 패턴이 들어올 수 있어 regex도 한번
        if (typeof v === "string" && v.includes("/place/")) {
          const m = v.match(/\/place\/(\d{5,12})/);
          if (m?.[1]) out.push(m[1]);
        }
      }
    }
  };

  walk(json);
  return uniq(out);
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

function buildCompetitorUrl(placeId: string) {
  // slug 없이도 리다이렉트 되게 /place/{id}/home로 통일
  return `https://m.place.naver.com/place/${placeId}/home`;
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

  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const encoded = encodeURIComponent(q);

    // #1, #2는 지금 로그상 막히므로 그대로 두되, 실질적으로 #3가 메인
    const url1 = `https://m.map.naver.com/search2/search.naver?query=${encoded}`;
    console.log("[COMP][findTopPlaceIds] try #1:", url1);

    try {
      const r1 = await fetchText(url1);
      console.log("[COMP][#1] status:", r1.status, "final:", r1.finalUrl, "len:", r1.text?.length || 0);
      // 막히면 len 0으로 끝날 것
    } catch (e: any) {
      console.log("[COMP][#1] error:", e?.message || String(e));
    }

    const url2 = `https://m.place.naver.com/search?query=${encoded}`;
    console.log("[COMP][findTopPlaceIds] try #2:", url2);

    try {
      const r2 = await fetchText(url2);
      console.log("[COMP][#2] status:", r2.status, "final:", r2.finalUrl, "len:", r2.text?.length || 0);
    } catch (e: any) {
      console.log("[COMP][#2] error:", e?.message || String(e));
    }

    // ✅ 메인: allSearch JSON
    const url3 = `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&searchCoord=&boundary=&displayCount=${Math.max(
      limit * 4,
      20
    )}`;
    console.log("[COMP][findTopPlaceIds] try #3 (json):", url3);

    try {
      const r3 = await fetchJson(url3, {
        referer: "https://map.naver.com/",
        "x-requested-with": "XMLHttpRequest"
      });

      console.log("[COMP][#3] status:", r3.status, "final:", r3.finalUrl);

      if (!r3.ok || !r3.json) {
        console.log("[COMP][#3] no json (parse fail or non-ok)");
        return [];
      }

      // ✅ 여기 핵심
      let ids = collectPlaceIdsFromJson(r3.json);

      // exclude + 정리
      ids = ids.filter((id) => id !== excludePlaceId);

      // 너무 많이 나오면 앞에서 limit*5까지만 (잡음 id 섞일 수 있음)
      ids = ids.slice(0, Math.max(limit * 5, 25));

      // 최종 unique + limit
      ids = uniq(ids);

      console.log("[COMP][#3] extracted ids:", ids.length, ids.slice(0, 15));
      return ids.slice(0, limit);
    } catch (e: any) {
      console.log("[COMP][#3] error:", e?.message || String(e));
    }

    console.log("[COMP][findTopPlaceIds] no ids found for query:", q);
    return [];
  }

  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const ids = (placeIds || []).filter(Boolean).slice(0, limit);
    if (!ids.length) return [];

    const out: Competitor[] = [];

    for (const id of ids) {
      try {
        const url = buildCompetitorUrl(id);
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
