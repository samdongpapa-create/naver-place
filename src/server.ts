import express from "express";
import cors from "cors";
import path from "path";

import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";

import type { Industry } from "./lib/scoring/types";
import { scorePlace } from "./lib/scoring/engine";

import { CompetitorService } from "./services/competitorService";
import { UrlConverter } from "./services/modules/urlConverter";

// ✅ gptConsulting.ts에서 export되는 함수명으로 import
import { generatePaidConsultingGuaranteed } from "./services/gptConsulting";

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/health", (_req, res) => res.status(200).send("ok"));
app.get("/", (_req, res) => res.sendFile(path.join(publicDir, "index.html")));

function normalizeIndustry(v: any): Industry {
  if (v === "cafe" || v === "restaurant" || v === "hairshop") return v;
  return "hairshop";
}

async function crawl(placeUrl: string) {
  const mobileUrl = convertToMobileUrl(placeUrl);
  const crawler = new ModularCrawler();
  return await crawler.crawlPlace(mobileUrl);
}

/** ✅ 추천 키워드 5개 생성 (경쟁사 빈도 + 지역 결합) */
function buildRecommendedKeywords(params: {
  industry: Industry;
  myName: string;
  myAddress: string;
  myKeywords: string[];
  competitorKeywords: string[][];
}): string[] {
  const { industry, myName, myAddress, myKeywords, competitorKeywords } = params;

  const serviceTokens =
    industry === "hairshop"
      ? ["미용실", "커트", "펌", "염색", "클리닉", "다운펌", "볼륨매직", "레이어드컷", "단발", "남자펌"]
      : industry === "cafe"
      ? ["카페", "커피", "디저트", "베이커리", "브런치", "케이크", "라떼", "테이크아웃"]
      : ["맛집", "식당", "점심", "저녁", "예약", "포장", "배달", "회식", "데이트"];

  const locality = (() => {
    const toks: string[] = [];
    const nm = (myName || "").trim();
    const ad = (myAddress || "").trim();

    const m = nm.match(/([가-힣]{2,10})역/);
    if (m?.[1]) toks.push(`${m[1]}역`);

    if (ad) {
      const parts = ad.split(/\s+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (/(역|구|동|로|길)$/.test(p) && p.length <= 10) toks.push(p);
      }
    }

    const uniq = Array.from(new Set(toks));
    return uniq[0] || "";
  })();

  const normalize = (k: string) => {
    let x = (k || "").replace(/\s+/g, "").trim();
    if (!x) return "";
    x = x.replace(/헤어샵/g, "미용실");
    x = x.replace(/컷$/g, "커트");
    x = x.replace(/컷/gi, "커트");
    x = x.replace(/[^\w가-힣]/g, "");
    return x;
  };

  const stop = new Set<string>(["추천", "인기", "잘하는곳", "잘하는집", "최고", "1등", "베스트", "가격", "할인", "예약"]);

  const seen = new Set<string>();
  const out: string[] = [];

  const push = (k: string) => {
    const nk = normalize(k);
    if (!nk) return;
    if (nk.length < 3) return;
    if (stop.has(nk)) return;
    if (seen.has(nk)) return;
    seen.add(nk);
    out.push(nk);
  };

  const freq = new Map<string, number>();
  for (const list of competitorKeywords || []) {
    for (const k of list || []) {
      const nk = normalize(k);
      if (!nk) continue;
      if (stop.has(nk)) continue;
      freq.set(nk, (freq.get(nk) || 0) + 1);
    }
  }

  // 1) 지역+서비스 3개
  if (locality) {
    for (const t of serviceTokens) {
      push(`${locality}${t}`);
      if (out.length >= 3) break;
    }
  }

  // 2) 경쟁사 빈도 상위로 보충
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
  for (const [k] of sorted) {
    if (out.length >= 5) break;
    if (locality && !k.startsWith(locality)) push(`${locality}${k.replace(locality, "")}`);
    else push(k);
  }

  // 3) 내 키워드로 보충
  for (const k of myKeywords || []) {
    if (out.length >= 5) break;
    if (locality) push(`${locality}${normalize(k).replace(locality, "")}`);
    else push(k);
  }

  // 4) 그래도 부족하면 서비스 토큰
  for (const t of serviceTokens) {
    if (out.length >= 5) break;
    push(locality ? `${locality}${t}` : t);
  }

  return out.slice(0, 5);
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
  let compSvc: CompetitorService | null = null;

  try {
    const { placeUrl, industry, searchQuery } = req.body as {
      placeUrl: string;
      industry?: Industry;
      searchQuery?: string;
    };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: "유효한 네이버 플레이스 URL이 아닙니다.",
        logs: []
      });
    }

    if (!searchQuery || !searchQuery.trim()) {
      return res.status(400).json({
        success: false,
        message: "경쟁사 분석을 위한 검색어를 입력해주세요.",
        logs: []
      });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);
    const placeId = UrlConverter.extractPlaceId(mobileUrl) || "";

    const crawler = new ModularCrawler();
    const crawlResult = await crawler.crawlPlace(mobileUrl);

    if (!crawlResult.success || !crawlResult.data) {
      return res.status(500).json({
        success: false,
        message: crawlResult.error || "크롤링 실패",
        logs: crawlResult.logs || []
      });
    }

    const ind = normalizeIndustry(industry);

    // 1) 현재 상태 점수
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

    // 2) 경쟁사 Top5
    compSvc = new CompetitorService();
    const compIds = await compSvc.findTopPlaceIds(searchQuery.trim(), placeId, 5);
    const competitors = await compSvc.crawlCompetitorsByIds(compIds, ind, 5);

    // 3) 추천 대표키워드 5개(로컬)
    const recommendedKeywordsLocal = buildRecommendedKeywords({
      industry: ind,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      myKeywords: crawlResult.data.keywords || [],
      competitorKeywords: competitors.map(c => c.keywords || [])
    });

    // 4) GPT 유료 컨설팅
    const gpt = await generatePaidConsultingGuaranteed({
      industry: ind,
      placeData: crawlResult.data,
      scoredNow: {
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        scores: scored.scores
      },
      competitorTopKeywords: competitors.flatMap(c => c.keywords || []),
      targetScore: 90
    });

    return res.json({
      success: true,
      data: {
        placeData: crawlResult.data,

        scores: scored.scores,
        totalScore: scored.totalScore,
        totalGrade: scored.totalGrade,
        isPaid: true,

        improvements: gpt.improvements,

        // ✅ 불일치 방지: gpt.recommendedKeywords가 있으면 그걸 우선, 없으면 로컬
        recommendedKeywords:
          gpt.recommendedKeywords && gpt.recommendedKeywords.length
            ? gpt.recommendedKeywords
            : recommendedKeywordsLocal,

        competitors,

        predictedAfter: gpt.predicted,
        attempts: gpt.attempts,

        unifiedText: gpt.unifiedText
      },
      logs: crawlResult.logs || []
    });
  } catch (error: any) {
    console.error("paid diagnose 오류:", error);
    return res.status(500).json({
      success: false,
      message: "유료 진단 중 오류 발생",
      logs: [String(error?.message || error)]
    });
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
