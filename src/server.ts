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

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

// ✅ util
function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function normalizeIndustry(v: any): Industry {
  if (v === "cafe" || v === "restaurant" || v === "hairshop") return v;
  return "hairshop";
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

  // "서울 종로구 ..." -> "종로"
  const gu = parts.find((p) => /구$/.test(p) && p.length <= 6);
  if (gu) return gu.replace(/구$/, "");

  // 혹시 "강남" 같은 이미 구 없이 들어오는 경우는 거의 없어서 스킵
  return "";
}

function getCityDistrict(address: string): { city: string; district: string } {
  const ad = (address || "").replace(/\s+/g, " ").trim();
  const parts = ad.split(" ").filter(Boolean);
  const city = parts[0] || "";
  const gu = parts.find((p) => /구$/.test(p) && p.length <= 6) || "";
  return { city, district: gu.replace(/구$/, "") };
}

function industryKorean(ind: Industry): string {
  if (ind === "hairshop") return "미용실";
  if (ind === "cafe") return "카페";
  return "맛집";
}

/**
 * ✅ 트래픽 우선형 대표키워드 5개
 * - 대표키워드에는 '커트/펌/염색' 같이 검색량 낮은 서비스키워드 넣지 않음
 * - "지역+업종", "생활권 확장(랜드마크/인접상권)", "카테고리/브랜드" 중심
 * - 경쟁사 키워드는 참고하되, 지역서비스 조합은 대표키워드에 직접 넣지 않음
 */
function buildRecommendedKeywordsTrafficFirst(params: {
  industry: Industry;
  myName: string;
  myAddress: string;
  competitorKeywordsFlat: string[];
}): { recommended: string[]; debug: any } {
  const { industry, myName, myAddress, competitorKeywordsFlat } = params;

  const indK = industryKorean(industry);
  const locality = getLocalityToken(myName, myAddress); // "서대문역"
  const district = getDistrictToken(myAddress); // "종로"
  const { city } = getCityDistrict(myAddress);

  // ✅ 업종별 "카테고리 강화" 키워드 (대표키워드용)
  const categoryBoost =
    industry === "hairshop"
      ? ["헤어살롱", "헤어샵", "미용실추천"]
      : industry === "cafe"
      ? ["카페추천", "디저트카페", "브런치카페"]
      : ["맛집추천", "현지맛집", "숨은맛집"];

  // ✅ 대표키워드에 넣으면 오히려 구린 “저트래픽 서비스키워드” 제거
  const serviceLowTraffic =
    industry === "hairshop"
      ? ["커트", "컷", "펌", "염색", "탈색", "클리닉", "다운펌", "볼륨매직", "매직", "레이어드컷", "단발", "남자펌"]
      : industry === "cafe"
      ? ["아메리카노", "라떼", "케이크", "디저트", "브런치", "테이크아웃", "베이커리"]
      : ["점심", "저녁", "포장", "배달", "회식", "데이트", "예약"];

  const svcSet = new Set(serviceLowTraffic);

  const normalize = (k: string) => String(k || "").replace(/\s+/g, "").trim();

  // ✅ 경쟁사 키워드에서 "역/구/동 + 업종" 형태의 ‘큰 트래픽 후보’만 골라온다
  const comp = uniq((competitorKeywordsFlat || []).map(normalize))
    .filter((k) => k.length >= 3 && k.length <= 18)
    .filter((k) => !svcSet.has(k)) // 서비스 단어 단독 제거
    .filter((k) => !/(커트|컷|펌|염색|탈색|클리닉|다운펌|볼륨매직|매직)/.test(k)); // 서비스 포함 조합 제거(대표키워드엔 안 넣음)

  const compHighTraffic = comp.filter((k) => {
    // "서대문역미용실", "광화문미용실", "종로미용실" 같은 패턴 선호
    if (k.includes(indK)) return true;
    // 업종 키워드를 안 붙인 경우는 대표키워드용으로 애매해서 제외
    return false;
  });

  // ✅ 생활권 확장 후보(미용실 예: 광화문/시청/서울역/명동/종로/경복궁)
  // - 하드코딩+주소 기반 혼합
  const expansionPool =
    industry === "hairshop"
      ? ["광화문", "종로", "시청", "서울역", "경복궁", "명동", "충정로"]
      : industry === "cafe"
      ? ["광화문", "종로", "시청", "서울역", "경복궁", "명동", "서촌"]
      : ["광화문", "종로", "시청", "서울역", "경복궁", "명동", "서촌"];

  // district가 있으면 우선
  const districtWord = district ? `${district}${indK}` : "";
  const cityWord = city && district ? `${city}${district}${indK}` : "";

  const out: string[] = [];
  const push = (k: string) => {
    const x = normalize(k);
    if (!x) return;
    if (x.length < 3) return;
    if (out.includes(x)) return;
    out.push(x);
  };

  // 1) 핵심 트래픽: 역/동네 + 업종
  if (locality) push(`${locality}${indK}`); // 서대문역미용실
  else if (district) push(`${district}${indK}`);

  // 2) 생활권 확장(경쟁사/풀에서 1~2개)
  // - 경쟁사에 "광화문미용실" 있으면 그걸 우선
  const pickFromComp = (word: string) => compHighTraffic.find((k) => k.startsWith(word) && k.includes(indK));

  for (const w of expansionPool) {
    if (out.length >= 3) break;
    const fromComp = pickFromComp(w);
    if (fromComp) push(fromComp);
    else push(`${w}${indK}`);
  }

  // 3) 구 단위 확장(종로미용실 같은)
  if (out.length < 3 && districtWord) push(districtWord);

  // 4) 카테고리 강화(헤어살롱/헤어샵 등) 1개
  // - 단, "헤어샵"은 "미용실"과 중복 느낌이면 industry별로 1개만
  if (out.length < 4) push(categoryBoost[0] || indK);

  // 5) 브랜드 방어(상호명) 1개
  // - 공백 제거
  const brand = normalize(myName).replace(/[^\w가-힣]/g, "");
  if (brand) push(brand);

  // 6) 그래도 부족하면 (도시+구+업종) 같은 큰 단위로 채움
  if (out.length < 5 && cityWord) push(cityWord);
  if (out.length < 5 && districtWord) push(districtWord);
  if (out.length < 5 && (categoryBoost[1] || "")) push(categoryBoost[1]);
  if (out.length < 5) push(indK);

  const final5 = out.slice(0, 5);

  return {
    recommended: final5,
    debug: {
      locality,
      district,
      city,
      usedExpansionPool: expansionPool,
      compHighTrafficSample: compHighTraffic.slice(0, 12)
    }
  };
}

/**
 * ✅ 점수용 텍스트(상세설명/리뷰요청/메뉴)에 서비스 키워드 자연 삽입용 힌트
 * - 대표키워드에는 넣지 않지만, 컨설팅 문구에서 점수/노출을 끌어올릴 때 쓰는 용도
 */
function buildServiceInsertHints(industry: Industry): string[] {
  if (industry === "hairshop") return ["커트", "펌", "염색", "클리닉"];
  if (industry === "cafe") return ["디저트", "브런치", "테이크아웃", "커피"];
  return ["점심", "저녁", "포장", "예약"];
}

async function withTimeout<T>(p: Promise<T>, ms: number, label = "timeout"): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(label)), ms);
  });
  try {
    return await Promise.race([p, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function getCompetitorsSafe(params: {
  compSvc: CompetitorService;
  industry: Industry;
  placeId: string;
  myName: string;
  myAddress: string;
  queries: string[];
  limit: number;
  totalTimeoutMs: number;
}) {
  const { compSvc, industry, placeId, myName, myAddress, queries, limit, totalTimeoutMs } = params;

  const started = Date.now();
  const competitors: any[] = [];

  for (const q of queries) {
    const remainingMs = totalTimeoutMs - (Date.now() - started);
    if (remainingMs <= 200) break;

    try {
      console.log("[PAID][COMP] try query:", q, "remainingMs:", remainingMs);

      const ids = await withTimeout(
        compSvc.findTopPlaceIds(q, placeId, limit),
        Math.min(2500, remainingMs),
        "compIds-timeout"
      );
      if (!ids?.length) continue;

      const comps = await withTimeout(
        compSvc.crawlCompetitorsByIds(ids, industry, limit, {
          excludePlaceId: placeId,
          myName,
          myAddress
        }),
        Math.min(3800, remainingMs),
        "compCrawl-timeout"
      );

      if (Array.isArray(comps) && comps.length) {
        competitors.push(...comps);
        break;
      }
    } catch (e: any) {
      console.log("[PAID][COMP] query failed:", q, e?.message || String(e));
    }
  }

  const uniqById = new Map<string, any>();
  for (const c of competitors) {
    if (!c?.placeId) continue;
    if (!uniqById.has(c.placeId)) uniqById.set(c.placeId, c);
    if (uniqById.size >= limit) break;
  }

  return Array.from(uniqById.values()).slice(0, limit);
}

app.post("/api/diagnose/free", async (req, res) => {
  try {
    const { placeUrl, industry } = req.body as { placeUrl: string; industry?: Industry };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({ success: false, message: "유효한 네이버 플레이스 URL이 아닙니다.", logs: [] });
    }

    const crawled = await crawl(placeUrl);
    if (!crawled.success || !crawled.data) {
      return res.status(500).json({ success: false, message: crawled.error || "크롤링 실패", logs: crawled.logs || [] });
    }

    const scored = scorePlace({
      industry: normalizeIndustry(industry),
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
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: false
      },
      logs: crawled.logs || []
    });
  } catch (e: any) {
    console.error("free diagnose 오류:", e);
    return res.status(500).json({ success: false, message: "진단 중 오류 발생", logs: [String(e?.message || e)] });
  }
});

app.post("/api/diagnose/paid", async (req, res) => {
  let compSvc: CompetitorService | null = null;

  try {
    const { placeUrl, industry, searchQuery } = req.body as { placeUrl: string; industry?: Industry; searchQuery?: string };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({ success: false, message: "유효한 네이버 플레이스 URL이 아닙니다.", logs: [] });
    }

    const ind = normalizeIndustry(industry);

    const mobileUrl = convertToMobileUrl(placeUrl);
    const placeId =
      UrlConverter.extractPlaceId(mobileUrl) ||
      extractPlaceIdSafe(mobileUrl) ||
      extractPlaceIdSafe(placeUrl);

    const crawler = new ModularCrawler();
    const crawlResult = await crawler.crawlPlace(mobileUrl);

    if (!crawlResult.success || !crawlResult.data) {
      return res.status(500).json({ success: false, message: crawlResult.error || "크롤링 실패", logs: crawlResult.logs || [] });
    }

    const finalQuery = (searchQuery || "").trim() || guessSearchQuery(ind, crawlResult.data.name, crawlResult.data.address);
    console.log("[PAID] searchQuery:", finalQuery);

    const scored = scorePlace({
      industry: ind,
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
    const indWord = industryKorean(ind);

    const queryCandidates = uniq(
      [
        finalQuery,
        locality ? `${locality} ${indWord}` : "",
        locality && crawlResult.data.name ? `${locality} ${String(crawlResult.data.name).replace(/\s+/g, " ").trim()}` : ""
      ].filter(Boolean)
    ).slice(0, 3);

    const competitors = await getCompetitorsSafe({
      compSvc,
      industry: ind,
      placeId,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      queries: queryCandidates,
      limit: 5,
      totalTimeoutMs: Number(process.env.COMPETITOR_TIMEOUT_MS || 6000)
    });

    console.log("[PAID] competitors:", competitors.length, "queries:", queryCandidates);

    // ✅ 경쟁사 키워드(평탄화)
    const competitorKeywordsFlat = competitors.flatMap((c: any) => (Array.isArray(c.keywords) ? c.keywords : []));

    // ✅ 트래픽 우선형 대표키워드 5개 확정
    const traffic = buildRecommendedKeywordsTrafficFirst({
      industry: ind,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      competitorKeywordsFlat
    });

    const finalRecommendedKeywords = traffic.recommended;

    // ✅ GPT 컨설팅(대표키워드는 서버가 강제한다)
    const gpt = await generatePaidConsultingGuaranteed({
      industry: ind,
      placeData: crawlResult.data,
      scoredNow: { totalScore: scored.totalScore, totalGrade: scored.totalGrade, scores: scored.scores },
      competitorTopKeywords: competitorKeywordsFlat,
      targetScore: 90
    });

    // ✅ 불일치 방지: improvements.keywords / recommendedKeywords를 서버 확정값으로 강제
    if ((gpt as any)?.improvements) (gpt as any).improvements.keywords = finalRecommendedKeywords;
    (gpt as any).recommendedKeywords = finalRecommendedKeywords;

    // ✅ 서비스키워드는 대표키워드에 넣지 말고, 설명/리뷰요청/메뉴에서 자연삽입하도록 힌트 제공
    const serviceInsertHints = buildServiceInsertHints(ind);

    // ✅ UI 없어도 확인 가능한 디버그
    const competitorKeywordsDebug = competitors.map((c: any) => ({
      placeId: c.placeId,
      name: c.name,
      kwCount: Array.isArray(c.keywords) ? c.keywords.length : 0,
      keywords: Array.isArray(c.keywords) ? c.keywords.slice(0, 10) : []
    }));

    const competitorTopKeywordsDebug = competitorKeywordsFlat.slice(0, 60);

    return res.json({
      success: true,
      data: {
        placeData: crawlResult.data,
        scores: scored.scores,
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: true,

        improvements: (gpt as any).improvements,
        recommendedKeywords: finalRecommendedKeywords,

        competitors,

        // ✅ debug
        competitorKeywordsDebug,
        competitorTopKeywordsDebug,
        keywordStrategyDebug: traffic.debug,
        serviceInsertHints,

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
