// src/services/competitorService.ts
import type { Industry } from "../lib/scoring/types";

type Competitor = {
  placeId: string;
  name?: string;
  url?: string;
  keywords?: string[];
};

type CrawlOpts = {
  excludePlaceId?: string;
  myName?: string; // 내 업체명으로 중복/자기자신 제거
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function normName(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^\w가-힣]/g, "");
}

/** --- low-level fetch helpers --- */
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

async function fetchText(url: string, extraHeaders?: Record<string, string>) {
  const res = await fetch(url, {
    method: "GET",
    redirect: "follow",
    headers: {
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
      accept: "text/html,application/json,text/plain,*/*",
      ...extraHeaders
    }
  });

  const text = await res.text();
  return { ok: res.ok, status: res.status, text, finalUrl: res.url };
}

async function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const tp = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([p, tp]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * ✅ JSON 전체에서 5~12자리 숫자 후보를 전부 수집
 * - placeId가 어떤 키에 들어있든 관계없이 문자열/숫자 모두 긁어옴
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

/** --- HTML extraction (키워드/이름) --- */
function decodeHtml(s: string) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

function extractNameFromHtml(html: string): string {
  const s = String(html || "");
  if (!s) return "";

  const m1 = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m1?.[1]) return decodeHtml(m1[1]).trim();

  const m2 = s.match(/<title>\s*([^<]+)\s*<\/title>/i);
  if (m2?.[1]) {
    const t = decodeHtml(m2[1]).replace(/:\s*네이버.*$/i, "").trim();
    return t;
  }

  const m3 = s.match(/"name"\s*:\s*"([^"]{2,80})"/);
  if (m3?.[1]) return decodeHtml(m3[1]).trim();

  return "";
}

function safeParseStringArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.map((x) => String(x || "").trim()).filter(Boolean);
  } catch {}
  return [];
}

function cleanKeywordList(arr: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();

  for (const x of arr || []) {
    const k = String(x || "")
      .replace(/\s+/g, "")
      .replace(/[^\w가-힣]/g, "")
      .trim();

    if (!k) continue;
    if (k.length < 2 || k.length > 18) continue;
    if (/^(네이버|플레이스)$/.test(k)) continue;
    if (/(할인|이벤트|가격|예약|쿠폰|리뷰|추천)$/.test(k)) continue;

    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
    if (out.length >= 30) break;
  }

  return out;
}

/**
 * ✅ 무료 크롤러가 하던 방식과 “동일 계열”
 * - page HTML에서 키워드 배열 패턴을 찾는다
 */
function extractKeywordsFromHtml(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  // 1) 흔한 패턴들
  const patterns = [
    /"keywords"\s*:\s*(\[[^\]]+\])/,
    /"keywordList"\s*:\s*(\[[^\]]+\])/,
    /"keyword"\s*:\s*(\[[^\]]+\])/,
    /"placeKeywords"\s*:\s*(\[[^\]]+\])/,
    /"keywordsJson"\s*:\s*(\[[^\]]+\])/
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) {
      const arr = safeParseStringArray(m[1]);
      const cleaned = cleanKeywordList(arr);
      if (cleaned.length) return cleaned.slice(0, 20);
    }
  }

  // 2) 최후 fallback: 문자열 배열 후보를 여러 개 찾고 그 중 그럴싸한 것 선택
  const re = /\[(?:"[^"\n]{2,30}"\s*,\s*){2,30}"[^"\n]{2,30}"\]/g;
  const matches = s.match(re) || [];
  const parsed: string[][] = [];

  for (const raw of matches.slice(0, 60)) {
    const arr = safeParseStringArray(raw);
    if (!arr.length) continue;

    // 점수화: 한글 포함/URL 포함/길이
    let score = 0;
    for (const it of arr) {
      const t = String(it || "");
      if (/[가-힣]/.test(t)) score += 1;
      if (/https?:\/\//i.test(t)) score -= 3;
      if (t.length > 20) score -= 1;
    }
    if (score >= 6) parsed.push(arr);
  }

  parsed.sort((a, b) => countKo(b) - countKo(a));

  for (const arr of parsed) {
    const cleaned = cleanKeywordList(arr);
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  return [];

  function countKo(arr: string[]) {
    return arr.filter((x) => /[가-힣]/.test(String(x || ""))).length;
  }
}

/**
 * ✅ 핵심: /place/{id} 로 먼저 hit → redirect 최종 URL에서 slug를 알아낸다
 * - 어떤 id가 들어와도 /hairshop/{id}/home 같은 “진짜 페이지”를 최대한 확보
 */
async function resolveBestHomeUrl(placeId: string): Promise<string> {
  const tries = [
    `https://m.place.naver.com/place/${placeId}`, // ← 이게 제일 잘 redirect 나옴
    `https://m.place.naver.com/place/${placeId}/home`,
    `https://m.place.naver.com/place/${placeId}?entry=pll`,
    `https://m.place.naver.com/place/${placeId}/home?entry=pll`
  ];

  for (const u of tries) {
    try {
      const r = await fetchText(u, { referer: "https://m.place.naver.com/" });
      const finalUrl = r.finalUrl || u;

      // finalUrl이 이미 /hairshop/{id}/... 형태면 home으로 맞춤
      const m = finalUrl.match(/https:\/\/m\.place\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{5,12})(\/[a-zA-Z0-9_]+)?/);
      if (m?.[1] && m?.[2]) {
        const slug = m[1];
        const pid = m[2];
        return `https://m.place.naver.com/${slug}/${pid}/home`;
      }
      // 그래도 /place/{id}면 home 고정
      if (/\/place\/\d{5,12}/.test(finalUrl)) {
        return `https://m.place.naver.com/place/${placeId}/home`;
      }
    } catch {}
  }

  return `https://m.place.naver.com/place/${placeId}/home`;
}

/** --- service --- */
export class CompetitorService {
  constructor() {}

  async close() {
    // 서버.ts finally에서 호출하므로 유지
    return;
  }

  /**
   * ✅ OpenAPI / map search JSON 기반 후보 placeId 추출 (너가 쓰던 방식 그대로)
   * - (m.map은 Railway에서 500 나는 경우가 많아서 안 씀)
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const encoded = encodeURIComponent(q);

    const urls = [
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=place&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=local&displayCount=50`
    ];

    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`[COMP][OpenAPI] query: ${q}`);
      console.log(`[COMP][OpenAPI] try #${i + 1}:`, url);

      const r = await fetchJson(url, {
        referer: "https://map.naver.com/",
        "x-requested-with": "XMLHttpRequest"
      });

      console.log(`[COMP][OpenAPI] status:`, r.status);

      if (!r.ok || !r.json) continue;

      let ids = collectIdCandidatesFromAnyJson(r.json);
      ids = ids.filter((id) => id !== excludePlaceId);
      ids = uniq(ids).filter((id) => /^\d{5,12}$/.test(id));

      // 너무 많으면 비용 절감
      ids = ids.slice(0, 80);

      console.log(`[COMP][OpenAPI] id candidates: ${ids.length}`, ids.slice(0, 20));

      if (ids.length) {
        return ids.slice(0, Math.max(limit * 6, 30));
      }
    }

    console.log("[COMP][findTopPlaceIds] no candidates for query:", q);
    return [];
  }

  /**
   * ✅ 경쟁사: “키워드만” 빠르게 추출
   * - 1) placeId → redirect 기반으로 slug home URL resolve
   * - 2) 해당 URL HTML에서 name/keywords 추출
   * - 3) shell(네이버플레이스) / 키워드0 / 내업체 / 중복 제거
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5, opts?: CrawlOpts): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean).filter((x) => /^\d{5,12}$/.test(x));
    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "");
    const myNameN = normName(String(opts?.myName || ""));

    const out: Competitor[] = [];
    const seenId = new Set<string>();
    const seenName = new Set<string>();

    // ✅ 병렬(너무 세게 때리면 block/timeout ↑) → 3~4가 적당
    const CONCURRENCY = Number(process.env.COMPETITOR_CONCURRENCY || 3);
    const PER_TASK_TIMEOUT = Number(process.env.COMPETITOR_TASK_TIMEOUT_MS || 2500);

    let idx = 0;

    const worker = async () => {
      while (idx < candidates.length && out.length < limit) {
        const id = candidates[idx++];
        if (!id) continue;
        if (id === excludeId) continue;
        if (seenId.has(id)) continue;

        try {
          const comp = await withTimeout(this.fetchCompetitorKeywordsOnly(id, myNameN), PER_TASK_TIMEOUT, "kw-timeout");
          if (!comp) continue;

          // 내 업체명 제거
          const nName = normName(comp.name || "");
          if (myNameN && nName && nName === myNameN) continue;

          // name 중복 제거(같은 업체가 다른 placeId로 중복될 때)
          if (nName && seenName.has(nName)) continue;

          seenId.add(id);
          if (nName) seenName.add(nName);

          out.push(comp);
        } catch (e: any) {
          // 조용히 패스 (timeout/403 등)
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    // 혹시 name 중복으로 빠져서 limit 미만이면 그대로 리턴
    return out.slice(0, limit);
  }

  private async fetchCompetitorKeywordsOnly(placeId: string, myNameN: string): Promise<Competitor | null> {
    // 1) home URL resolve (slug)
    const url = await resolveBestHomeUrl(placeId);
    console.log("[COMP][resolve] id:", placeId, "->", url);

    // 2) 실제 페이지 fetch
    const r = await fetchText(url, { referer: "https://m.place.naver.com/" });
    if (!r.ok || !r.text) return null;

    const html = r.text;
    const len = html.length;

    // shell 컷 (너 로그에서 243k가 shell)
    if (len < 320_000) {
      // 그래도 키워드가 있으면 살려봄
      const kwTry = extractKeywordsFromHtml(html);
      if (!kwTry.length) {
        console.log("[COMP][shell] got Naver shell page:", placeId, "final:", r.finalUrl, "len:", len);
        return null;
      }
    }

    const name = extractNameFromHtml(html) || "";
    if (!name || name.includes("네이버 플레이스")) return null;

    // 내 업체와 이름 동일하면 컷(방어)
    const nName = normName(name);
    if (myNameN && nName && nName === myNameN) return null;

    const keywords = extractKeywordsFromHtml(html);

    console.log("[COMP][kw] probed:", placeId, "name:", name, "kw:", keywords.length, keywords.slice(0, 10));

    if (!keywords.length) return null;

    return { placeId, name, url: r.finalUrl || url, keywords };
  }
}
