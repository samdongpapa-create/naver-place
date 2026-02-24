// src/services/searchadKeywordTool.ts
import crypto from "crypto";

type KeywordToolItem = {
  relKeyword?: string;
  monthlyPcQcCnt?: number | string;
  monthlyMobileQcCnt?: number | string;
};

export type KeywordVolume = {
  keyword: string;
  pc: number;
  mobile: number;
  total: number;
};

function toNumber(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return isFinite(v) ? v : 0;
  const s = String(v).trim();
  if (!s) return 0;
  // 네이버가 "< 10" 같은 형태로 줄 때가 있어서 방어
  if (s.startsWith("<")) return 0;
  const n = Number(s.replace(/,/g, ""));
  return isFinite(n) ? n : 0;
}

/**
 * 네이버 SearchAd API 시그니처 생성
 * signature = Base64( HMAC-SHA256(secret, `${timestamp}.${method}.${uri}`) )
 */
function makeSignature(secret: string, timestamp: string, method: string, uri: string) {
  const message = `${timestamp}.${method}.${uri}`;
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(message);
  return hmac.digest("base64");
}

async function fetchJson(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {}
  if (!res.ok) {
    const msg = json?.message || json?.error?.message || text || `HTTP ${res.status}`;
    throw new Error(`SearchAd API error: ${msg}`);
  }
  return json;
}

/**
 * 키워드 도구 조회
 * - hintKeywords는 콤마로 구분되는 키워드
 * - showDetail=1이면 월간 PC/모바일 검색량을 줌
 */
export async function fetchKeywordVolumes(hintKeywords: string[]): Promise<KeywordVolume[]> {
  const base = (process.env.NAVER_AD_API_BASE || "https://api.searchad.naver.com").replace(/\/+$/, "");
  const apiKey = process.env.NAVER_AD_API_KEY || "";
  const secret = process.env.NAVER_AD_SECRET || "";
  const customerId = process.env.NAVER_AD_CUSTOMER_ID || "";

  if (!apiKey || !secret || !customerId) {
    throw new Error("Missing SearchAd env vars: NAVER_AD_API_KEY / NAVER_AD_SECRET / NAVER_AD_CUSTOMER_ID");
  }

  // 공백 제거(Invalid parameter 방지)
  const hints = (hintKeywords || [])
    .map((k) => String(k || "").trim())
    .filter(Boolean)
    .map((k) => k.replace(/\s+/g, "")) // ✅ 중요
    .slice(0, 20);

  if (!hints.length) return [];

  const uri = "/keywordstool";
  const method = "GET";
  const timestamp = String(Date.now());
  const signature = makeSignature(secret, timestamp, method, uri);

  const qs = new URLSearchParams({
    hintKeywords: hints.join(","),
    showDetail: "1"
  });

  const url = `${base}${uri}?${qs.toString()}`;

  const json = await fetchJson(url, {
    method,
    headers: {
      "Content-Type": "application/json; charset=UTF-8",
      "X-Timestamp": timestamp,
      "X-API-KEY": apiKey,
      "X-Customer": customerId,
      "X-Signature": signature
    }
  });

  // 응답 구조는 보통 { keywordList: [...] }
  const list: KeywordToolItem[] = Array.isArray(json?.keywordList) ? json.keywordList : [];

  return list
    .map((it) => {
      const keyword = String(it?.relKeyword || "").trim();
      const pc = toNumber(it?.monthlyPcQcCnt);
      const mobile = toNumber(it?.monthlyMobileQcCnt);
      return { keyword, pc, mobile, total: pc + mobile };
    })
    .filter((x) => x.keyword);
}

/**
 * (미용실용) 시술 후보들 중 트래픽 높은 TOP2 선택
 */
export async function pickTopServiceKeywordsByTraffic(candidates: string[]): Promise<string[]> {
  const vols = await fetchKeywordVolumes(candidates);
  const sorted = vols.sort((a, b) => b.total - a.total);
  const out: string[] = [];
  for (const v of sorted) {
    if (out.length >= 2) break;
    out.push(v.keyword);
  }
  return out;
}
