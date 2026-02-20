import express from "express";
import cors from "cors";
import path from "path";
import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";
import type { Industry } from "./lib/scoring/types";
import { scorePlace } from "./lib/scoring/engine";
import { generatePaidConsultingGuaranteed } from "./services/gptConsulting";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ public 폴더 정적 서빙
const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

// ✅ 헬스체크
app.get("/health", (_req, res) => res.status(200).send("ok"));

// ✅ 홈
app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

function normalizeIndustry(v: any): Industry {
  if (v === "cafe" || v === "restaurant" || v === "hairshop") return v;
  return "hairshop";
}

function regionHintFromAddress(address: string) {
  const a = (address || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  // 예: "서울 종로구" 정도까지만
  return a.split(" ").slice(0, 2).join(" ");
}

// ✅ 업종별 “서비스/시술” 핵심 토큰(추천키워드 조합용)
function serviceTokens(industry: Industry) {
  if (industry === "hairshop")
    return ["미용실", "헤어", "커트", "컷", "펌", "염색", "클리닉", "매직", "볼륨매직", "다운펌", "레이어드컷", "단발"];
  if (industry === "restaurant")
    return ["맛집", "식당", "점심", "저녁", "혼밥", "회식", "데이트", "포장", "배달", "예약"];
  return ["카페", "디저트", "브런치", "테이크아웃", "조용한", "작업", "콘센트", "좌석", "커피", "라떼"];
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map(s => (s || "").trim()).filter(Boolean)));
}

function pickRecommendedKeywords5(args: {
  industry: Industry;
  placeName: string;
  address: string;
  currentKeywords: string[];
  competitorTopKeywords: string[];
}) {
  const industry = args.industry;
  const regionHint = regionHintFromAddress(args.address);
  const tokens = serviceTokens(industry);

  // 1) 경쟁사 상위 키워드 중 “우리 업종 토큰”이 포함된 것 우선
  const fromCompetitors = uniq(args.competitorTopKeywords)
    .filter(k => !args.currentKeywords.includes(k))
    .filter(k => tokens.some(t => k.includes(t) || t.includes(k)))
    .slice(0, 3);

  // 2) 네이버 로직 느낌: "지역/역명 + 업종 + 서비스" 조합 2개 만들기
  // (역명은 주소 기반으로 확정 못 하니까, 플레이스명에 "서대문역" 같은게 있으면 그걸 활용)
  const name = args.placeName || "";
  const stationGuess =
    (name.match(/[가-힣]{2,6}역/)?.[0] as string) ||
    (args.currentKeywords.find(k => k.endsWith("역")) as string) ||
    "";

  const regionOrStation = stationGuess || regionHint || "근처";

  const base1 = `${regionOrStation}${industry === "hairshop" ? "미용실" : industry === "restaurant" ? "맛집" : "카페"}`;
  const base2 = `${regionOrStation}${industry === "hairshop" ? "커트" : industry === "restaurant" ? "점심" : "디저트"}`;

  // 3) 부족하면 경쟁사 상위에서 아무거나 채움
  const filler = uniq(args.competitorTopKeywords).filter(k => !args.currentKeywords.includes(k));

  const out = uniq([
    ...fromCompetitors,
    base1,
    base2,
    ...filler
  ])
    .filter(Boolean)
    .slice(0, 5);

  // 최종 5개 보장
  while (out.length < 5) out.push(`${regionOrStation}${tokens[out.length] || "추천"}`);

  return out.slice(0, 5);
}

async function crawl(placeUrl: string) {
  const mobileUrl = convertToMobileUrl(placeUrl);
  const crawler = new ModularCrawler();
  const crawled = await crawler.crawlPlace(mobileUrl);
  return crawled;
}

async function fetchTopCompetitorKeywords(industry: Industry, address: string) {
  const regionHint = regionHintFromAddress(address);
  const query =
    industry === "hairshop" ? `${regionHint} 미용실` :
    industry === "restaurant" ? `${regionHint} 맛집` :
    `${regionHint} 카페`;

  const crawler = new ModularCrawler();
  const competitors = await crawler.searchCompetitorsLite(query, 5);

  const freq = new Map<string, number>();
  for (const c of competitors) {
    for (const k of (c.keywords || [])) {
      const kk = String(k || "").trim();
      if (!kk) continue;
      freq.set(kk, (freq.get(kk) || 0) + 1);
    }
  }

  const competitorTopKeywords = Array.from(freq.entries())
    .sort((a, b) => b[1] - a[1])
    .map(x => x[0])
    .slice(0, 30);

  // ✅ 화면에 그대로 보여줄 "1~5 업체명 : 대표키워드"
  const competitorSummaryLines = competitors.slice(0, 5).map((c, idx) => {
    const kws = (c.keywords || []).slice(0, 5).join(", ");
    return `${idx + 1}. ${c.name} : ${kws || "(키워드 없음)"}`;
  });

  return { competitors, competitorTopKeywords, competitorSummaryLines };
}

// ✅ 무료 진단
app.post("/api/diagnose/free", async (req, res) => {
  try {
    const { placeUrl, industry } = req.body as { placeUrl: string; industry?: Industry };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: "유효한 네이버 플레이스 URL이 아닙니다.",
        logs: []
      });
    }

    const crawled = await crawl(placeUrl);

    if (!crawled.success || !crawled.data) {
      return res.status(500).json({
        success: false,
        message: crawled.error || "크롤링 실패",
        logs: crawled.logs || []
      });
    }

    const ind = normalizeIndustry(industry);

    const scored = scorePlace({
      industry: ind as any,
      name: crawled.data.name,
      address: crawled.data.address,
      description: crawled.data.description,
      directions: crawled.data.directions,
      keywords: crawled.data.keywords,
      reviewCount: crawled.data.reviewCount,
      recentReviewCount30d: (crawled.data as any).recentReviewCount30d,
      photoCount: crawled.data.photoCount,
      menuCount: (crawled.data as any).menuCount,
      menus: (crawled.data as any).menus
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
  } catch (error: any) {
    console.error("free diagnose 오류:", error);
    return res.status(500).json({
      success: false,
      message: "진단 중 오류 발생",
      logs: [String(error?.message || error)]
    });
  }
});

// ✅ 유료 진단(경쟁사 TOP5 보여주기 + 추천키워드 5개 + GPT 컨설팅 + 90점 목표)
app.post("/api/diagnose/paid", async (req, res) => {
  try {
    const { placeUrl, industry } = req.body as { placeUrl: string; industry?: Industry };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: "유효한 네이버 플레이스 URL이 아닙니다.",
        logs: []
      });
    }

    const crawled = await crawl(placeUrl);

    if (!crawled.success || !crawled.data) {
      return res.status(500).json({
        success: false,
        message: crawled.error || "크롤링 실패",
        logs: crawled.logs || []
      });
    }

    const ind = normalizeIndustry(industry);

    // 1) 현재 점수(원본)
    const scoredNow = scorePlace({
      industry: ind as any,
      name: crawled.data.name,
      address: crawled.data.address,
      description: crawled.data.description,
      directions: crawled.data.directions,
      keywords: crawled.data.keywords,
      reviewCount: crawled.data.reviewCount,
      recentReviewCount30d: (crawled.data as any).recentReviewCount30d,
      photoCount: crawled.data.photoCount,
      menuCount: (crawled.data as any).menuCount,
      menus: (crawled.data as any).menus
    });

    // 2) 경쟁사 TOP5 키워드 수집 + “그대로 보여줄” 라인 생성
    const { competitors, competitorTopKeywords, competitorSummaryLines } =
      await fetchTopCompetitorKeywords(ind, crawled.data.address);

    // 3) 경쟁사 + 네이버 로직 기반 "추천 대표키워드 5개"
    const recommendedKeywords5 = pickRecommendedKeywords5({
      industry: ind,
      placeName: crawled.data.name,
      address: crawled.data.address,
      currentKeywords: crawled.data.keywords || [],
      competitorTopKeywords
    });

    // 4) GPT 컨설팅(90점 목표) — 경쟁사 키워드 참고 포함
    const consulting = await generatePaidConsultingGuaranteed({
      industry: ind,
      placeData: crawled.data,
      scoredNow: {
        totalScore: scoredNow.totalScore,
        totalGrade: scoredNow.totalGrade,
        scores: scoredNow.scores
      },
      competitorTopKeywords,
      targetScore: 90
    });

    return res.json({
      success: true,
      data: {
        placeData: crawled.data,
        scores: scoredNow.scores,
        totalScore: scoredNow.totalScore,
        totalGrade: scoredNow.totalGrade,
        isPaid: true,

        // ✅ 1~5 "업체명 : 대표키워드" 그대로 출력용
        competitorSummaryLines, // ["1. ...", "2. ...", ...]
        competitors, // [{name, keywords, placeUrl}, ...]

        // ✅ 추천 대표키워드 5개(서버 생성)
        recommendedKeywords5,

        // ✅ GPT 유료 결과(포맷 통일)
        improvements: consulting.improvements,
        recommendedKeywords: consulting.recommendedKeywords,
        unifiedText: consulting.unifiedText,

        // ✅ 적용하면 예상 점수
        predictedAfterApply: consulting.predicted,
        attempts: consulting.attempts
      },
      logs: crawled.logs || []
    });
  } catch (error: any) {
    console.error("paid diagnose 오류:", error);
    return res.status(500).json({
      success: false,
      message: "유료 진단 중 오류 발생",
      logs: [String(error?.message || error)]
    });
  }
});

// ✅ /api 제외한 나머지는 프론트로
app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) {
    return res.status(404).json({ success: false, message: "Not Found" });
  }
  return res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
