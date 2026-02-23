// src/services/competitorService.ts
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

function buildCompetitorUrl(placeId: string) {
  return `https://m.place.naver.com/place/${placeId}/home`;
}

type FetchJsonResult = {
  ok: boolean;
  status: number;
  json: any;
  text: string;
  finalUrl: string;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * ✅ Railway/서버 환경에서 안정성 위해:
 * - timeout + AbortController
 * - retry (짧게)
 * - headers 보강
 */
async function fetchJson(
  url: string,
  extraHeaders?: Record<string, string>,
  opts?: { timeoutMs?: number; retries?: number; retryDelayMs?: number }
): Promise<FetchJsonResult> {
  const timeoutMs = opts?.timeoutMs ?? 3500;
  const retries = opts?.retries ?? 1;
  const retryDelayMs = opts?.retryDelayMs ?? 200;

  let lastErr: any = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method: "GET",
        signal: controller.signal,
        headers: {
          // ✅ 너무 “봇”처럼 보이지 않게 일반 UA
          "user-agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
          "accept-language": "ko-KR,ko;q=0.9,en;q=0.7",
          accept: "application/json,text/plain,*/*",
          // 압축 허용(서버가 알아서 내려줌)
          "accept-encoding": "gzip, deflate, br",
          connection: "keep-alive",
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

      clearTimeout(t);

      return { ok: res.ok, status: res.status, json, text, finalUrl: res.url };
    } catch (e: any) {
      clearTimeout(t);
      lastErr = e;

      // 마지막 시도면 던지지 말고 실패 형태로 반환 (상위 로직이 다음 endpoint로 넘어가게)
      if (attempt >= retries) {
        return {
          ok: false,
          status: 0,
          json: null,
          text: e?.message ? String(e.message) : String(e),
          finalUrl: url
        };
      }
      await sleep(retryDelayMs);
    }
  }

  return {
    ok: false,
    status: 0,
    json: null,
    text: lastErr?.message ? String(lastErr.message) : String(lastErr),
    finalUrl: url
  };
}

/**
 * ✅ map.naver.com search JSON이 자주 바뀌니까
 * - "JSON 전체 stringify + regex"는 너무 무겁고 쓰레기 숫자도 너무 많이 섞임
 * - 대신: 재귀로 JSON을 얕게/제한적으로 훑으면서
 *   - key가 placeId/id/… 같은 애들을 우선 수집
 *   - value가 5~12자리 숫자면 후보로 넣음
 */
function collectPlaceIdCandidates(json: any): string[] {
  if (!json) return [];

  const out: string[] = [];
  const seen = new Set<any>();

  // 탐색 제한(너무 깊거나 큰 응답에서 서버 터지는거 방지)
  const MAX_NODES = 6000;
  let nodes = 0;

  const KEY_HINT = /(^|_)(placeId|place_id|id|sid|spid|placeid)($|_)/i;

  function pushId(v: any) {
    if (v == null) return;
    const s = typeof v === "number" ? String(v) : typeof v === "string" ? v : "";
    if (!s) return;
    if (/^\d{5,12}$/.test(s)) out.push(s);
  }

  function walk(v: any) {
    if (nodes++ > MAX_NODES) return;
    if (v == null) return;

    // 순환 참조 방지
    if (typeof v === "object") {
      if (seen.has(v)) return;
      seen.add(v);
    }

    if (Array.isArray(v)) {
      for (const it of v) walk(it);
      return;
    }

    if (typeof v === "object") {
      for (const [k, val] of Object.entries(v)) {
        // 키 힌트가 있으면 우선 수집
        if (KEY_HINT.test(k)) pushId(val);

        // 값 자체가 객체/배열이면 계속 탐색
        walk(val);

        // 문자열 중간에 “...placeId:123456...” 같은게 들어있는 경우도 있음(가끔)
        if (typeof val === "string" && val.length <= 200) {
          const m = val.match(/\b\d{5,12}\b/g);
          if (m?.length) {
            for (const id of m.slice(0, 5)) out.push(id);
          }
        }
      }
      return;
    }

    // primitive는 키 없이도 숫자 형태면 넣어줌(보수적)
    if (typeof v === "string" || typeof v === "number") pushId(v);
  }

  walk(json);

  // 너무 많이 나오면 상위만 (뒤쪽은 보통 노이즈가 많음)
  return uniq(out).slice(0, 200);
}

/**
 * ✅ 간단한 TTL 캐시 (Railway에서 같은 요청 반복 시 체감속도 ↑)
 */
class TtlCache<V> {
  private map = new Map<string, { value: V; exp: number }>();
  constructor(private ttlMs: number, private max = 200) {}

  get(key: string): V | null {
    const it = this.map.get(key);
    if (!it) return null;
    if (Date.now() > it.exp) {
      this.map.delete(key);
      return null;
    }
    return it.value;
  }

  set(key: string, value: V) {
    // 간단 LRU-ish: max 넘으면 오래된 것부터 정리
    if (this.map.size >= this.max) {
      const now = Date.now();
      for (const [k, v] of this.map) {
        if (now > v.exp) this.map.delete(k);
        if (this.map.size < this.max) break;
      }
      // 그래도 넘으면 첫 번째 제거
      if (this.map.size >= this.max) {
        const firstKey = this.map.keys().next().value;
        if (firstKey) this.map.delete(firstKey);
      }
    }
    this.map.set(key, { value, exp: Date.now() + this.ttlMs });
  }
}

/**
 * ✅ 제한된 병렬 처리 (p-limit 없이 자체 구현)
 */
async function asyncPool<T, R>(
  concurrency: number,
  items: T[],
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length) as any;
  let nextIndex = 0;

  async function runner() {
    while (true) {
      const idx = nextIndex++;
      if (idx >= items.length) return;
      results[idx] = await worker(items[idx], idx);
    }
  }

  const runners = Array.from({ length: Math.max(1, concurrency) }, () => runner());
  await Promise.allSettled(runners);
  return results;
}

export class CompetitorService {
  private crawler: ModularCrawler;

  // ✅ query->ids 캐시 (10분)
  private idsCache = new TtlCache<string[]>(10 * 60 * 1000, 300);

  // ✅ placeId->competitor 캐시 (30분)
  private compCache = new TtlCache<Competitor>(30 * 60 * 1000, 800);

  // ✅ 실패한 placeId(negative cache) (30분)
  private badIdCache = new TtlCache<boolean>(30 * 60 * 1000, 1500);

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
   * - map.naver.com/p/api/search/* 만으로 최대한 가볍게 후보를 확보
   * - timeout + retry + 캐시로 Railway 환경에서 안정화
   */
  async findTopPlaceIds(query: string, excludePlaceId: string, limit = 5): Promise<string[]> {
    const q = (query || "").trim();
    if (!q) return [];

    const cacheKey = `q:${q}|ex:${excludePlaceId}|l:${limit}`;
    const cached = this.idsCache.get(cacheKey);
    if (cached?.length) return cached;

    const encoded = encodeURIComponent(q);

    // ✅ 엔드포인트 여러 개 시도 (구조가 바뀌어도 하나는 살아남게)
    const candidatesUrls = [
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=place&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=all&displayCount=50`,
      `https://map.naver.com/p/api/search/allSearch?query=${encoded}&type=local&displayCount=50`
    ];

    for (let i = 0; i < candidatesUrls.length; i++) {
      const url = candidatesUrls[i];
      console.log(`[COMP][findTopPlaceIds] try #${i + 1} (json):`, url);

      const r = await fetchJson(
        url,
        {
          referer: "https://map.naver.com/",
          "x-requested-with": "XMLHttpRequest"
        },
        {
          // ✅ 여기서 오래 끌면 전체 유료 진단이 느려짐
          timeoutMs: 2800,
          retries: 1,
          retryDelayMs: 150
        }
      );

      console.log(`[COMP][#${i + 1}] status:`, r.status, "final:", r.finalUrl);

      if (!r.ok || !r.json) {
        console.log(`[COMP][#${i + 1}] non-ok or json parse fail`);
        continue;
      }

      let ids = collectPlaceIdCandidates(r.json);

      // 내 placeId 제외 + bad id 제외
      ids = ids
        .filter((id) => id !== excludePlaceId)
        .filter((id) => !this.badIdCache.get(`bad:${id}`));

      // 후보가 너무 많으면 일부만(크롤링 시도 비용 절감)
      ids = ids.slice(0, 120);

      console.log(`[COMP][#${i + 1}] extracted candidates:`, ids.length, ids.slice(0, 20));

      if (ids.length) {
        // ✅ 여기서는 후보만, 실제 유효성은 crawlCompetitorsByIds에서 확정
        const picked = ids.slice(0, Math.max(limit * 6, 30));
        this.idsCache.set(cacheKey, picked);
        return picked;
      }
    }

    console.log("[COMP][findTopPlaceIds] no candidates found for query:", q);
    this.idsCache.set(cacheKey, []);
    return [];
  }

  /**
   * ✅ 후보 placeId들을 실제로 크롤링해서 "성공한 애들만" 경쟁사로 확정
   * - 순차 크롤링은 느려서: 제한 병렬(기본 3)
   * - 이미 성공한 placeId는 캐시에서 바로 가져옴
   * - 실패한 placeId는 negative cache로 재시도 방지
   */
  async crawlCompetitorsByIds(placeIds: string[], _industry: Industry, limit = 5): Promise<Competitor[]> {
    const candidates = (placeIds || [])
      .filter(Boolean)
      .filter((id) => /^\d{5,12}$/.test(id));

    if (!candidates.length) return [];

    // ✅ 1) 캐시에서 먼저 꺼내기
    const out: Competitor[] = [];
    const remaining: string[] = [];

    for (const id of candidates) {
      if (out.length >= limit) break;

      if (this.badIdCache.get(`bad:${id}`)) continue;

      const cached = this.compCache.get(`comp:${id}`);
      if (cached?.name) {
        out.push(cached);
        continue;
      }
      remaining.push(id);
    }

    if (out.length >= limit) {
      console.log("[COMP][crawl] served from cache:", out.length);
      return out.slice(0, limit);
    }

    // ✅ 2) 제한 병렬 크롤링
    // 너무 높이면 Railway에서 CPU/메모리/네이버 방어에 걸릴 수 있음
    const CONCURRENCY = 3;

    // 남은 후보는 너무 길게 잡지 말고 상위 일부만
    const toTry = remaining.slice(0, Math.max(limit * 10, 40));

    console.log("[COMP][crawl] need crawl:", toTry.length, "already:", out.length);

    const results = await asyncPool(CONCURRENCY, toTry, async (id) => {
      // out이 이미 충분하면, 남은 작업은 가볍게 스킵 (완벽한 중단은 아니지만 비용 줄임)
      if (out.length >= limit) return null;

      const url = buildCompetitorUrl(id);

      try {
        console.log("[COMP][crawl] try:", id, url);

        const r = await this.crawler.crawlPlace(url);

        if (!r?.success || !r?.data?.name) {
          this.badIdCache.set(`bad:${id}`, true);
          return null;
        }

        const comp: Competitor = {
          placeId: id,
          url,
          name: r.data.name,
          address: r.data.address,
          keywords: Array.isArray(r.data.keywords) ? r.data.keywords : [],
          reviewCount: Number(r.data.reviewCount || 0),
          photoCount: Number(r.data.photoCount || 0)
        };

        this.compCache.set(`comp:${id}`, comp);

        console.log("[COMP][crawl] ok:", id, r.data.name);
        return comp;
      } catch (e: any) {
        console.log("[COMP][crawl] error:", id, e?.message || String(e));
        this.badIdCache.set(`bad:${id}`, true);
        return null;
      }
    });

    for (const r of results) {
      if (!r) continue;
      out.push(r);
      if (out.length >= limit) break;
    }

    console.log("[COMP][crawl] final competitors:", out.length);
    return out.slice(0, limit);
  }

  /**
   * (옵션) ✅ "검색→크롤"을 한 번에 묶어서 쓰고 싶으면 이 메서드를 호출
   * - 기존 코드가 findTopPlaceIds/crawlCompetitorsByIds 따로 쓰고 있어도 문제 없음
   */
  async findTopCompetitors(query: string, excludePlaceId: string, industry: Industry, limit = 5): Promise<Competitor[]> {
    const ids = await this.findTopPlaceIds(query, excludePlaceId, limit);
    if (!ids.length) return [];
    return this.crawlCompetitorsByIds(ids, industry, limit);
  }
}
