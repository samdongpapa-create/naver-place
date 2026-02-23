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
  myName?: string; // 내 업체명 기반 제거용
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

async function fetchText(url: string, extraHeaders?: Record<string, string>) {
  const res = await fetch(url, {
    method: "GET",
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

/**
 * ✅ OpenAPI(=map search JSON 등)에서 placeId 후보를 뽑아오는 기존 로직을 유지하려면
 * 여기 findTopPlaceIds 내부에서 사용하던 네 API 호출 코드를 그대로 쓰면 됨.
 *
 * 지금은 너 로그에 [COMP][OpenAPI]가 이미 정상 동작하는 상태라
 * findTopPlaceIds는 "이미 구현되어 있는 그대로" 유지한다고 가정하고,
 * 아래는 인터페이스만 맞춰둠.
 *
 * ⚠️ 너 프로젝트의 기존 findTopPlaceIds 구현 코드를 이 파일의 findTopPlaceIds에 그대로 붙여도 됨.
 */
export class CompetitorService {
  constructor() {}

  async close() {
    // 지금은 playwright를 안 쓰는 방식이라 close 할 게 없음.
    // (서버.ts finally에서 close() 호출하니 메서드는 유지)
    return;
  }

  /**
   * ✅ 너가 이미 쓰고 있는 OpenAPI 기반 후보 추출 함수
   * - 여기 코드는 "기존 그대로" 쓰면 됨
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    // ⚠️ 기존 구현을 그대로 가져와 쓰는 걸 권장.
    // 여기엔 안전한 기본값만 둔다.
    // (이미 네 로그에선 이 함수가 id candidates 뽑는 중이라, 실제론 너 코드가 실행되고 있을 가능성이 큼)
    const q = (query || "").trim();
    if (!q) return [];

    // TODO: 네 기존 OpenAPI 구현 그대로 유지
    return [];
  }

  /**
   * ✅ 경쟁사: "키워드만" 빠르게 추출
   * - 핵심: /place/{id}/home 는 shell만 뜰 수 있으니 slug URL을 먼저 probe
   * - slug 페이지에서 HTML 길이가 충분히 크거나(__NEXT_DATA__) 키워드 패턴이 있으면 그걸 채택
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5, opts?: CrawlOpts): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter(Boolean).filter((x) => /^\d{5,12}$/.test(x));
    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "");
    const myNameN = normName(String(opts?.myName || ""));

    const out: Competitor[] = [];
    const seenPlaceId = new Set<string>();
    const seenName = new Set<string>();

    // ✅ 업종 우선 slug + fallback slug들
    const primarySlug =
      industry === "hairshop" ? "hairshop" : industry === "cafe" ? "cafe" : industry === "restaurant" ? "restaurant" : "place";

    const slugPool = uniq([
      primarySlug,
      "hairshop",
      "restaurant",
      "cafe",
      "accommodation",
      "hospital",
      "shopping",
      "academy",
      "beauty",
      "place" // 마지막 fallback
    ]).filter(Boolean);

    for (const id of candidates) {
      if (out.length >= limit) break;
      if (id === excludeId) continue;
      if (seenPlaceId.has(id)) continue;

      // ✅ 1) slug 페이지 probe로 "리치 HTML" 찾기
      const probed = await this.probeBestSlugPage(id, slugPool);

      if (!probed) continue;

      const { url, html } = probed;

      // ✅ 2) 이름/키워드 추출 (HTML regex fallback)
      const name = extractNameFromHtml(html) || "";
      const keywords = extractKeywordsFromHtml(html);

      // shell 페이지면 name이 "네이버 플레이스"로 떨어지는 경우가 많음 -> 컷
      if (!name || name.includes("네이버 플레이스")) continue;

      // 내 업체명 제거(같은 업체가 다른 id로 중복 잡히는 케이스 방지)
      const nName = normName(name);
      if (myNameN && nName && nName === myNameN) continue;

      // 키워드가 하나도 없으면 경쟁사로 의미가 없음 -> 스킵
      if (!keywords.length) continue;

      // placeId 중복 제거
      seenPlaceId.add(id);

      // 같은 업체(이름) 중복 제거
      if (nName && seenName.has(nName)) continue;
      if (nName) seenName.add(nName);

      out.push({
        placeId: id,
        url,
        name,
        keywords
      });
    }

    return out.slice(0, limit);
  }

  /**
   * ✅ 여러 slug URL을 빠르게 fetch해서
   * - "리치 HTML" (길이 충분히 큼 or __NEXT_DATA__ 존재 or 키워드 배열 패턴 존재) 인 URL을 고른다
   */
  private async probeBestSlugPage(
    placeId: string,
    slugs: string[]
  ): Promise<{ url: string; html: string } | null> {
    // 너무 오래 끌면 전체가 timeout 나니까 probe는 짧게 여러 번
    // (Railway에서 네트워크 가끔 느려도, slug 3~6개만 보면 대부분 잡힘)
    const trySlugs = slugs.slice(0, 6);

    let best: { url: string; html: string; score: number } | null = null;

    for (const slug of trySlugs) {
      const url =
        slug === "place"
          ? `https://m.place.naver.com/place/${placeId}/home`
          : `https://m.place.naver.com/${slug}/${placeId}/home`;

      const r = await fetchText(url, {
        referer: "https://m.place.naver.com/",
        "x-requested-with": "XMLHttpRequest"
      });

      if (!r.ok || !r.text) continue;

      const html = r.text;
      const len = html.length;

      // ✅ shell은 보통 24만대, 리치 페이지는 60만~120만대가 자주 나옴
      const hasNext = html.includes("__NEXT_DATA__");
      const kw = extractKeywordsFromHtml(html);
      const name = extractNameFromHtml(html);

      // score: 길이 + next + 키워드 + 이름(네이버플레이스가 아닌)
      let score = 0;
      if (len >= 450_000) score += 3;
      if (len >= 700_000) score += 2;
      if (hasNext) score += 2;
      if (kw.length >= 3) score += 2;
      if (name && !name.includes("네이버 플레이스")) score += 2;

      if (!best || score > best.score) {
        best = { url: r.finalUrl || url, html, score };
      }

      // 충분히 리치면 바로 확정
      if (score >= 6) break;
    }

    if (!best) return null;

    // best가 shell일 가능성 방지: 키워드 0이면 null
    const finalKw = extractKeywordsFromHtml(best.html);
    if (!finalKw.length) return null;

    return { url: best.url, html: best.html };
  }
}

/**
 * ✅ 경쟁사 HTML에서 name 추출 (가벼운 regex)
 * - 완벽할 필요 없음. "네이버 플레이스" 같은 shell만 걸러내면 OK
 */
function extractNameFromHtml(html: string): string {
  const s = String(html || "");
  if (!s) return "";

  // 1) og:title
  const m1 = s.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i);
  if (m1?.[1]) return decodeHtml(m1[1]).trim();

  // 2) title tag
  const m2 = s.match(/<title>\s*([^<]+)\s*<\/title>/i);
  if (m2?.[1]) {
    const t = decodeHtml(m2[1]).replace(/:\s*네이버.*$/i, "").trim();
    return t;
  }

  // 3) JSON 안의 name 필드(너무 많으니 짧게)
  const m3 = s.match(/"name"\s*:\s*"([^"]{2,60})"/);
  if (m3?.[1]) return decodeHtml(m3[1]).trim();

  return "";
}

/**
 * ✅ 경쟁사 HTML에서 대표키워드(키워드 리스트) 추출
 * - 무료버전이 "page HTML regex fallback"로 찾던 것과 동일 계열
 * - 여러 패턴을 순차 시도 + 최후엔 "문자열 배열" 탐색으로 best-array 선택
 */
function extractKeywordsFromHtml(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  // 1) 가장 흔한 형태들
  const patterns = [
    /"keywords"\s*:\s*(\[[^\]]+\])/,
    /"keywordList"\s*:\s*(\[[^\]]+\])/,
    /"keyword"\s*:\s*(\[[^\]]+\])/
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) {
      const arr = safeParseStringArray(m[1]);
      const cleaned = cleanKeywordList(arr);
      if (cleaned.length) return cleaned.slice(0, 20);
    }
  }

  // 2) 최후 fallback: HTML 전체에서 "문자열 배열" 후보를 여러 개 찾고 그 중 제일 그럴싸한 걸 고름
  // - 한국어 비율 높고, 너무 긴 문장/URL/태그가 아닌 배열 선호
  const candidates = findStringArrayCandidates(s);
  for (const arr of candidates) {
    const cleaned = cleanKeywordList(arr);
    if (cleaned.length >= 3) return cleaned.slice(0, 20);
  }

  return [];
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

function findStringArrayCandidates(s: string): string[][] {
  // 문자열 배열을 대충 긁어온 뒤 JSON.parse 가능한 것만 모음
  const re = /\[(?:"[^"\n]{2,30}"\s*,\s*){2,30}"[^"\n]{2,30}"\]/g;
  const matches = s.match(re) || [];
  const parsed: string[][] = [];

  for (const raw of matches.slice(0, 40)) {
    const arr = safeParseStringArray(raw);
    if (!arr.length) continue;

    // 점수화: 한글 포함 단어 개수, URL 포함 여부, 너무 긴 문장 여부
    let score = 0;
    for (const it of arr) {
      const t = String(it || "");
      if (/[가-힣]/.test(t)) score += 1;
      if (/https?:\/\//i.test(t)) score -= 3;
      if (t.length > 20) score -= 1;
    }
    if (score >= 5) parsed.push(arr);
  }

  // 점수 높은 순서가 되도록(간단히 한글 포함 개수 기준)
  parsed.sort((a, b) => countKo(b) - countKo(a));
  return parsed;

  function countKo(arr: string[]) {
    return arr.filter((x) => /[가-힣]/.test(String(x || ""))).length;
  }
}

function decodeHtml(s: string) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}
