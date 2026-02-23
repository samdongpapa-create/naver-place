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
  myName?: string; // 내 업체명으로 자기자신 제거(추가 방어)
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

/** --- fetch helpers --- */
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

/** --- HTML utils --- */
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
 * ✅ “무료버전과 같은 계열”의 키워드 추출
 * - HTML 내 keywords/keywordList/.. 배열 패턴 우선
 * - 안 나오면 그럴듯한 문자열 배열 fallback
 */
function extractKeywordsFromHtml(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  const patterns = [
    /"keywords"\s*:\s*(\[[^\]]+\])/,
    /"keywordList"\s*:\s*(\[[^\]]+\])/,
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

  // fallback: 문자열 배열 후보 중 “한글이 많고 URL이 적은 것” 우선
  const re = /\[(?:"[^"\n]{2,30}"\s*,\s*){2,30}"[^"\n]{2,30}"\]/g;
  const matches = s.match(re) || [];
  const parsed: { arr: string[]; score: number }[] = [];

  for (const raw of matches.slice(0, 80)) {
    const arr = safeParseStringArray(raw);
    if (!arr.length) continue;

    let score = 0;
    for (const it of arr) {
      const t = String(it || "");
      if (/[가-힣]/.test(t)) score += 1;
      if (/https?:\/\//i.test(t)) score -= 3;
      if (t.length > 20) score -= 1;
    }
    if (score >= 6) parsed.push({ arr, score });
  }

  parsed.sort((a, b) => b.score - a.score);

  for (const p of parsed) {
    const cleaned = cleanKeywordList(p.arr);
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  return [];
}

/**
 * ✅ 핵심: /place/{id} hit → redirect finalUrl에서 slug 확보 → slug home으로 확정
 */
async function resolveBestHomeUrl(placeId: string): Promise<string> {
  const tries = [
    `https://m.place.naver.com/place/${placeId}`,
    `https://m.place.naver.com/place/${placeId}/home`,
    `https://m.place.naver.com/place/${placeId}?entry=pll`,
    `https://m.place.naver.com/place/${placeId}/home?entry=pll`
  ];

  for (const u of tries) {
    try {
      const r = await fetchText(u, { referer: "https://m.place.naver.com/" });
      const finalUrl = r.finalUrl || u;

      const m = finalUrl.match(/https:\/\/m\.place\.naver\.com\/([a-zA-Z0-9_]+)\/(\d{5,12})(\/[a-zA-Z0-9_]+)?/);
      if (m?.[1] && m?.[2]) {
        const slug = m[1];
        const pid = m[2];
        return `https://m.place.naver.com/${slug}/${pid}/home`;
      }

      if (/\/place\/\d{5,12}/.test(finalUrl)) {
        return `https://m.place.naver.com/place/${placeId}/home`;
      }
    } catch {}
  }

  return `https://m.place.naver.com/place/${placeId}/home`;
}

/**
 * ✅ (NEW) map API 버리고 “네이버 검색(플레이스)” HTML에서 placeId 수집
 * - Railway에서도 매우 잘 버팀
 */
async function findPlaceIdsViaNaverSearchHTML(query: string): Promise<string[]> {
  const q = (query || "").trim();
  if (!q) return [];

  // PC/모바일 둘 다 시도 (둘 중 하나는 살아남는 편)
  const urls = [
    `https://search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`,
    `https://m.search.naver.com/search.naver?where=place&query=${encodeURIComponent(q)}`
  ];

  for (const url of urls) {
    const r = await fetchText(url, { referer: "https://search.naver.com/" });
    console.log("[COMP][searchHTML] status:", r.status, "len:", (r.text || "").length, "url:", url);

    if (!r.ok || !r.text) continue;

    const html = r.text;

    // placeId 패턴: m.place.naver.com/.../{id} 또는 /place/{id}
    const ids: string[] = [];
    const reList = [
      /m\.place\.naver\.com\/[a-zA-Z0-9_]+\/(\d{5,12})/g,
      /m\.place\.naver\.com\/place\/(\d{5,12})/g,
      /\/place\/(\d{5,12})/g
    ];

    for (const re of reList) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(html))) {
        if (m?.[1]) ids.push(m[1]);
        if (ids.length >= 120) break;
      }
      if (ids.length >= 120) break;
    }

    const out = uniq(ids).filter((x) => /^\d{5,12}$/.test(x));
    if (out.length) {
      console.log("[COMP][searchHTML] id candidates:", out.length, out.slice(0, 20));
      return out;
    }
  }

  return [];
}

/** --- service --- */
export class CompetitorService {
  constructor() {}

  async close() {
    return;
  }

  /**
   * ✅ 경쟁사 후보 placeId 추출 (map API 완전 대체)
   * 1) search.naver.com place 검색 HTML에서 id 추출
   * 2) (옵션) map API는 아예 사용 안 함 (400/503 때문에)
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    console.log("[COMP][findTopPlaceIds] query:", q);

    // 1) 네이버 검색 HTML에서 ID 확보
    const ids1 = await withTimeout(findPlaceIdsViaNaverSearchHTML(q), 2500, "searchHTML-timeout");
    let ids = ids1.filter((id) => id !== excludePlaceId);
    ids = uniq(ids).filter((id) => /^\d{5,12}$/.test(id));

    // 후보는 넉넉히
    if (ids.length) return ids.slice(0, Math.max(limit * 8, 40));

    console.log("[COMP][findTopPlaceIds] no candidates for query:", q);
    return [];
  }

  /**
   * ✅ 경쟁사: 키워드만 빠르게 추출 + 중복/내업체 제거
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    _industry: Industry,
    limit = 5,
    opts?: CrawlOpts
  ): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean).filter((x) => /^\d{5,12}$/.test(x));
    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "");
    const myNameN = normName(String(opts?.myName || ""));

    const out: Competitor[] = [];
    const seenId = new Set<string>();
    const seenName = new Set<string>();

    const CONCURRENCY = Number(process.env.COMPETITOR_CONCURRENCY || 3);
    const PER_TASK_TIMEOUT = Number(process.env.COMPETITOR_TASK_TIMEOUT_MS || 2600);

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

          const nName = normName(comp.name || "");
          if (myNameN && nName && nName === myNameN) continue;

          // 같은 업체(이름) 중복 제거
          if (nName && seenName.has(nName)) continue;

          seenId.add(id);
          if (nName) seenName.add(nName);

          out.push(comp);
        } catch {
          // timeout/403 등은 스킵
        }
      }
    };

    await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
    return out.slice(0, limit);
  }

  private async fetchCompetitorKeywordsOnly(placeId: string, myNameN: string): Promise<Competitor | null> {
    const url = await resolveBestHomeUrl(placeId);
    console.log("[COMP][resolve] id:", placeId, "->", url);

    const r = await fetchText(url, { referer: "https://m.place.naver.com/" });
    if (!r.ok || !r.text) return null;

    const html = r.text;
    const len = html.length;

    // shell 페이지(짧은 24만대) 방어: 키워드가 없으면 버림
    if (len < 320_000) {
      const kwTry = extractKeywordsFromHtml(html);
      if (!kwTry.length) {
        console.log("[COMP][shell] got shell page:", placeId, "final:", r.finalUrl, "len:", len);
        return null;
      }
    }

    const name = extractNameFromHtml(html) || "";
    if (!name || name.includes("네이버 플레이스")) return null;

    const nName = normName(name);
    if (myNameN && nName && nName === myNameN) return null;

    const keywords = extractKeywordsFromHtml(html);
    console.log("[COMP][kw] probed:", placeId, "name:", name, "kw:", keywords.length, keywords.slice(0, 10));

    if (!keywords.length) return null;

    return { placeId, name, url: r.finalUrl || url, keywords };
  }
}
