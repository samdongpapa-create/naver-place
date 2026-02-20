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
  return `https://m.place.naver.com/place/${placeId}/home`;
}

/**
 * ✅ JSON 전체에서 5~12자리 숫자 후보를 전부 수집
 * - placeId가 어떤 키에 들어있든 관계없이 문자열/숫자 모두 긁어옴
 * - 후보가 많을 수 있으니 상위 일부만 사용
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

  // 5~12자리 숫자 후보 전부
  const ids = s.match(/\b\d{5,12}\b/g) || [];
  return uniq(ids);
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
   * ✅ 검색어로 경쟁사 placeId 후보 뽑기 (best-effort)
   * - 현재 환경(Railway)에서 m.map.naver.com 은 500이 뜰 수 있어
   * - m.place.naver.com/search 도 404인 케이스가 있어
   * - 그래서 map.naver.com/p/api/search/* JSON을 주력으로 씀
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const encoded = encodeURIComponent(q);

    // ✅ 엔드포인트 여러 개 시도 (구조가 바뀌어도 하나는 살아남게)
    const candidatesUrls = [
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=place&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=local&displayCount=50`
    ];

    for (let i = 0; i < candidatesUrls.length; i++) {
      const url = candidatesUrls[i];
      console.log(`[COMP][findTopPlaceIds] try #${i + 1} (json):`, url);

      try {
        const r = await fetchJson(url, {
          referer: "https://map.naver.com/",
          "x-requested-with": "XMLHttpRequest"
        });

        console.log(`[COMP][#${i + 1}] status:`, r.status, "final:", r.finalUrl);

        if (!r.ok || !r.json) {
          console.log(`[COMP][#${i + 1}] json parse fail or non-ok`);
          continue;
        }

        // ✅ 디버깅 로그(구조 파악용) — 너무 길게 안 찍고 앞부분만
        try {
          const topKeys = typeof r.json === "object" && !Array.isArray(r.json) ? Object.keys(r.json).slice(0, 20) : [];
          console.log(`[COMP][#${i + 1}] topKeys:`, topKeys);

          const snippet = JSON.stringify(r.json).slice(0, 600);
          console.log(`[COMP][#${i + 1}] jsonSnippet(600):`, snippet);
        } catch {}

        let ids = collectIdCandidatesFromAnyJson(r.json);

        // 내 placeId 제외
        ids = ids.filter((id) => id !== excludePlaceId);

        // 후보가 너무 많으면 일부만(크롤링 시도 비용 절감)
        ids = ids.slice(0, 80);

        console.log(`[COMP][#${i + 1}] extracted id candidates:`, ids.length, ids.slice(0, 20));

        if (ids.length) {
          // 여기서는 "후보"만 반환 — 실제 유효성은 crawlCompetitorsByIds에서 검증
          return ids.slice(0, Math.max(limit * 5, 25));
        }
      } catch (e: any) {
        console.log(`[COMP][#${i + 1}] error:`, e?.message || String(e));
      }
    }

    console.log("[COMP][findTopPlaceIds] no candidates found for query:", q);
    return [];
  }

  /**
   * ✅ 후보 placeId들을 실제로 크롤링해서 "성공한 애들만" 경쟁사로 확정
   * - candidates에 쓰레기 숫자가 섞여 있어도 상관 없음 (실패하면 버림)
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean);

    if (!candidates.length) return [];

    const out: Competitor[] = [];
    const tried = new Set<string>();

    for (const id of candidates) {
      if (out.length >= limit) break;
      if (tried.has(id)) continue;
      tried.add(id);

      // 너무 짧거나 너무 길면 스킵
      if (!/^\d{5,12}$/.test(id)) continue;

      try {
        const url = buildCompetitorUrl(id);
        console.log("[COMP][crawl] try:", id, url);

        const r = await this.crawler.crawlPlace(url);

        if (!r?.success || !r?.data?.name) {
          // invalid id candidate
          continue;
        }

        // name/address가 있는 정상 place만 채택
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
