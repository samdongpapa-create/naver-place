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

async function crawl(placeUrl: string) {
  const mobileUrl = convertToMobileUrl(placeUrl);
  const crawler = new ModularCrawler();
  const crawled = await crawler.crawlPlace(mobileUrl);
  return crawled;
}

async function fetchTopCompetitorKeywords(industry: Industry, address: string) {
  const regionHint = (address || "").split(" ").slice(0, 2).join(" ");
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
    .slice(0, 15);

  return { competitors, competitorTopKeywords };
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

// ✅ 유료 진단(경쟁사 TOP5 키워드 + GPT 컨설팅 + 90점 목표)
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

    // 현재 점수(원본)
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

    // 경쟁사 TOP5 키워드
    const { competitors, competitorTopKeywords } = await fetchTopCompetitorKeywords(ind, crawled.data.address);

    // GPT 컨설팅(90점 목표)
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

        // 유료 결과(포맷 통일)
        improvements: consulting.improvements,
        recommendedKeywords: consulting.recommendedKeywords,
        unifiedText: consulting.unifiedText,

        // 적용하면 예상 점수
        predictedAfterApply: consulting.predicted,
        attempts: consulting.attempts,

        // 경쟁사 표시용
        competitors
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
