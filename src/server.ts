// src/server.ts
import express from "express";
import cors from "cors";
import path from "path";

import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";

import type { Industry } from "./lib/scoring/types";
import { scorePlace } from "./lib/scoring/engine";

import { CompetitorService } from "./services/competitorService";
import { UrlConverter } from "./services/modules/urlConverter";

import { generatePaidConsultingGuaranteed } from "./services/gptConsulting";
import { pickTopServiceKeywordsByTraffic } from "./services/searchadKeywordTool";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

/**
 * ✅ Railway에서 간헐적으로 Playwright/timeout류가 언핸들로 튀면 프로세스가 죽을 수 있어서 안전망
 * - 절대 throw로 프로세스 죽이지 말고 로그만 남김
 */
process.on("unhandledRejection", (reason: any) => {
  console.error("[FATAL-GUARD] unhandledRejection:", reason?.message || reason);
});
process.on("uncaughtException", (err: any) => {
  console.error("[FATAL-GUARD] uncaughtException:", err?.message || err);
});

/** utils */
function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function clampText(s: string, max: number) {
  const t = String(s || "").trim();
  if (!t) return "";
  return t.length > max ? t.slice(0, max).trim() : t;
}

function buildScoreExplain(scores: any) {
  const explain: any = {};
  const obj = scores && typeof scores === "object" ? scores : {};

  const classify = (s: string) => {
    const t = String(s || "").trim();
    if (!t) return null;
    if (/양호|포함된|있습니다|보통|충분|우수|문단/.test(t)) return { type: "good", text: t };
    return { type: "bad", text: t };
  };

  for (const [k, v] of Object.entries(obj)) {
    const score = typeof (v as any)?.score === "number" ? (v as any).score : 0;
    const issues = Array.isArray((v as any)?.issues) ? (v as any).issues : [];
    const good: string[] = [];
    const bad: string[] = [];

    for (const it of issues) {
      const c = classify(String(it || ""));
      if (!c) continue;
      if (c.type === "good") good.push(c.text);
      else bad.push(c.text);
    }

    explain[k] = { score, good: good.slice(0, 3), bad: bad.slice(0, 3) };
  }

  return explain;
}

function extractPlaceIdSafe(url: string): string {
  const m = String(url || "").match(/(\d{5,12})/);
  return m?.[1] || "";
}

function guessSearchQuery(industry: Industry, name: string, address: string): string {
  const indWord = industry === "hairshop" ? "미용실" : industry === "cafe" ? "카페" : "맛집";
  const nm = String(name || "");
  const ad = String(address || "");

  const m1 = nm.match(/([가-힣]{2,10})역/);
  if (m1?.[1]) return `${m1[1]}역 ${indWord}`;

  const parts = ad.split(/\s+/).map((s) => s.trim()).filter(Boolean);
  const cand = parts.find((p) => /(역|동|구)$/.test(p) && p.length <= 10);
  if (cand) return `${cand} ${indWord}`;

  return industry === "hairshop"
    ? "서대문역 미용실"
    : industry === "cafe"
    ? "서대문역 카페"
    : "서대문역 맛집";
}

async function crawl(placeUrl: string) {
  const mobileUrl = convertToMobileUrl(placeUrl);
  const crawler = new ModularCrawler();
  return await crawler.crawlPlace(mobileUrl);
}

function getLocalityToken(name: string, address: string): string {
  const nm = (name || "").trim();
  const ad = (address || "").trim();

  const m = nm.match(/([가-힣]{2,10})역/);
  if (m?.[1]) return `${m[1]}역`;

  if (ad) {
    const parts = ad.split(/\s+/).map((s) => s.trim()).filter(Boolean);
    const p1 = parts.find((p) => /역$/.test(p) && p.length <= 10);
    if (p1) return p1;
    const p2 = parts.find((p) => /동$/.test(p) && p.length <= 10);
    if (p2) return p2;
    const p3 = parts.find((p) => /구$/.test(p) && p.length <= 10);
    if (p3) return p3;
  }
  return "";
}

function getDistrictToken(address: string): string {
  const ad = (address || "").replace(/\s+/g, " ").trim();
  if (!ad) return "";
  const parts = ad.split(" ").filter(Boolean);
  const gu = parts.find((p) => /구$/.test(p) && p.length <= 6);
  if (gu) return gu.replace(/구$/, "");
  return "";
}

function getCity(address: string): string {
  const ad = (address || "").replace(/\s+/g, " ").trim();
  const parts = ad.split(" ").filter(Boolean);
  return parts[0] || "";
}

/**
 * ✅ 업종군 추정
 */
type BusinessProfile = {
  scoreIndustry: Industry;
  category: string;
  categoryK: string;
  serviceTokens: string[];
  menuMustHave: string[];
  menuSuggestions: string[];
  categoryBoost: string[];
};

function detectBusinessProfile(params: {
  reqIndustry?: any;
  name: string;
  address: string;
  keywords?: string[];
  menus?: any[];
}): BusinessProfile {
  const req = String(params.reqIndustry || "").trim().toLowerCase();
  const name = String(params.name || "");
  const address = String(params.address || "");
  const kw = Array.isArray(params.keywords) ? params.keywords.join(" ") : "";
  const menus = Array.isArray(params.menus) ? params.menus : [];
  const menuText = menus.map((m) => String(m?.name || "")).join(" ");
  const text = `${name} ${address} ${kw} ${menuText}`.toLowerCase();

  if (req === "hairshop" || req === "cafe" || req === "restaurant") {
    if (req === "hairshop") {
      return {
        scoreIndustry: "hairshop",
        category: "hairshop",
        categoryK: "미용실",
        serviceTokens: ["커트", "펌", "염색", "클리닉"],
        menuMustHave: ["염색", "탈색", "다운펌"],
        menuSuggestions: ["전체염색", "뿌리염색", "탈색", "다운펌", "두피/모발 클리닉"],
        categoryBoost: ["헤어살롱", "헤어샵", "미용실추천"]
      };
    }
    if (req === "cafe") {
      return {
        scoreIndustry: "cafe",
        category: "cafe",
        categoryK: "카페",
        serviceTokens: ["디저트", "브런치", "테이크아웃", "커피"],
        menuMustHave: ["디저트", "브런치", "테이크아웃"],
        menuSuggestions: ["시그니처 라떼", "디저트", "브런치", "테이크아웃 세트", "베이커리"],
        categoryBoost: ["카페추천", "디저트카페", "브런치카페"]
      };
    }
    return {
      scoreIndustry: "restaurant",
      category: "restaurant",
      categoryK: "맛집",
      serviceTokens: ["점심", "저녁", "포장", "예약"],
      menuMustHave: ["포장", "예약"],
      menuSuggestions: ["대표메뉴", "점심특선", "저녁세트", "포장 가능", "예약 안내"],
      categoryBoost: ["맛집추천", "현지맛집", "숨은맛집"]
    };
  }

  const has = (re: RegExp) => re.test(text);

  if (has(/네일|젤네일|패디|아트|네일샵|왁싱|브라질리언|피부|에스테틱|관리|리프팅|윤곽|필링|속눈썹|왁스/)) {
    return {
      scoreIndustry: "hairshop",
      category: "beauty",
      categoryK: "뷰티샵",
      serviceTokens: ["관리", "상담", "예약", "시술"],
      menuMustHave: ["관리", "상담"],
      menuSuggestions: ["1:1 상담", "기본 관리", "프리미엄 관리", "재방문 관리", "패키지 관리"],
      categoryBoost: ["뷰티샵", "에스테틱", "샵추천"]
    };
  }

  if (has(/헬스|gym|피티|pt|퍼스널|트레이닝|필라테스|요가|크로스핏|체형|다이어트/)) {
    return {
      scoreIndustry: "restaurant",
      category: "fitness",
      categoryK: "헬스장",
      serviceTokens: ["PT", "체형", "운동", "상담"],
      menuMustHave: ["PT", "상담"],
      menuSuggestions: ["PT 상담", "체형 분석", "1:1 트레이닝", "그룹 수업", "체험 등록"],
      categoryBoost: ["헬스장", "PT", "필라테스"]
    };
  }

  if (has(/학원|과외|수학|영어|국어|코딩|컴퓨터|피아노|음악|미술|입시|수업|강의|레슨/)) {
    return {
      scoreIndustry: "restaurant",
      category: "academy",
      categoryK: "학원",
      serviceTokens: ["수업", "상담", "커리큘럼", "레벨"],
      menuMustHave: ["상담", "수업"],
      menuSuggestions: ["상담 예약", "레벨 테스트", "정규 수업", "특강", "체험 수업"],
      categoryBoost: ["학원", "과외", "레슨"]
    };
  }

  if (has(/병원|의원|치과|한의원|진료|검진|치료|예약|접수/)) {
    return {
      scoreIndustry: "restaurant",
      category: "clinic",
      categoryK: "병원",
      serviceTokens: ["진료", "예약", "상담", "검진"],
      menuMustHave: ["진료", "예약"],
      menuSuggestions: ["진료 예약", "초진 상담", "검진 안내", "치료 안내", "재진 예약"],
      categoryBoost: ["병원", "의원", "클리닉"]
    };
  }

  if (has(/부동산|공인중개|중개|매물|임대|전세|월세|매매/)) {
    return {
      scoreIndustry: "restaurant",
      category: "realestate",
      categoryK: "부동산",
      serviceTokens: ["매물", "상담", "임대", "매매"],
      menuMustHave: ["상담", "매물"],
      menuSuggestions: ["매물 상담", "임대/전세 상담", "매매 상담", "현장 안내", "계약 안내"],
      categoryBoost: ["부동산", "공인중개", "중개"]
    };
  }

  return {
    scoreIndustry: "restaurant",
    category: "generic",
    categoryK: "매장",
    serviceTokens: ["예약", "상담", "문의", "방문"],
    menuMustHave: ["예약", "문의"],
    menuSuggestions: ["예약 안내", "상담 안내", "문의 방법", "대표 서비스", "이용 안내"],
    categoryBoost: ["추천", "후기", "인기"]
  };
}

/**
 * ✅ 경쟁사 키워드 TopN(빈도)
 */
function normalizeKw(k: string) {
  return String(k || "").replace(/\s+/g, "").trim();
}

function buildCompetitorKeywordTop(
  competitorKeywordsFlat: string[],
  topN = 20
): { top: string[]; freq: Record<string, number> } {
  const freq = new Map<string, number>();
  for (const k of competitorKeywordsFlat || []) {
    const nk = normalizeKw(k);
    if (!nk) continue;
    if (nk.length < 2 || nk.length > 25) continue;
    if (/(추천|베스트|할인|가격|이벤트|예약|문의|네이버)/.test(nk)) continue;
    freq.set(nk, (freq.get(nk) || 0) + 1);
  }
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
  const top = sorted.slice(0, topN).map(([k]) => k);
  const obj: Record<string, number> = {};
  for (const [k, v] of sorted.slice(0, Math.max(topN, 30))) obj[k] = v;
  return { top, freq: obj };
}

/**
 * ✅ 트래픽 우선형 대표키워드 5개
 */
function buildRecommendedKeywordsTrafficFirst(params: {
  categoryK: string;
  categoryBoost: string[];
  myName: string;
  myAddress: string;
  competitorKeywordTop: string[];
  menuTerms?: string[];
}): { recommended: string[]; debug: any } {
  const { categoryK, myName, myAddress, competitorKeywordTop } = params;

  const locality = getLocalityToken(myName, myAddress);
  const district = getDistrictToken(myAddress);
  const city = getCity(myAddress);

  const expansionPool = ["광화문", "종로", "시청", "서울역", "경복궁", "명동", "충정로", district].filter(Boolean);
  const brand = normalizeKw(myName).replace(/[^\w가-힣]/g, "");

  const out: string[] = [];
  const push = (k: string) => {
    const x = normalizeKw(k);
    if (!x) return;
    if (x.length < 2) return;
    if (out.includes(x)) return;
    out.push(x);
  };

  const regionBase = locality || district || "";
  if (regionBase) push(`${regionBase}${categoryK}`);
  else push(`${categoryK}`);

  for (const kw of competitorKeywordTop || []) {
    if (out.length >= 3) break;
    if (!kw.includes(categoryK)) continue;
    if (/(커트|컷|펌|염색|탈색|클리닉|다운펌|볼륨매직|매직|두피|레이어드|남자펌|여자펌|복구)/.test(kw)) continue;
    push(kw);
  }

  for (const w of expansionPool) {
    if (out.length >= 3) break;
    push(`${w}${categoryK}`);
  }

  const trafficMenuPoolByCategoryK: Record<string, string[]> = {
    미용실: ["커트", "펌", "염색", "클리닉", "다운펌", "볼륨매직", "매직", "탈색", "두피클리닉", "레이어드컷"],
    카페: ["디저트", "브런치", "커피", "테이크아웃", "라떼", "아메리카노", "케이크", "베이커리"],
    맛집: ["점심", "저녁", "예약", "포장", "가성비", "혼밥", "데이트", "단체"]
  };
  const basePool = trafficMenuPoolByCategoryK[categoryK] || ["커트", "펌", "예약", "문의"];

  const menuPick = basePool.slice(0, 2);
  push(menuPick[0]);
  push(menuPick[1]);

  const hasRegionCategory = out.filter((x) => x.endsWith(categoryK) && x !== categoryK).length >= 2;

  const cleaned = out.filter((x) => {
    if (x === categoryK && hasRegionCategory) return false;
    return true;
  });

  const fill: string[] = [];
  if (brand) fill.push(brand);
  for (const b of params.categoryBoost || []) fill.push(b);

  const final: string[] = [];
  for (const k of cleaned) {
    if (final.length >= 5) break;
    final.push(k);
  }
  for (const k of fill) {
    if (final.length >= 5) break;
    if (!final.includes(k)) final.push(k);
  }
  while (final.length < 5) {
    if (brand && !final.includes(brand)) final.push(brand);
    else break;
  }

  return {
    recommended: final.slice(0, 5),
    debug: {
      locality,
      district,
      city,
      expansionPool,
      brand,
      categoryK,
      categoryBoost: params.categoryBoost,
      competitorKeywordTopSample: (competitorKeywordTop || []).slice(0, 10)
    }
  };
}

function injectNaturalServiceTerms(params: {
  text: string;
  serviceTokens: string[];
  maxInsert: number;
  maxLen: number;
  style: "description" | "directions";
}): { text: string; inserted: string[] } {
  const base = String(params.text || "").trim();
  if (!base) return { text: "", inserted: [] };

  const inserted: string[] = [];
  const tokens = (params.serviceTokens || []).map((s) => String(s).trim()).filter(Boolean);

  const hasToken = (t: string) => base.includes(t);
  const need = tokens.filter((t) => !hasToken(t)).slice(0, params.maxInsert);

  if (!need.length) {
    return { text: clampText(base, params.maxLen), inserted: [] };
  }

  const sentence =
    params.style === "description"
      ? ` 시술은 ${need.join(", ")} 등으로 진행되며, 컨디션에 맞춰 상담 후 맞춤으로 도와드립니다.`
      : ` 방문 전 ${need[0]} 관련 상담/문의도 가능하니 예약 후 편하게 요청해 주세요.`;

  const merged = clampText(`${base}${sentence}`, params.maxLen);
  inserted.push(...need);

  return { text: merged, inserted };
}

function injectReviewScriptServiceHint(s: string, token: string): string {
  const base = String(s || "").trim();
  if (!base) return "";
  if (token && base.includes(token)) return base;
  if (!token) return base;
  return `${base} 가능하시다면 "${token}" 만족도도 한 줄만 적어주시면 다음 고객분들께 큰 도움이 됩니다 😊`;
}

function buildMenuGuidance(params: {
  menus?: any[];
  mustHave: string[];
  suggestions: string[];
}): { missing: string[]; suggestionExamples: string[]; note: string } {
  const menus = Array.isArray(params.menus) ? params.menus : [];
  const text = menus.map((m) => String(m?.name || "")).join(" ");

  const missing = (params.mustHave || []).filter((t) => t && !text.includes(t));
  const suggestionExamples = (params.suggestions || []).slice(0, 6);

  const note =
    missing.length === 0
      ? "✅ 핵심 메뉴 키워드가 메뉴명에 이미 포함되어 있습니다."
      : `⚠️ 메뉴명에 핵심 키워드가 부족합니다: ${missing.join(", ")}\n- 메뉴명에 핵심 단어(예: ${missing[0]})가 포함되면 검색/전환에 유리합니다.`;

  return { missing, suggestionExamples, note };
}

/**
 * ✅ HARD timeout 제거(중요)
 * - Promise.race로 reject하면, 내부 Playwright 작업은 취소되지 않고 계속 돌아서
 *   finally에서 browser close 이후 백그라운드 에러가 터질 수 있음
 *
 * ✅ 대신 SOFT timeout 사용: 시간 지나면 fallback 반환 (절대 throw X)
 *
 * ⚠️ 하지만 경쟁사 수집(Playwright)은 여기서 race로 끊으면 “0개 반환” 레이스가 생김.
 * 그래서 competitor 쪽에서는 이 함수를 쓰지 않고, 서비스 내부 timeoutMs로만 끊는다.
 */
async function withSoftTimeout<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((resolve) => {
    timer = setTimeout(() => resolve(fallback), ms);
  });

  try {
    return await Promise.race([p, timeoutPromise]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * ✅ 경쟁사 안전 호출 (부분성공 살리기)
 */
function getCompetitorTimeouts() {
  const total = Number(process.env.COMPETITOR_TOTAL_TIMEOUT_MS || 18000);
  const perTry = Number(process.env.COMPETITOR_QUERY_TIMEOUT_MS || 12000);

  const safeTotal = Math.max(7000, Math.min(45000, isFinite(total) ? total : 18000));
  const safePerTry = Math.max(3000, Math.min(20000, isFinite(perTry) ? perTry : 12000));

  return { safeTotal, safePerTry };
}

/**
 * ✅ 경쟁사 수집 (중요 변경)
 * - 여기서는 withSoftTimeout(Promise.race) 사용 금지
 * - 이유: race로 먼저 [] 반환되면 "no competitors"가 찍히고,
 *   실제 크롤러는 취소 안 되어 뒤에서 keyword snapshot이 늦게 찍히는 레이스가 발생
 *
 * ✅ 해결: competitorService.findTopCompetitorsByKeyword(...) 를 "항상 await"하고,
 *    timeoutMs는 service 내부 deadline로만 처리
 */
async function getCompetitorsSafe(params: {
  compSvc: CompetitorService;
  placeId: string;
  queries: string[];
  limit: number;
  totalTimeoutMs: number;
}) {
  const { compSvc, placeId, queries, limit, totalTimeoutMs } = params;

  const started = Date.now();
  const { safePerTry } = getCompetitorTimeouts();

  const collected: any[] = [];
  const seen = new Set<string>();

  const pushMany = (arr: any[]) => {
    for (const c of arr || []) {
      const pid = String(c?.placeId || "").trim();
      if (!pid) continue;
      if (seen.has(pid)) continue;
      if (pid === String(placeId || "").trim()) continue;
      seen.add(pid);
      collected.push(c);
      if (collected.length >= limit) break;
    }
  };

  for (const q of queries) {
    const elapsed = Date.now() - started;
    const remainingMs = totalTimeoutMs - elapsed;
    // ✅ 너무 시간이 적으면 다음 쿼리 자체를 스킵 (성공률 급락 + Abort 연쇄 방지)
if (remainingMs < 4500) {
  console.log("[PAID][COMP] skip query due to low remainingMs:", q, "remainingMs:", remainingMs);
  continue;
}

// ✅ perTry는 remainingMs를 절대 초과하지 않게(여유 200ms 남김)
const perTryTimeoutMs = Math.max(3500, Math.min(safePerTry, remainingMs - 200));

    console.log("[PAID][COMP] try query:", q, "remainingMs:", remainingMs, "perTryTimeoutMs:", perTryTimeoutMs);

    let comps: any[] = [];
    try {
      comps = await compSvc.findTopCompetitorsByKeyword(q, {
        excludePlaceId: placeId,
        limit,
        timeoutMs: perTryTimeoutMs
      });
    } catch (e: any) {
      console.warn("[PAID][COMP] findTopCompetitorsByKeyword failed:", e?.message || String(e));
      comps = [];
    }

    if (Array.isArray(comps) && comps.length) {
      try {
        const snap = comps.map((c: any, i: number) => ({
          rank: i + 1,
          placeId: c.placeId,
          name: c.name,
          kwCount: Array.isArray(c.keywords) ? c.keywords.length : 0,
          keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 5) : []
        }));
        if (Array.isArray(comps) && comps.length) {
  // ✅ 디버그: 여기서 comps가 실제 몇 개인지 확인
  try {
    console.log(
      "[PAID][COMP] comps_len:",
      comps.length,
      "ids:",
      comps.map((x: any) => String(x?.placeId || "")).join(",")
    );
  } catch {}

  try {
    const snap = comps.map((c: any, i: number) => ({
      rank: i + 1,
      placeId: c.placeId,
      name: c.name,
      kwCount: Array.isArray(c.keywords) ? c.keywords.length : 0,
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 5) : []
    }));
    console.log("[PAID][COMP] keyword snapshot:", JSON.stringify(snap));
  } catch {}

  pushMany(comps);
  if (collected.length >= limit) break;
}
        console.log("[PAID][COMP] keyword snapshot:", JSON.stringify(snap));
      } catch {}

      pushMany(comps);
      if (collected.length >= limit) break;
    } else {
      console.log("[PAID][COMP] no competitors from query:", q);
    }
  }

  return collected.slice(0, limit);
}

/** FREE */
app.post("/api/diagnose/free", async (req, res) => {
  try {
    const { placeUrl, industry } = req.body as { placeUrl: string; industry?: any };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({ success: false, message: "유효한 네이버 플레이스 URL이 아닙니다.", logs: [] });
    }

    const crawled = await crawl(placeUrl);
    if (!crawled.success || !crawled.data) {
      return res.status(500).json({ success: false, message: crawled.error || "크롤링 실패", logs: crawled.logs || [] });
    }

    const prof = detectBusinessProfile({
      reqIndustry: industry,
      name: crawled.data.name,
      address: crawled.data.address,
      keywords: crawled.data.keywords,
      menus: (crawled.data as any).menus
    });

    const scored = scorePlace({
      industry: prof.scoreIndustry,
      name: crawled.data.name,
      address: crawled.data.address,
      description: crawled.data.description,
      directions: crawled.data.directions,
      keywords: crawled.data.keywords,
      reviewCount: crawled.data.reviewCount,
      recentReviewCount30d: (crawled.data as any).recentReviewCount30d,
      photoCount: crawled.data.photoCount,
      menuCount: crawled.data.menuCount,
      menus: crawled.data.menus
    });

    return res.json({
      success: true,
      data: {
        placeData: crawled.data,
        scores: scored.scores,
        scoreExplain: buildScoreExplain(scored.scores),
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: false,
        businessProfile: {
          scoreIndustry: prof.scoreIndustry,
          category: prof.category,
          categoryK: prof.categoryK
        }
      },
      logs: crawled.logs || []
    });
  } catch (e: any) {
    console.error("free diagnose 오류:", e);
    return res.status(500).json({ success: false, message: "진단 중 오류 발생", logs: [String(e?.message || e)] });
  }
});

/** PAID */
app.post("/api/diagnose/paid", async (req, res) => {
  let compSvc: CompetitorService | null = null;

  try {
    const { placeUrl, industry, searchQuery } = req.body as { placeUrl: string; industry?: any; searchQuery?: string };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({ success: false, message: "유효한 네이버 플레이스 URL이 아닙니다.", logs: [] });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);
    const placeId =
      UrlConverter.extractPlaceId(mobileUrl) || extractPlaceIdSafe(mobileUrl) || extractPlaceIdSafe(placeUrl);

    const crawler = new ModularCrawler();
    const crawlResult = await crawler.crawlPlace(mobileUrl);

    if (!crawlResult.success || !crawlResult.data) {
      return res
        .status(500)
        .json({ success: false, message: crawlResult.error || "크롤링 실패", logs: crawlResult.logs || [] });
    }

    const prof = detectBusinessProfile({
      reqIndustry: industry,
      name: crawlResult.data.name,
      address: crawlResult.data.address,
      keywords: crawlResult.data.keywords,
      menus: (crawlResult.data as any).menus
    });

    const finalQuery =
      (searchQuery || "").trim() || guessSearchQuery(prof.scoreIndustry, crawlResult.data.name, crawlResult.data.address);
    console.log("[PAID] searchQuery:", finalQuery);

    const scored = scorePlace({
      industry: prof.scoreIndustry,
      name: crawlResult.data.name,
      address: crawlResult.data.address,
      description: crawlResult.data.description,
      directions: crawlResult.data.directions,
      keywords: crawlResult.data.keywords,
      reviewCount: crawlResult.data.reviewCount,
      recentReviewCount30d: (crawlResult.data as any).recentReviewCount30d,
      photoCount: crawlResult.data.photoCount,
      menuCount: crawlResult.data.menuCount,
      menus: crawlResult.data.menus
    });

    compSvc = new CompetitorService();

    const locality = getLocalityToken(crawlResult.data.name, crawlResult.data.address);
    const queryCandidates = uniq(
      [
        finalQuery,
        locality ? `${locality} ${prof.categoryK}` : "",
        locality && crawlResult.data.name ? `${locality} ${String(crawlResult.data.name).replace(/\s+/g, " ").trim()}` : ""
      ].filter(Boolean)
    ).slice(0, 3);

    const { safeTotal } = getCompetitorTimeouts();
    const competitors = await getCompetitorsSafe({
      compSvc,
      placeId,
      queries: queryCandidates,
      limit: 5,
      totalTimeoutMs: Number.isFinite(safeTotal) ? safeTotal : 18000
    });

    console.log("[PAID] competitors:", competitors.length, "queries:", queryCandidates);

    const competitorKeywordsFlat = competitors.flatMap((c: any) => (Array.isArray(c.keywords) ? c.keywords : []));
    const compTop = buildCompetitorKeywordTop(competitorKeywordsFlat, 20);

    const traffic = buildRecommendedKeywordsTrafficFirst({
      categoryK: prof.categoryK,
      categoryBoost: prof.categoryBoost,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      competitorKeywordTop: compTop.top,
      menuTerms: prof.serviceTokens
    });

    let top2ServiceByTraffic: string[] = [];
    try {
      if (prof.scoreIndustry === "hairshop") {
        const candidates = ["커트", "펌", "염색", "클리닉", "다운펌", "볼륨매직", "매직", "탈색", "두피클리닉", "레이어드컷", "남자펌"];
        top2ServiceByTraffic = await pickTopServiceKeywordsByTraffic(candidates);
      }
    } catch (e: any) {
      console.log("[PAID][SearchAd] keyword tool failed:", e?.message || String(e));
    }

    let finalRecommendedKeywords = traffic.recommended.slice(0, 5);

    if (Array.isArray(top2ServiceByTraffic) && top2ServiceByTraffic.length === 2) {
      finalRecommendedKeywords = [
        finalRecommendedKeywords[0],
        finalRecommendedKeywords[1],
        finalRecommendedKeywords[2],
        String(top2ServiceByTraffic[0] || "").replace(/\s+/g, ""),
        String(top2ServiceByTraffic[1] || "").replace(/\s+/g, "")
      ]
        .filter(Boolean)
        .slice(0, 5);
    }

    console.log("[PAID] finalRecommendedKeywords:", finalRecommendedKeywords);

    const menuGuidance = buildMenuGuidance({
      menus: (crawlResult.data as any).menus,
      mustHave: prof.menuMustHave,
      suggestions: prof.menuSuggestions
    });

    const gpt = await generatePaidConsultingGuaranteed({
      industry: prof.scoreIndustry,
      placeData: crawlResult.data,
      scoredNow: { totalScore: scored.totalScore, totalGrade: scored.totalGrade, scores: scored.scores },
      competitorTopKeywords: compTop.top,
      targetScore: 90,
      forcedRecommendedKeywords: finalRecommendedKeywords
    });

    const imp = (gpt as any)?.improvements || {};

    const descInjected = injectNaturalServiceTerms({
      text: String(imp.description || ""),
      serviceTokens: prof.serviceTokens,
      maxInsert: 2,
      maxLen: 650,
      style: "description"
    });

    const dirInjected = injectNaturalServiceTerms({
      text: String(imp.directions || ""),
      serviceTokens: prof.serviceTokens,
      maxInsert: 1,
      maxLen: 420,
      style: "directions"
    });

    const reviewToken = prof.serviceTokens?.[0] || "";
    const rr = imp.reviewRequestScripts || {};
    rr.short = injectReviewScriptServiceHint(String(rr.short || ""), reviewToken);
    rr.friendly = injectReviewScriptServiceHint(String(rr.friendly || ""), reviewToken);
    rr.polite = injectReviewScriptServiceHint(String(rr.polite || ""), reviewToken);

    imp.description = descInjected.text;
    imp.directions = dirInjected.text;
    imp.reviewRequestScripts = rr;

    imp.keywords = finalRecommendedKeywords;
    (gpt as any).recommendedKeywords = finalRecommendedKeywords;

    const baseInsight = String(imp.competitorKeywordInsights || "").trim();
    const topLine = compTop.top.length ? `\n\n[경쟁사 키워드 TOP]\n- ${compTop.top.slice(0, 10).join("\n- ")}` : "";
    imp.competitorKeywordInsights = clampText(
      (baseInsight ? baseInsight : "경쟁사 키워드에서 자주 등장하는 표현을 참고하세요.") + topLine,
      1200
    );

    const competitorKeywordsDebug = competitors.map((c: any) => ({
      placeId: c.placeId,
      name: c.name,
      kwCount: Array.isArray(c.keywords) ? c.keywords.length : 0,
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 10) : []
    }));

    return res.json({
      success: true,
      data: {
        placeData: crawlResult.data,
        scores: scored.scores,
        scoreExplain: buildScoreExplain(scored.scores),
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: true,

        businessProfile: {
          scoreIndustry: prof.scoreIndustry,
          category: prof.category,
          categoryK: prof.categoryK,
          serviceTokens: prof.serviceTokens
        },

        improvements: imp,
        recommendedKeywords: finalRecommendedKeywords,

        competitorsSimple: competitors.map((c: any, idx: number) => ({
          rank: idx + 1,
          name: c?.name || `경쟁사 ${idx + 1}`,
          keywords: Array.isArray(c?.keywords) ? c.keywords.slice(0, 5) : []
        })),

        additionalRecommendedKeywords: compTop.top.filter((k) => !finalRecommendedKeywords.includes(k)).slice(0, 5),

        competitors,
        competitorKeywordsDebug,

        competitorKeywordTop: compTop.top,
        competitorKeywordFreq: compTop.freq,

        menuGuidance,

        injectDebug: {
          descriptionInserted: descInjected.inserted,
          directionsInserted: dirInjected.inserted,
          reviewTokenUsed: reviewToken
        },

        keywordStrategyDebug: traffic.debug,

        predictedAfter: (gpt as any).predicted,
        attempts: (gpt as any).attempts,
        unifiedText: (gpt as any).unifiedText,

        searchQueryUsed: finalQuery,
        searchQueryTried: queryCandidates
      },
      logs: crawlResult.logs || []
    });
  } catch (e: any) {
    console.error("paid diagnose 오류:", e);
    return res.status(500).json({ success: false, message: "유료 진단 중 오류 발생", logs: [String(e?.message || e)] });
  } finally {
    try {
      await compSvc?.close();
    } catch {}
  }
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ success: false, message: "Not Found" });
  return res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
