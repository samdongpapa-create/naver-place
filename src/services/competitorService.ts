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

async function fetchText(url: string, extraHeaders?: Record<string, string>, timeoutMs = 6500) {
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

async function fetchJson(url: string, extraHeaders?: Record<string, string>, timeoutMs = 4500) {
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
 * ✅ OpenAPI 결과에서 placeId 후보 추출
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

  // 보조: 전체에서 숫자 후보
  try {
    const s = JSON.stringify(json);
    const m = s.match(/\b\d{5,12}\b/g) || [];
    ids.push(...m);
  } catch {}

  return uniq(ids);
}

/**
 * ✅ 핵심: /place/{id} 로 한번 접속해서 slug 포함 최종 URL을 얻고 /home 을 보장한다.
 * - 예: https://m.place.naver.com/place/144...  -> https://m.place.naver.com/hairshop/144.../home
 */
async function resolveHomeUrlByRedirect(placeId: string): Promise<string> {
  const base = `https://m.place.naver.com/place/${placeId}`;
  const r = await fetchText(base, { referer: "https://m.place.naver.com/" }, 6500);

  // finalUrl이 slug 포함으로 바뀌는 게 정상
  let u = String(r.finalUrl || base);

  // query 제거
  u = u.split("?")[0];

  // 이미 /home이면 그대로
  if (u.endsWith("/home")) return u;

  // .../{slug}/{id} 형태면 /home 붙이기
  if (new RegExp(`\\/\\d{5,12}$`).test(u)) return `${u}/home`;

  // 혹시 .../place/{id} 그대로면, 안전하게 /home 붙이기
  if (u.includes(`/place/${placeId}`)) return `https://m.place.naver.com/place/${placeId}/home`;

  // 기타 케이스
  return u.endsWith("/") ? `${u}home` : `${u}/home`;
}

/**
 * ✅ 무료(ModularCrawler)와 유사한 키워드 배열 패턴
 */
function extractKeywordsFromHtmlLikeFree(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  const patterns: RegExp[] = [
    /"keywordList"\s*:\s*(\[[^\]]{2,6000}\])/,
    /"keywords"\s*:\s*(\[[^\]]{2,6000}\])/,
    /"placeKeywords"\s*:\s*(\[[^\]]{2,6000}\])/
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
 * ✅ 같은 업체 중복 제거 (상호명 기준)
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
   * ✅ 경쟁사 후보(placeId) 찾기: OpenAPI 고정
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
    const url = `https://openapi.naver.com/v1/search/local.json?query=${encoded}&display=25&start=1&sort=random`;

    console.log("[COMP][OpenAPI] query:", q);

    try {
      const r = await fetchJson(url, { "X-Naver-Client-Id": cid, "X-Naver-Client-Secret": csec }, 4500);
      console.log("[COMP][OpenAPI] status:", r.status);
      if (!r.ok || !r.json) return [];

      let ids = extractPlaceIdsFromOpenApi(r.json)
        .filter((id) => /^\d{5,12}$/.test(id))
        .filter((id) => id !== String(excludePlaceId || "").trim());

      // 비용 절감
      ids = ids.slice(0, Math.max(limit * 8, 40));

      console.log("[COMP][OpenAPI] id candidates:", ids.length, ids.slice(0, 12));
      return ids;
    } catch (e: any) {
      console.log("[COMP][OpenAPI] error:", e?.message || String(e));
      return [];
    }
  }

  /**
   * ✅ 경쟁사 키워드만 추출 (중요: slug redirect 해결 후 진행)
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    _industry: Industry,
    limit = 5,
    opts?: { excludePlaceId?: string; myName?: string }
  ): Promise<Competitor[]> {
    const candidates = uniq((placeIds || []).filter(Boolean));
    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "").trim();
    const myName = normSpace(opts?.myName || "");

    const out: Competitor[] = [];
    const tried = new Set<string>();

    const CONCURRENCY = Number(process.env.COMPETITOR_CONCURRENCY || 2);

    let idx = 0;
    const worker = async () => {
      while (idx < candidates.length && out.length < limit * 4) {
        const id = candidates[idx++];
        if (!id) continue;
        if (tried.has(id)) continue;
        tried.add(id);

        if (!/^\d{5,12}$/.test(id)) continue;
        if (excludeId && id === excludeId) continue;

        try {
          // ✅ 핵심: slug 포함 home URL로 resolve
          const homeUrl = await resolveHomeUrlByRedirect(id);
          console.log("[COMP][resolve] id:", id, "->", homeUrl);

          // 1) FAST: HTML parse
          const r = await fetchText(homeUrl, { referer: "https://m.place.naver.com/" }, 6500);
          const html = r.text || "";
          const name1 = extractNameFromHtml(html);

          // 쉘 페이지(네이버 플레이스)면 바로 실패 처리 (시간 낭비 방지)
          if (name1 === "네이버 플레이스") {
            console.log("[COMP][shell] got Naver shell page:", id, "final:", r.finalUrl, "len:", html.length);
            continue;
          }

          if (myName && name1 && normSpace(name1) === myName) {
            console.log("[COMP][skip] same as myName:", id, name1);
            continue;
          }

          let keywords = extractKeywordsFromHtmlLikeFree(html);
          console.log("[COMP][kw] probed:", id, "name:", name1, "kw:", keywords.length, keywords);

          // 2) fallback: full crawl (여기도 resolve된 homeUrl 사용!)
          if (!keywords.length) {
            try {
              const full = await this.crawler.crawlPlace(homeUrl);
              const nm2 = full?.data?.name ? String(full.data.name) : name1;
              const k2 = Array.isArray(full?.data?.keywords) ? full.data.keywords : [];

              if (nm2 === "네이버 플레이스") {
                console.log("[COMP][full] shell page:", id);
                continue;
              }

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
            url: homeUrl,
            name: name1,
            keywords
          });
        } catch (e: any) {
          console.log("[COMP][crawl] error:", id, e?.message || String(e));
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

    const cleaned = dedupeCompetitors(out, limit);
    console.log("[COMP][crawl-fast] final competitors:", cleaned.length);
    return cleaned;
  }
}
