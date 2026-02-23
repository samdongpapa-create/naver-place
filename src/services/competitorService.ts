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

function stripHtml(s: string) {
  return String(s || "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .trim();
}

function extractPlaceIdsFromText(text: string): string[] {
  const ids = String(text || "").match(/\b\d{5,12}\b/g) || [];
  return uniq(ids);
}

async function fetchWithTimeout(url: string, ms: number, headers: Record<string, string>) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try {
    const res = await fetch(url, { method: "GET", headers, signal: ac.signal as any });
    const text = await res.text();
    return { ok: res.ok, status: res.status, text, finalUrl: res.url };
  } catch (e: any) {
    return { ok: false, status: 0, text: "", finalUrl: url, error: e?.message || String(e) };
  } finally {
    clearTimeout(t);
  }
}

/**
 * __NEXT_DATA__ 파싱 (m.place.naver.com은 Next.js 기반이라 대부분 존재)
 */
function parseNextData(html: string): any | null {
  const m = String(html || "").match(
    /<script[^>]+id="__NEXT_DATA__"[^>]*>\s*([\s\S]*?)\s*<\/script>/i
  );
  if (!m?.[1]) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

/**
 * JSON에서 특정 key를 “가장 그럴듯한 값”으로 찾기
 * - 구조가 바뀌어도 최대한 버티는 방식
 */
function deepFindFirstString(obj: any, keys: string[]): string {
  const want = new Set(keys);
  const seen = new Set<any>();
  const stack: any[] = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (!Array.isArray(cur)) {
      for (const k of Object.keys(cur)) {
        const v = (cur as any)[k];
        if (want.has(k) && typeof v === "string" && v.trim()) return v.trim();
      }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return "";
}

function deepFindFirstNumber(obj: any, keys: string[]): number {
  const want = new Set(keys);
  const seen = new Set<any>();
  const stack: any[] = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (!Array.isArray(cur)) {
      for (const k of Object.keys(cur)) {
        const v = (cur as any)[k];
        if (want.has(k)) {
          const n = Number(v);
          if (Number.isFinite(n) && n > 0) return n;
        }
      }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return 0;
}

function deepFindStringArray(obj: any, keys: string[]): string[] {
  const want = new Set(keys);
  const seen = new Set<any>();
  const stack: any[] = [obj];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (!Array.isArray(cur)) {
      for (const k of Object.keys(cur)) {
        const v = (cur as any)[k];
        if (want.has(k) && Array.isArray(v)) {
          const out = v.map((x: any) => String(x || "").trim()).filter(Boolean);
          if (out.length) return uniq(out).slice(0, 20);
        }
      }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }
  return [];
}

async function naverLocalSearchRaw(query: string, display = 25) {
  const clientId = process.env.NAVER_CLIENT_ID || "";
  const clientSecret = process.env.NAVER_CLIENT_SECRET || "";
  if (!clientId || !clientSecret) return { ok: false, status: 0, json: null as any };

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

  const res = await fetch(url, { headers });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { ok: res.ok, status: res.status, json };
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T, idx: number) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let i = 0;

  const workers = Array.from({ length: Math.max(1, limit) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });

  await Promise.all(workers);
  return out;
}

export class CompetitorService {
  private crawler: ModularCrawler;
  // ✅ OpenAPI에서 얻은 기본 정보(이름/주소)를 id별로 저장
  private seed = new Map<string, Partial<Competitor>>();

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
   * ✅ OpenAPI로 후보 placeId 뽑기 + seed 저장
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    if (!process.env.NAVER_CLIENT_ID || !process.env.NAVER_CLIENT_SECRET) {
      console.log("[COMP][OpenAPI] missing NAVER_CLIENT_ID/SECRET -> return []");
      return [];
    }

    console.log("[COMP][OpenAPI] query:", q);

    const r = await naverLocalSearchRaw(q, 25);
    if (!r.ok || !r.json) {
      console.log("[COMP][OpenAPI] non-ok:", r.status);
      return [];
    }

    const items = Array.isArray(r.json?.items) ? r.json.items : [];
    const bag: string[] = [];

    for (const it of items) {
      const blob = JSON.stringify(it || {});
      const ids = extractPlaceIdsFromText(blob).filter((id) => /^\d{5,12}$/.test(id));
      for (const id of ids) {
        bag.push(id);

        // ✅ seed에 기본 정보 저장(크롤링 실패해도 0 방지용)
        const title = stripHtml(String(it?.title || ""));
        const address = String(it?.roadAddress || it?.address || "").trim();
        this.seed.set(id, {
          placeId: id,
          name: title || undefined,
          address: address || undefined,
          url: buildCompetitorUrl(id)
        });
      }
    }

    const ids = uniq(bag)
      .filter((id) => id !== excludePlaceId)
      .slice(0, Math.max(limit * 6, 25)); // 검증용 여유

    console.log("[COMP][OpenAPI] id candidates:", ids.length, ids.slice(0, 15));
    return ids;
  }

  /**
   * ✅ 초경량 경쟁사 “프로브”
   * - Playwright(무거움) 대신 fetch(가벼움)로 m.place HTML만 받아서 __NEXT_DATA__ 파싱
   * - 실패하면 seed 정보만이라도 반환(0 방지)
   */
  private async probeCompetitorFast(id: string): Promise<Competitor | null> {
    const url = buildCompetitorUrl(id);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      Accept: "text/html,application/xhtml+xml"
    };

    // ✅ 빠르게(1.2초) 프로브
    const r = await fetchWithTimeout(url, Number(process.env.COMPETITOR_PROBE_TIMEOUT_MS || 1200), headers);
    if (!r.ok || !r.text) {
      // seed라도 주자
      const s = this.seed.get(id);
      return s?.name ? ({ placeId: id, url, ...s } as Competitor) : null;
    }

    const next = parseNextData(r.text);
    if (!next) {
      const s = this.seed.get(id);
      return s?.name ? ({ placeId: id, url, ...s } as Competitor) : null;
    }

    // ✅ 구조가 바뀌어도 버티는 key 탐색
    const name =
      deepFindFirstString(next, ["name", "placeName", "businessName"]) ||
      this.seed.get(id)?.name ||
      "";
    const address =
      deepFindFirstString(next, ["roadAddress", "address", "fullAddress"]) ||
      this.seed.get(id)?.address ||
      "";

    const reviewCount =
      deepFindFirstNumber(next, ["visitorReviewCount", "visitorReviews", "reviewCount", "reviewCnt"]) || 0;
    const photoCount =
      deepFindFirstNumber(next, ["photoCount", "photoCnt", "imagesCount", "imageCount"]) || 0;

    const keywords = deepFindStringArray(next, ["keywords", "keywordList", "searchKeywords"]) || [];

    if (!name) {
      const s = this.seed.get(id);
      return s?.name ? ({ placeId: id, url, ...s } as Competitor) : null;
    }

    return {
      placeId: id,
      url,
      name,
      address,
      reviewCount,
      photoCount,
      keywords
    };
  }

  /**
   * ✅ 후보들을 빠르게 검증해서 Top5 확정
   * - 동시 4개 병렬
   * - 전체 하드 타임(기본 4.5초) 안에 최대한 뽑기
   * - 그래도 부족하면 seed로 채워서 “0” 방지
   */
  async crawlCompetitorsByIds(placeIds: string[], industry: Industry, limit = 5): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter((x) => /^\d{5,12}$/.test(String(x)));
    if (!candidates.length) return [];

    const hardMs = Number(process.env.COMPETITOR_CRAWL_HARD_TIMEOUT_MS || 4500);
    const concurrency = Number(process.env.COMPETITOR_PROBE_CONCURRENCY || 4);

    const started = Date.now();
    const out: Competitor[] = [];
    const tried = new Set<string>();

    // ✅ 앞쪽 후보만 (너무 많이 돌면 시간 초과)
    const slice = candidates.slice(0, Math.max(limit * 6, 18));

    const results = await mapLimit(slice, concurrency, async (id) => {
      if (Date.now() - started > hardMs) return null;
      if (tried.has(id)) return null;
      tried.add(id);

      try {
        return await this.probeCompetitorFast(id);
      } catch {
        return null;
      }
    });

    for (const c of results) {
      if (c && c.name) out.push(c);
      if (out.length >= limit) break;
      if (Date.now() - started > hardMs) break;
    }

    // ✅ 그래도 부족하면 seed로 채워서 “0 방지”
    if (out.length < limit) {
      for (const id of slice) {
        if (out.length >= limit) break;
        if (out.some((x) => x.placeId === id)) continue;
        const s = this.seed.get(id);
        if (s?.name) out.push({ placeId: id, url: buildCompetitorUrl(id), ...s } as Competitor);
      }
    }

    console.log("[COMP][crawl-fast] final competitors:", out.length);
    return out.slice(0, limit);
  }
}
