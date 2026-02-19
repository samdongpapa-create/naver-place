import express from "express";
import cors from "cors";
import path from "path";
import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";
import { DiagnosisService } from "./services/diagnosis";
import type { Industry } from "./lib/scoring/types";

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
  const crawl = await crawler.crawlPlace(mobileUrl);
  return crawl;
}

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

    // ✅ 여기서 결제검증 붙이면 됨(지금은 단순 isPaid=true)
    const diag = new DiagnosisService();
    const report = diag.generateDiagnosis(crawled.data, true, normalizeIndustry(industry));

    return res.json({
      success: true,
      data: report,
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
