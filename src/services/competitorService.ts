// src/services/competitorService.ts
import type { Industry } from "../lib/scoring/types";
import { ModularCrawler } from "./modularCrawler";

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

function extractPlaceIdsFromText(text: string): string[] {
  const ids = String(text || "").match(/\b\d{5,12}\b/g) || [];
  return uniq(ids);
}

async function fetchJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { method: "GET", headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json, text };
}

/**
 * ✅ 네이버 공식 지역 검색 API로 후보 추출 (가장 안정/빠름)
 * Docs: https://developers.naver.com/docs/serviceapi/search/local/local.md :contentReference[oaicite:1]{index=1}
 */
async function naverLocalSearchCandidates(query: string, display = 20): Promise<{ ids: string[]; raw?: any }> {
  const clientId = process.env.NAVER_CLIENT_ID || "";
  const clientSecret = process.env.NAVER_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return { ids: [] };

  const q = encodeURIComponent((query || "").trim());
  const d = Math.max(5, Math.min(display, 30));
  const url = `https://openapi.naver.com/v1/search/local.json?query=${q}&display=${d}&start=1&sort=random`;

  const headers = {
    "X-Naver-Client-Id": clientId,
    "X-Naver-Client-Secret": clientSecret,
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
    "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7"
  };

  const r = await fetchJson(url, headers);

  if (!r.ok || !r.json) {
    console.log("[COMP][OpenAPI] non-ok:", r.status);
    return { ids: [], raw: r.json };
  }

  const items = Array.isArray(r.json?.items) ? r.json.items : [];
  const bag: string[] = [];

  for (const it of items) {
    // local api item: title/address/roadAddress/mapx/mapy/link 등 포함될 수 있음
    // placeId는 link나 텍스트 어딘가에 섞여있을 때가 많아서 “전체 문자열”로 긁는다.
    const blob = JSON.stringify(it || {});
    bag.push(...extractPlaceIdsFromText(blob));
  }

  return { ids: uniq(bag), raw: r.json };
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
   * ✅ OpenAPI 기반 후보 placeId 추출
   * - Railway에서 m.map.naver.com이 타임아웃/차단이라도 정상 동작
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    // ✅ 키 없으면 “빨리 포기” (유료 API가 느려지지 않게)
    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
      console.log("[COMP][OpenAPI] missing NAVER_CLIENT_ID/SECRET -> return []");
      return [];
    }

    console.log("[COMP][OpenAPI] query:", q);

    // 후보 20개 정도만 받아도 충분 (검증 crawl에서 걸러짐)
    const { ids } = await naverLocalSearchCandidates(q, 25);

    const filtered = ids
      .filter((id) => id !== excludePlaceId)
      .filter((id) => /^\d{5,12}$/.test(id))
      .slice(0, Math.max(limit * 6, 25)); // 검증용 여유

    console.log("[COMP][OpenAPI] id candidates:", filtered.length, filtered.slice(0, 15));
    return filtered;
  }

  /**
   * ✅ 후보들을 실제 place 크롤링으로 검증해서 Top5 확정
   * - 느려지지 않게 하드 타임 제한
   */
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
        console.log("[COMP][crawl] try:", id);

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
