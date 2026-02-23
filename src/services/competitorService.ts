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

/**
 * ✅ 무료(ModularCrawler)에서 잡히는 "키워드 배열 패턴"을 경쟁사에서도 그대로 적용
 * - page HTML에서 ["키워드1","키워드2",...] 형태를 찾아 파싱
 * - 키워드가 들어있는 key 이름이 바뀌어도 잡히게 후보 패턴 여러개
 */
function extractKeywordsFromHtmlLikeFree(html: string): string[] {
  const s = String(html || "");
  if (!s) return [];

  // 1) 가장 흔한 문자열 배열(키워드 리스트) 패턴 후보들
  // - 실제 무료 로그에서 "키워드 배열 패턴 발견(문자열배열)"이 찍혔던 계열을 폭넓게 커버
  const patterns: RegExp[] = [
    /"keywordList"\s*:\s*(\[[^\]]{2,2000}\])/,
    /"keywords"\s*:\s*(\[[^\]]{2,2000}\])/,
    /"keyword"\s*:\s*(\[[^\]]{2,2000}\])/,
    /"placeKeywords"\s*:\s*(\[[^\]]{2,2000}\])/
  ];

  for (const re of patterns) {
    const m = s.match(re);
    if (!m?.[1]) continue;

    const arrText = m[1];

    // 배열 전체 JSON 파싱
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
      // 2) JSON 파싱 실패하면 "문자열만" 뽑아오기
      const words = arrText.match(/"([^"]{1,40})"/g)?.map((x) => x.replace(/"/g, "").trim()) || [];
      const kws = words.filter(Boolean).slice(0, 20);
      if (kws.length) return uniq(kws);
    }
  }

  // 3) 최후 fallback: html 안에 "아베다염색" 같은 토큰이 섞여있는 경우를 위해
  //    한글/영문/숫자 조합 토큰을 약하게 추출 (과추출 방지 위해 제한)
  const rough = s.match(/[가-힣A-Za-z0-9]{2,20}/g) || [];
  // 너무 흔한 단어 제거(과추출 방지)
  const stop = new Set([
    "네이버",
    "플레이스",
    "예약",
    "문의",
    "리뷰",
    "사진",
    "홈",
    "정보",
    "더보기",
    "지도",
    "길찾기",
    "영업시간",
    "휴무",
    "주차",
    "메뉴",
    "가격"
  ]);
  const kws = rough
    .map((x) => x.trim())
    .filter((x) => x.length >= 3 && x.length <= 18)
    .filter((x) => !stop.has(x))
    .slice(0, 12);

  return uniq(kws);
}

/**
 * ✅ placeId 중복/내업체/동일매장 제거용
 * - 같은 업체가 서로 다른 placeId로 잡히는 케이스가 있음(너 로그 그대로)
 * - name이 같으면 하나만 남김
 */
function dedupeCompetitors(list: Competitor[], limit: number) {
  const byName = new Map<string, Competitor>();
  const byId = new Set<string>();

  for (const c of list) {
    if (!c?.placeId) continue;
    if (byId.has(c.placeId)) continue;
    byId.add(c.placeId);

    const nm = normSpace(c.name || "");
    if (nm) {
      if (byName.has(nm)) continue;
      byName.set(nm, c);
    } else {
      // name 없으면 그냥 넣되 중복 id만 방지
      byName.set(c.placeId, c);
    }

    if (byName.size >= limit) break;
  }

  return Array.from(byName.values()).slice(0, limit);
}

export class CompetitorService {
  private crawler: ModularCrawler;

  constructor() {
    this.crawler = new ModularCrawler();
  }

  // ✅ server.ts에서 close() 호출하니까 명시적으로 제공
  async close() {
    try {
      const anyCrawler = this.crawler as any;
      if (typeof anyCrawler.close === "function") await anyCrawler.close();
    } catch {}
  }

  /**
   * ✅ 여기(findTopPlaceIds)는 네가 이미 “OpenAPI 후보 추출”로 돌려서 잘 되고 있음
   * - 이 파일에선 그대로 두고,
   * - 핵심은 아래 crawlCompetitorsByIds에서 "키워드 추출"을 무료 방식으로 맞추는 것
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    // ⚠️ 너 프로젝트에서 이미 OpenAPI 방식이 동작 중이라면
    // 이 함수는 기존 구현 그대로 유지해도 되고,
    // 지금은 "키워드 추출" 수정이 목적이니까
    // 최소 구현(빈 배열)로 두지 말고, 기존 코드 유지하는 게 안전함.

    // ✅ 안전장치: 기존 로직이 이 파일에 이미 있다면, 거기 코드로 교체해서 사용해.
    // (여기선 실수 방지 위해 throw하지 않고 빈 값 반환)
    console.log("[COMP] findTopPlaceIds: (use your existing implementation)");
    return [];
  }

  /**
   * ✅ 경쟁사 키워드만 빠르게 뽑는다.
   * - 1차: HTML만 받아서 "무료와 동일한 키워드 배열 패턴"으로 추출 (빠름)
   * - 2차(실패 시): crawler.crawlPlace(full)로 키워드 추출 (느리지만 확실)
   *
   * 옵션:
   * - excludePlaceId: 내 placeId 제외
   * - myName: 내 상호명 제외(동일 name 제거)
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    industry: Industry,
    limit = 5,
    opts?: { excludePlaceId?: string; myName?: string; myAddress?: string }
  ): Promise<Competitor[]> {
    const candidates = uniq((placeIds || []).filter(Boolean));

    if (!candidates.length) return [];

    const excludeId = String(opts?.excludePlaceId || "").trim();
    const myName = normSpace(opts?.myName || "");

    const out: Competitor[] = [];
    const tried = new Set<string>();

    // ✅ 동시성 너무 올리면 Railway에서 느려짐/차단 위험 → 2개 정도로 제한
    const CONCURRENCY = Number(process.env.COMPETITOR_CONCURRENCY || 2);

    let idx = 0;
    const worker = async () => {
      while (idx < candidates.length && out.length < limit * 2) {
        const id = candidates[idx++];
        if (!id) continue;
        if (tried.has(id)) continue;
        tried.add(id);

        if (!/^\d{5,12}$/.test(id)) continue;
        if (excludeId && id === excludeId) continue;

        const url = buildCompetitorUrl(id);

        try {
          // 1) FAST: html fetch + keyword pattern parse
          const r = await fetchText(url, { referer: "https://m.place.naver.com/" });
          const html = r.text || "";
          const htmlLen = html.length;

          // name 추출(가벼운 regex)
          // - title/meta에서 상호명 잡히는 경우가 많음
          let name = "";
          const mt = html.match(/<title[^>]*>([^<]{2,80})<\/title>/i);
          if (mt?.[1]) name = mt[1].replace(/-.*$/g, "").trim();
          if (!name) {
            const m2 = html.match(/"name"\s*:\s*"([^"]{2,60})"/);
            if (m2?.[1]) name = m2[1].trim();
          }

          // 내 매장명 제외(동일 name 제거)
          if (myName && name && normSpace(name) === myName) {
            console.log("[COMP][skip] same as myName:", id, name);
            continue;
          }

          let keywords = extractKeywordsFromHtmlLikeFree(html);

          console.log("[COMP][kw] probed:", id, "name:", name, "kw:", keywords.length, keywords);

          // 1차 실패하면 2차로 full crawl(무료와 동일 파이프라인)
          if (!keywords.length) {
            console.log(
              "[COMP][kw] empty keywords:",
              id,
              "name:",
              name,
              "htmlLen:",
              htmlLen
            );

            try {
              const full = await this.crawler.crawlPlace(url);
              const k2 = Array.isArray(full?.data?.keywords) ? full.data.keywords : [];
              const nm2 = full?.data?.name ? String(full.data.name) : name;

              if (myName && nm2 && normSpace(nm2) === myName) {
                console.log("[COMP][skip] same as myName(full):", id, nm2);
                continue;
              }

              keywords = uniq(k2.map((x: any) => String(x || "").trim()).filter(Boolean)).slice(0, 20);

              if (keywords.length) {
                console.log("[COMP][kw] full-crawl ok:", id, nm2, "kw:", keywords.length);
              } else {
                console.log("[COMP][kw] full-crawl still empty:", id, nm2);
              }

              name = nm2 || name;
            } catch (e: any) {
              console.log("[COMP][kw] full-crawl error:", id, e?.message || String(e));
            }
          }

          // keywords가 아예 없으면 의미 없으니 제외
          if (!keywords.length) continue;

          out.push({
            placeId: id,
            url,
            name,
            keywords
          });
        } catch (e: any) {
          console.log("[COMP][crawl] error:", id, e?.message || String(e));
        }
      }
    };

    const workers = Array.from({ length: CONCURRENCY }, () => worker());
    await Promise.all(workers);

    // ✅ 최종: 동일 상호명 중복 제거 + limit
    const cleaned = dedupeCompetitors(out, limit);

    console.log("[COMP][crawl-fast] final competitors:", cleaned.length);
    return cleaned;
  }
}
