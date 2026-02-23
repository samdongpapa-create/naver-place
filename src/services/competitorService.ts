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

async function fetchText(url: string, extraHeaders?: Record<string, string>, timeoutMs = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJson(url: string, extraHeaders?: Record<string, string>, timeoutMs = 6000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      signal: ac.signal,
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
  } finally {
    clearTimeout(timer);
  }
}

/**
 * ✅ Naver Search OpenAPI(Local)로 경쟁사 후보 찾기
 * - Railway에서 map.* 계열이 불안정하니 여기로 고정
 * - items[].link 에서 placeId 추출
 * - 혹시 link에 placeId가 없으면 JSON 전체에서 숫자 후보 추출(보조)
 */
function extractPlaceIdsFromOpenApi(json: any): string[] {
  if (!json) return [];
  const ids: string[] = [];

  const items = Array.isArray(json?.items) ? json.items : [];
  for (const it of items) {
    const link = String(it?.link || "");
    const m1 = link.match(/\/place\/(\d{5,12})/);
    if (m1?.[1]) ids.push(m1[1]);

    const m2 = link.match(/m\.place\.naver\.com\/place\/(\d{5,12})/);
    if (m2?.[1]) ids.push(m2[1]);
  }

  // 보조: json 전체에서 5~12자리 숫자 후보 수집
  try {
    const s = JSON.stringify(json);
    const m = s.match(/\b\d{5,12}\b/g) || [];
    ids.push(...m);
  } catch {}

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
        return uniq(parsed.map((x) => String(x || "").trim()).filter(Boolean)).slice(0, 20);
      }
    } catch {
      const words =
        arrText.match(/"([^"]{1,40})"/g)?.map((x) => x.replace(/"/g, "").trim()).filter(Boolean) || [];
      if (words.length) return uniq(words).slice(0, 20);
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
   * ✅ 경쟁사 placeId 후보 찾기 (OpenAPI 고정)
   * - NAVER_CLIENT_ID / NAVER_CLIENT_SECRET 필수
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = normSpace(query);
    if (!q) return [];

    const cid = String(process.env.NAVER_CLIENT_ID || "").trim();
    const csec = String(process.env.NAVER_CLIENT_SECRET || "").trim();

    if (!cid || !csec) {
      console.log("[COMP][OpenAPI] missing env NAVER_CLIENT_ID / NAVER_CLIENT_SECRET");
      return [];
    }

    const encoded = encodeURIComponent(q);
    const url = `https://openapi.naver.com/v1/search/local.json?query=${encoded}&display=20&start=1&sort=random`;

    console.log("[COMP][OpenAPI] query:", q);

    try {
      const r = await fetchJson(
        url,
        {
          "X-Naver-Client-Id": cid,
          "X-Naver-Client-Secret": csec
        },
        4500
      );

      console.log("[COMP][OpenAPI] status:", r.status);

      if (!r.ok || !r.json) return [];

      let ids = extractPlaceIdsFromOpenApi(r.json);

      const ex = String(excludePlaceId || "").trim();
      if (ex) ids = ids.filter((id) => id !== ex);

      // 후보가 너무 많으면 절제 (비용/시간 절감)
      ids = ids.filter((id) => /^\d{5,12}$/.test(id)).slice(0, Math.max(limit * 6, 30));

      console.log("[COMP][OpenAPI] id candidates:", ids.length, ids.slice(0, 12));
      return ids;
    } catch (e: any) {
      console.log("[COMP][OpenAPI] error:", e?.message || String(e));
      return [];
    }
  }

  /**
   * ✅ 경쟁사 키워드만 추출
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
          const r = await fetchText(url, { referer: "https://m.place.naver.com/" }, 6500);
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
            console.log("[COMP][kw] empty keywords:", id, "name:", name1, "htmlLen:", html.length);

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
