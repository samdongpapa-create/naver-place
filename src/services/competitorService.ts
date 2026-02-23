// src/services/competitorService.ts
import { ModularCrawler } from "./modularCrawler";
import type { Industry } from "../lib/scoring/types";

type Competitor = {
  placeId: string;
  name?: string;
  keywords?: string[];
  url?: string;
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function normSpace(s: string) {
  return String(s || "").replace(/\s+/g, " ").trim();
}

function buildCompetitorUrl(placeId: string) {
  return `https://m.place.naver.com/place/${placeId}/home`;
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

/**
 * ✅ JSON 전체에서 5~12자리 숫자 후보를 전부 수집 (네가 원래 쓰던 방식)
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
 * ✅ 무료(ModularCrawler)에서 잡히던 "키워드 배열 패턴"을 경쟁사 HTML에서도 최대한 동일하게 적용
 */
function extractKeywordsFromHtmlLikeFree(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  const patterns: RegExp[] = [
    /"keywordList"\s*:\s*(\[[^\]]{2,4000}\])/,
    /"keywords"\s*:\s*(\[[^\]]{2,4000}\])/,
    /"placeKeywords"\s*:\s*(\[[^\]]{2,4000}\])/,
    /"keyword"\s*:\s*(\[[^\]]{2,4000}\])/
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (!m?.[1]) continue;

    const arrText = m[1];

    try {
      const parsed = JSON.parse(arrText);
      if (Array.isArray(parsed)) {
        const kws = parsed
          .map((x) => String(x || "").trim())
          .filter(Boolean)
          .slice(0, 20);
        return uniq(kws);
      }
    } catch {
      // JSON 파싱 실패 시 문자열만 뽑기
      const words = arrText.match(/"([^"]{1,40})"/g)?.map((x) => x.replace(/"/g, "").trim()) || [];
      const kws = words.filter(Boolean).slice(0, 20);
      if (kws.length) return uniq(kws);
    }
  }

  return [];
}

function extractNameFromHtml(html: string): string {
  const s = String(html || "");
  if (!s) return "";

  const mt = s.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
  if (mt?.[1]) return mt[1].replace(/-.*$/g, "").trim();

  const m2 = s.match(/"name"\s*:\s*"([^"]{2,60})"/);
  if (m2?.[1]) return m2[1].trim();

  return "";
}

/**
 * ✅ 같은 업체가 서로 다른 placeId로 잡히는 케이스 제거(상호명 기준)
 */
function dedupeCompetitors(list: Competitor[], limit: number) {
  const byName = new Map<string, Competitor>();
  const byId = new Set<string>();

  for (const c of list) {
    if (!c?.placeId) continue;
    if (byId.has(c.placeId)) continue;
    byId.add(c.placeId);

    const nm = normSpace(c.name || "");
    const key = nm || c.placeId;

    if (byName.has(key)) continue;
    byName.set(key, c);

    if (byName.size >= limit) break;
  }

  return Array.from(byName.values()).slice(0, limit);
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
   * ✅ 경쟁사 placeId 후보 찾기 (map API를 완전히 버리지 않고 3단 폴백)
   * 1) map.naver.com/p/api/search/allSearch (기존)
   * 2) map.naver.com/v5/api/search (폴백)
   * 3) m.map.naver.com/search2 HTML에서 placeId 정규식 추출 (최후)
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const encoded = encodeURIComponent(q);
    const exclude = String(excludePlaceId || "").trim();

    const candidates: string[] = [];

    // 1) p/api/search/allSearch
    const urls1 = [
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=place&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=local&displayCount=50`
    ];

    for (let i = 0; i < urls1.length; i++) {
      const url = urls1[i];
      console.log(`[COMP][findTopPlaceIds] try p/api #${i + 1}:`, url);

      try {
        const r = await fetchJson(url, {
          referer: "https://map.naver.com/",
          "x-requested-with": "XMLHttpRequest"
        });

        console.log(`[COMP][p/api #${i + 1}] status:`, r.status);

        if (r.ok && r.json) {
          let ids = collectIdCandidatesFromAnyJson(r.json);
          ids = ids.filter((id) => id !== exclude);
          ids = ids.slice(0, Math.max(limit * 6, 30));
          if (ids.length) {
            console.log("[COMP][p/api] id candidates:", ids.length, ids.slice(0, 12));
            return ids;
          }
        }
      } catch (e: any) {
        console.log("[COMP][p/api] error:", e?.message || String(e));
      }
    }

    // 2) v5/api/search (다른 구조)
    const url2 = `https://map.naver.com/v5/api/search?caller=pcweb&query=${encoded}&type=place&page=1&displayCount=50&isPlaceRecommendationReplace=true&lang=ko`;
    console.log("[COMP][findTopPlaceIds] try v5:", url2);
    try {
      const r2 = await fetchJson(url2, { referer: "https://map.naver.com/" });
      console.log("[COMP][v5] status:", r2.status);

      if (r2.ok && r2.json) {
        let ids = collectIdCandidatesFromAnyJson(r2.json);
        ids = ids.filter((id) => id !== exclude);
        ids = ids.slice(0, Math.max(limit * 6, 30));
        if (ids.length) {
          console.log("[COMP][v5] id candidates:", ids.length, ids.slice(0, 12));
          return ids;
        }
      }
    } catch (e: any) {
      console.log("[COMP][v5] error:", e?.message || String(e));
    }

    // 3) m.map.naver.com HTML 최후 폴백
    const url3 = `https://m.map.naver.com/search2/search.naver?query=${encoded}`;
    console.log("[COMP][findTopPlaceIds] try m.map HTML:", url3);
    try {
      const r3 = await fetchText(url3, { referer: "https://m.map.naver.com/" });
      console.log("[COMP][m.map] status:", r3.status);

      if (r3.ok && r3.text) {
        const html = r3.text;

        // placeId 후보: /place/1234567890 혹은 "placeId":"123..."
        const mA = html.match(/\/place\/(\d{5,12})/g) || [];
        for (const x of mA) {
          const m = x.match(/(\d{5,12})/);
          if (m?.[1]) candidates.push(m[1]);
        }
        const mB = html.match(/"placeId"\s*:\s*"(\d{5,12})"/g) || [];
        for (const x of mB) {
          const m = x.match(/"placeId"\s*:\s*"(\d{5,12})"/);
          if (m?.[1]) candidates.push(m[1]);
        }

        const ids = uniq(candidates).filter((id) => id !== exclude).slice(0, Math.max(limit * 6, 30));
        if (ids.length) {
          console.log("[COMP][m.map] id candidates:", ids.length, ids.slice(0, 12));
          return ids;
        }
      }
    } catch (e: any) {
      console.log("[COMP][m.map] error:", e?.message || String(e));
    }

    console.log("[COMP][findTopPlaceIds] no candidates for query:", q);
    return [];
  }

  /**
   * ✅ 경쟁사 키워드만 추출 (무료 방식 최대한 동일)
   * - 1차: HTML에서 키워드 배열 패턴 추출(빠름)
   * - 2차: 실패 시에만 crawler.crawlPlace(url)로 키워드 재시도(확실)
   * - 내 업체 제외 + 중복 제거
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    _industry: Industry,
    limit = 5,
    opts?: { excludePlaceId?: string; myName?: string; myAddress?: string }
  ): Promise<Competitor[]> {
    const candidates = uniq((placeIds || []).filter(Boolean));
    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "").trim();
    const myName = normSpace(opts?.myName || "");

    const out: Competitor[] = [];
    const tried = new Set<string>();

    // Railway 안정성: 동시성 2 추천
    const CONCURRENCY = Number(process.env.COMPETITOR_CONCURRENCY || 2);

    let idx = 0;
    const worker = async () => {
      while (idx < candidates.length && out.length < limit * 3) {
        const id = candidates[idx++];
        if (!id) continue;
        if (tried.has(id)) continue;
        tried.add(id);

        if (!/^\d{5,12}$/.test(id)) continue;
        if (excludeId && id === excludeId) continue;

        const url = buildCompetitorUrl(id);

        try {
          // 1) FAST: HTML fetch + keyword parse
          const r = await fetchText(url, { referer: "https://m.place.naver.com/" });
          const html = r.text || "";
          const name1 = extractNameFromHtml(html);

          if (myName && name1 && normSpace(name1) === myName) {
            console.log("[COMP][skip] same as myName:", id, name1);
            continue;
          }

          let keywords = extractKeywordsFromHtmlLikeFree(html);
          console.log("[COMP][kw] probed:", id, "name:", name1, "kw:", keywords.length, keywords);

          // 2) fallback full crawl
          if (!keywords.length) {
            console.log(
              "[COMP][kw] empty keywords:",
              id,
              "name:",
              name1,
              "htmlLen:",
              html.length
            );

            try {
              const full = await this.crawler.crawlPlace(url);
              const nm2 = full?.data?.name ? String(full.data.name) : name1;
              const k2 = Array.isArray(full?.data?.keywords) ? full.data.keywords : [];

              if (myName && nm2 && normSpace(nm2) === myName) {
                console.log("[COMP][skip] same as myName(full):", id, nm2);
                continue;
              }

              keywords = uniq(k2.map((x: any) => String(x || "").trim()).filter(Boolean)).slice(0, 20);

              console.log("[COMP][kw] full-crawl:", id, "name:", nm2, "kw:", keywords.length, keywords);
            } catch (e: any) {
              console.log("[COMP][kw] full-crawl error:", id, e?.message || String(e));
            }
          }

          if (!keywords.length) continue;

          out.push({
            placeId: id,
            url,
            name: name1,
            keywords
          });
        } catch (e: any) {
          console.log("[COMP][crawl] error:", id, e?.message || String(e));
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    // 동일 상호명 중복 제거 + limit
    const cleaned = dedupeCompetitors(out, limit);
    console.log("[COMP][crawl-fast] final competitors:", cleaned.length);

    return cleaned;
  }
}
