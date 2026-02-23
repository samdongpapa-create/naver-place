// src/services/competitorService.ts
import type { Industry } from "../lib/scoring/types";

type Competitor = {
  placeId: string;
  name?: string;
  address?: string;
  keywords?: string[];
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

function normalizeName(name: string): string {
  let x = String(name || "").trim();
  if (!x) return "";
  x = stripHtml(x);
  x = x.replace(/\([^)]*\)/g, ""); // (서대문역점) 같은 괄호 제거
  x = x.replace(/(서대문역점|교대역점|역점|본점|지점|점)$/g, "");
  x = x.replace(/[^\w가-힣]/g, ""); // 특수문자 제거
  x = x.replace(/\s+/g, "");
  return x.toLowerCase();
}

function addressPrefix(addr: string): string {
  const a = String(addr || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  // "서울 서대문구" 정도까지만 비교
  return a.split(" ").slice(0, 2).join(" ");
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
          if (out.length) return uniq(out).slice(0, 30);
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
  // ✅ OpenAPI seed(이름/주소) 저장
  private seed = new Map<string, Partial<Competitor>>();

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
        if (id === excludePlaceId) continue;
        bag.push(id);

        // seed
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

    const ids = uniq(bag).slice(0, Math.max(limit * 10, 40)); // 후보 넉넉히(중복 제거 대비)
    console.log("[COMP][OpenAPI] id candidates:", ids.length, ids.slice(0, 15));
    return ids;
  }

  /**
   * ✅ 초경량 keyword 프로브 (fetch + __NEXT_DATA__)
   */
  private async probeKeywordsFast(id: string): Promise<Competitor | null> {
    const url = buildCompetitorUrl(id);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      Accept: "text/html,application/xhtml+xml"
    };

    const r = await fetchWithTimeout(url, Number(process.env.COMPETITOR_PROBE_TIMEOUT_MS || 1200), headers);

    // 실패하면 seed만
    if (!r.ok || !r.text) {
      const s = this.seed.get(id);
      if (!s?.name) return null;
      return {
        placeId: id,
        url,
        name: s.name,
        address: s.address,
        keywords: [] // seed는 키워드 없음
      };
    }

    const next = parseNextData(r.text);
    if (!next) {
      const s = this.seed.get(id);
      if (!s?.name) return null;
      return { placeId: id, url, name: s.name, address: s.address, keywords: [] };
    }

    const name =
      deepFindFirstString(next, ["name", "placeName", "businessName"]) || this.seed.get(id)?.name || "";
    const address =
      deepFindFirstString(next, ["roadAddress", "address", "fullAddress"]) || this.seed.get(id)?.address || "";

    const keywords =
      deepFindStringArray(next, ["keywords", "keywordList", "searchKeywords", "recommendedKeywords"]) || [];

    if (!name) return null;

    return {
      placeId: id,
      url,
      name,
      address,
      keywords: uniq(keywords).slice(0, 20)
    };
  }

  /**
   * ✅ 후보들을 빠르게 프로브해서 Top5 확정
   * - 중복 제거(같은 업체) + 내 업체 제거
   * - 최종적으로 "키워드가 있는 경쟁사"를 우선
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    industry: Industry,
    limit = 5,
    opts?: { excludePlaceId?: string; myName?: string; myAddress?: string }
  ): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter((x) => /^\d{5,12}$/.test(String(x)));
    if (!candidates.length) return [];

    const hardMs = Number(process.env.COMPETITOR_CRAWL_HARD_TIMEOUT_MS || 4500);
    const concurrency = Number(process.env.COMPETITOR_PROBE_CONCURRENCY || 4);
    const started = Date.now();

    const myNameNorm = normalizeName(opts?.myName || "");
    const myAddrPref = addressPrefix(opts?.myAddress || "");
    const excludePlaceId = String(opts?.excludePlaceId || "");

    // ✅ 너무 많이 돌지 말기
    const slice = candidates.slice(0, Math.max(limit * 10, 40));

    const results = await mapLimit(slice, concurrency, async (id) => {
      if (Date.now() - started > hardMs) return null;
      if (excludePlaceId && id === excludePlaceId) return null;

      try {
        return await this.probeKeywordsFast(id);
      } catch {
        return null;
      }
    });

    // 1) 내 업체 제거 + 2) 중복 제거(같은 업체)
    const seenName = new Set<string>();
    const seenAddr = new Set<string>();

    const filtered: Competitor[] = [];

    for (const c of results) {
      if (!c?.name) continue;

      const nNorm = normalizeName(c.name);
      const aPref = addressPrefix(c.address || "");

      // ✅ 내 업체 제거(이름 기준)
      if (myNameNorm && nNorm && nNorm === myNameNorm) continue;

      // ✅ 내 업체 제거(주소 prefix 기준) - 같은 생활권이면 오탐 가능해서 "myNameNorm 없는 경우"엔 적용 안 함
      if (myNameNorm && myAddrPref && aPref && aPref === myAddrPref) {
        // 이름이 비슷하거나(부분 포함) 같은 경우만 제거
        if (nNorm.includes(myNameNorm) || myNameNorm.includes(nNorm)) continue;
      }

      // ✅ 같은 업체 중복 제거(이름 정규화 기준)
      if (nNorm && seenName.has(nNorm)) continue;
      if (nNorm) seenName.add(nNorm);

      // ✅ 보조 중복 제거(주소 prefix도 똑같으면 중복으로 간주)
      if (aPref && seenAddr.has(`${nNorm}|${aPref}`)) continue;
      if (aPref) seenAddr.add(`${nNorm}|${aPref}`);

      filtered.push(c);
      if (filtered.length >= limit) break;
      if (Date.now() - started > hardMs) break;
    }

    // ✅ 키워드가 있는 애들 우선 정렬 (없으면 뒤로)
    filtered.sort((a, b) => (b.keywords?.length || 0) - (a.keywords?.length || 0));

    const out = filtered.slice(0, limit).map((x) => ({
      placeId: x.placeId,
      url: x.url,
      name: x.name,
      // 너 요청대로: 리뷰/사진 다 빼고 키워드만
      keywords: Array.isArray(x.keywords) ? x.keywords : []
    }));

    console.log("[COMP][crawl-fast] final competitors:", out.length);
    return out;
  }
}
