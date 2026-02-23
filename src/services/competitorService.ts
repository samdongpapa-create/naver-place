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
  x = x.replace(/\([^)]*\)/g, ""); // (서대문역점) 제거
  x = x.replace(/(서대문역점|교대역점|역점|본점|지점|점)$/g, "");
  x = x.replace(/[^\w가-힣]/g, "");
  x = x.replace(/\s+/g, "");
  return x.toLowerCase();
}

function addressPrefix(addr: string): string {
  const a = String(addr || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  // "서울 종로구" 정도로만 비교
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

/**
 * ✅ 1) __NEXT_DATA__ 기반 키워드 추출 (string[] / object[] 지원)
 */
function extractKeywordsFromNextData(next: any): string[] {
  if (!next) return [];

  const out: string[] = [];

  const push = (v: any) => {
    const s = String(v || "").trim();
    if (!s) return;
    if (s.length < 2 || s.length > 30) return;
    if (/^http/i.test(s)) return;
    out.push(s);
  };

  const arrayKeys = new Set(["keywords", "keywordList", "searchKeywords", "recommendedKeywords", "mainKeywords"]);
  const objectWordKeys = new Set(["keyword", "name", "text", "title"]);

  const seen = new Set<any>();
  const stack: any[] = [next];

  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (seen.has(cur)) continue;
    seen.add(cur);

    if (!Array.isArray(cur)) {
      for (const [k, v] of Object.entries(cur)) {
        if (arrayKeys.has(k) && Array.isArray(v)) {
          for (const it of v) {
            if (typeof it === "string") push(it);
            else if (it && typeof it === "object") {
              for (const kk of Object.keys(it)) {
                if (objectWordKeys.has(kk) && typeof (it as any)[kk] === "string") push((it as any)[kk]);
              }
            }
          }
        }
      }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v);
    } else {
      for (const v of Object.values(cur)) stack.push(v);
    }
  }

  return uniq(
    out
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  ).slice(0, 30);
}

/**
 * ✅ 2) HTML regex fallback (네 ModularCrawler처럼)
 * - "keywords":[ "a","b",... ] 형태
 * - 또는 ["a","b",...] 단독 배열 형태(페이지에 종종 존재)
 */
function extractKeywordsFromHtmlFallback(html: string): string[] {
  const text = String(html || "");
  if (!text) return [];

  const results: string[] = [];

  const push = (s: string) => {
    const x = String(s || "").trim();
    if (!x) return;
    if (x.length < 2 || x.length > 30) return;
    if (/^http/i.test(x)) return;
    results.push(x);
  };

  // (A) "keywords":[ "a","b","c" ]
  {
    const m = text.match(/"keywords"\s*:\s*\[([\s\S]*?)\]/i);
    if (m?.[1]) {
      const inner = m[1];
      const items = inner.match(/"([^"]{2,40})"/g) || [];
      for (const it of items) push(it.replace(/^"|"$/g, ""));
    }
  }

  // (B) "keywordList":[ ... ] 혹은 "searchKeywords":[ ... ]
  {
    const m = text.match(/"(keywordList|searchKeywords|recommendedKeywords|mainKeywords)"\s*:\s*\[([\s\S]*?)\]/i);
    if (m?.[2]) {
      const inner = m[2];
      const items = inner.match(/"([^"]{2,40})"/g) || [];
      for (const it of items) push(it.replace(/^"|"$/g, ""));
    }
  }

  // (C) 객체 배열에서 "keyword":"..."
  {
    const re = /"keyword"\s*:\s*"([^"]{2,40})"/g;
    let mm: RegExpExecArray | null;
    while ((mm = re.exec(text))) push(mm[1]);
  }

  // 최종 정리
  return uniq(
    results
      .map((s) => stripHtml(s))
      .map((s) => s.replace(/\s+/g, " ").trim())
      .filter(Boolean)
  ).slice(0, 30);
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
  private seed = new Map<string, Partial<Competitor>>();

  // ✅ server.ts 호환용 (현재 리소스 보유 X)
  async close() {
    return;
  }

  /**
   * ✅ OpenAPI로 후보 placeId 뽑기 + seed(name/address) 저장
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

    const ids = uniq(bag).slice(0, Math.max(limit * 10, 40));
    console.log("[COMP][OpenAPI] id candidates:", ids.length, ids.slice(0, 15));
    return ids;
  }

  /**
   * ✅ 경쟁사 1개: fetch HTML → (1) __NEXT_DATA 키워드 → (2) HTML regex fallback
   */
  private async probeKeywordsFast(id: string): Promise<Competitor | null> {
    const url = buildCompetitorUrl(id);

    const headers = {
      "User-Agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
      "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.7",
      Accept: "text/html,application/xhtml+xml"
    };

    const r = await fetchWithTimeout(url, Number(process.env.COMPETITOR_PROBE_TIMEOUT_MS || 1800), headers);

    // 실패하면 seed만
    if (!r.ok || !r.text) {
      const s = this.seed.get(id);
      if (!s?.name) return null;
      console.log("[COMP][kw] probe fail html:", id, "status:", r.status);
      return { placeId: id, url, name: s.name, address: s.address, keywords: [] };
    }

    // name/address
    const next = parseNextData(r.text);
    const nameFromNext = next ? deepFindFirstString(next, ["name", "placeName", "businessName"]) : "";
    const addrFromNext = next ? deepFindFirstString(next, ["roadAddress", "address", "fullAddress"]) : "";

    const seed = this.seed.get(id);
    const name = (nameFromNext || seed?.name || "").trim();
    const address = (addrFromNext || seed?.address || "").trim();

    if (!name) return null;

    // keywords: 1) nextData 2) html fallback
    let keywords: string[] = [];
    if (next) keywords = extractKeywordsFromNextData(next);

    if (!keywords.length) {
      const fromHtml = extractKeywordsFromHtmlFallback(r.text);
      if (fromHtml.length) keywords = fromHtml;
    }

    // 디버그 로그
    console.log("[COMP][kw] probed:", id, "name:", name, "kw:", keywords.length, keywords.slice(0, 8));
    if (!keywords.length) {
      console.log("[COMP][kw] empty keywords:", id, "name:", name, "htmlLen:", r.text.length, "hasNext:", Boolean(next));
    }

    return {
      placeId: id,
      url,
      name,
      address,
      keywords: uniq(keywords).slice(0, 20)
    };
  }

  /**
   * ✅ 후보들 → 빠르게 키워드 프로브 → 중복/내업체 제거 → TopN
   */
  async crawlCompetitorsByIds(
    placeIds: string[],
    industry: Industry,
    limit = 5,
    opts?: { excludePlaceId?: string; myName?: string; myAddress?: string }
  ): Promise<Competitor[]> {
    const candidates = (placeIds || []).filter((x) => /^\d{5,12}$/.test(String(x)));
    if (!candidates.length) return [];

    const hardMs = Number(process.env.COMPETITOR_CRAWL_HARD_TIMEOUT_MS || 5000);
    const concurrency = Number(process.env.COMPETITOR_PROBE_CONCURRENCY || 4);
    const started = Date.now();

    const myNameNorm = normalizeName(opts?.myName || "");
    const myAddrPref = addressPrefix(opts?.myAddress || "");
    const excludePlaceId = String(opts?.excludePlaceId || "");

    const slice = candidates.slice(0, Math.max(limit * 12, 60));

    const results = await mapLimit(slice, concurrency, async (id) => {
      if (Date.now() - started > hardMs) return null;
      if (excludePlaceId && id === excludePlaceId) return null;
      try {
        return await this.probeKeywordsFast(id);
      } catch {
        return null;
      }
    });

    const seenName = new Set<string>();
    const seenNameAddr = new Set<string>();
    const filtered: Competitor[] = [];

    for (const c of results) {
      if (!c?.name) continue;

      const nNorm = normalizeName(c.name);
      const aPref = addressPrefix(c.address || "");

      // ✅ 내 업체 제거(이름)
      if (myNameNorm && nNorm && nNorm === myNameNorm) continue;

      // ✅ 내 업체 제거(주소 prefix + 이름 유사)
      if (myNameNorm && myAddrPref && aPref && aPref === myAddrPref) {
        if (nNorm.includes(myNameNorm) || myNameNorm.includes(nNorm)) continue;
      }

      // ✅ 중복 제거(이름)
      if (nNorm && seenName.has(nNorm)) continue;
      if (nNorm) seenName.add(nNorm);

      // ✅ 보조 중복(이름+주소prefix)
      const key = `${nNorm}|${aPref}`;
      if (aPref && seenNameAddr.has(key)) continue;
      if (aPref) seenNameAddr.add(key);

      filtered.push(c);
      if (filtered.length >= limit) break;
      if (Date.now() - started > hardMs) break;
    }

    // ✅ 키워드 많은 순 우선
    filtered.sort((a, b) => (b.keywords?.length || 0) - (a.keywords?.length || 0));

    const out = filtered.slice(0, limit).map((x) => ({
      placeId: x.placeId,
      url: x.url,
      name: x.name,
      keywords: Array.isArray(x.keywords) ? x.keywords : []
    }));

    console.log("[COMP][crawl-fast] final competitors:", out.length);
    return out;
  }
}
