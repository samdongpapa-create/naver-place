import express from "express";
import cors from "cors";
import path from "path";
import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";
import { DiagnosisService } from "./services/diagnosis";
import type { Industry } from "./lib/scoring/types";
import { scorePlace } from "./lib/scoring/engine";
import { generatePaidConsultingByGPT } from "./services/gptConsulting";

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
  return crawler.crawlPlace(mobileUrl);
}

/**
 * ✅ FREE: 점수/등급/이슈만 (GPT 없음)
 */
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

    const diag = new DiagnosisService();
    // ✅ free는 개선안 생성 X
    const report = diag.generateDiagnosis(crawled.data, false, normalizeIndustry(industry));

    return res.json({
      success: true,
      data: report,
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

/**
 * ✅ PAID: 점수/등급 + GPT로 “바로 붙여넣기 개선안” 생성
 * - 유료만 GPT 호출 (수정방향 생성은 유료에서만)
 */
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

    // ✅ 업종별 스코어링(새 로직)
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

    // ✅ GPT로 유료 컨설팅 생성
    const gpt = await generatePaidConsultingByGPT({
      industry: ind as any,
      placeData: crawled.data,
      scores: scored.scores as any,
      totalScore: scored.totalScore,
      totalGrade: scored.totalGrade
    });

    return res.json({
      success: true,
      data: {
        placeData: crawled.data,
        scores: scored.scores,
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: true,
        improvements: gpt.improvements,
        recommendedKeywords: gpt.recommendedKeywords || null,
        competitors: null
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
