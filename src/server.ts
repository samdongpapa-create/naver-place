import express from "express";
import cors from "cors";
import path from "path";

import { ModularCrawler } from "./services/modularCrawler";
import { convertToMobileUrl, isValidPlaceUrl } from "./utils/urlHelper";

import type { Industry } from "./lib/scoring/types";
import { scorePlace } from "./lib/scoring/engine";

import { CompetitorService } from "./services/competitorService";
import { UrlConverter } from "./services/modules/urlConverter";
import { generatePaidConsultingByGPT } from "./services/gptConsulting";

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

/** ✅ 추천 키워드 5개 생성 (중복/동의어 정리 + 경쟁사 빈도 + 지역 결합) */
function buildRecommendedKeywords(params: {
  industry: Industry;
  myName: string;
  myAddress: string;
  myKeywords: string[];
  competitorKeywords: string[][];
}): string[] {
  const { industry, myName, myAddress, myKeywords, competitorKeywords } = params;

  // 1) 지역 토큰 (역/구/동/로)
  const locality = (() => {
    const toks: string[] = [];
    const nm = (myName || "").trim();
    const ad = (myAddress || "").trim();

    const m = nm.match(/([가-힣]{2,8})역/);
    if (m?.[1]) toks.push(`${m[1]}역`);

    if (ad) {
      const parts = ad.split(/\s+/).map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (/(구|동|로|길)$/.test(p) && p.length <= 10) toks.push(p);
      }
    }
    const uniq = Array.from(new Set(toks));
    return uniq[0] || ""; // 가장 강한 1개만 우선 사용
  })();

  // 2) 업종별 “서비스 토큰” 후보
  const serviceTokens =
    industry === "hairshop"
      ? ["미용실", "커트", "펌", "염색", "클리닉", "매직", "볼륨매직", "다운펌", "레이어드컷", "단발"]
      : industry === "cafe"
      ? ["카페", "커피", "디저트", "베이커리", "브런치", "케이크", "라떼"]
      : ["맛집", "식당", "점심", "저녁", "가성비", "예약", "포장", "배달"];

  // 3) 동의어/중복 정리 (컷 → 커트 등)
  const normalize = (k: string) => {
    let x = (k || "").replace(/\s+/g, "").trim();
    x = x.replace(/컷$/g, "커트"); // 끝이 컷이면 커트로
    x = x.replace(/헤어샵/g, "미용실");
    return x;
  };

  const seen = new Set<string>();
  const push = (arr: string[], k: string) => {
    const nk = normalize(k);
    if (!nk) return;
    if (nk.length < 3) return;
    if (seen.has(nk)) return;
    seen.add(nk);
    arr.push(nk);
  };

  // 4) 경쟁사 키워드 “빈도” 집계 (핵심)
  const freq = new Map<string, number>();
  for (const list of competitorKeywords) {
    for (const k of list || []) {
      const nk = normalize(k);
      if (!nk) continue;
      freq.set(nk, (freq.get(nk) || 0) + 1);
    }
  }

  // 5) 후보 생성: (지역+서비스) + (경쟁사 상위 빈도) + (내 키워드 보완)
  const out: string[] = [];

  if (locality) {
    // 지역 기반 기본 3개 먼저
    for (const t of serviceTokens) {
      push(out, `${locality}${t}`);
      if (out.length >= 3) break;
    }
  }

  // 경쟁사 빈도 상위에서 2개 보충 (이미 지역형으로 들어갔다면 중복 자동 컷)
  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
  for (const [k] of sorted) {
    push(out, locality ? `${locality}${k.replace(locality, "")}` : k);
    if (out.length >= 5) break;
  }

  // 그래도 5개가 안 차면 내 키워드에서 보충
  for (const k of myKeywords || []) {
    push(out, locality ? `${locality}${k.replace(locality, "")}` : k);
    if (out.length >= 5) break;
  }

  // 최종 5개 보장(부족하면 서비스 토큰으로 채움)
  for (const t of serviceTokens) {
    if (out.length >= 5) break;
    push(out, locality ? `${locality}${t}` : t);
  }

  return out.slice(0, 5);
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
  } catch (error: any) {
    console.error("free diagnose 오류:", error);
    return res.status(500).json({ success: false, message: "진단 중 오류 발생", logs: [String(error?.message || error)] });
  }
});

app.post("/api/diagnose/paid", async (req, res) => {
  try {
    const { placeUrl, industry, searchQuery } = req.body as {
      placeUrl: string;
      industry?: Industry;
      searchQuery?: string;
    };

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({ success: false, message: "유효한 네이버 플레이스 URL이 아닙니다.", logs: [] });
    }
    if (!searchQuery || !searchQuery.trim()) {
      return res.status(400).json({ success: false, message: "경쟁사 분석을 위한 검색어를 입력해주세요.", logs: [] });
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

    // ✅ 로컬 점수(업종별 로직)로 먼저 채점
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

    // ✅ 경쟁사 Top 5 수집
    const compSvc = new CompetitorService();
    const compIds = await compSvc.findTopPlaceIds(searchQuery.trim(), placeId, 5);
    const competitors = await compSvc.crawlCompetitorsByIds(compIds, ind, 5);
    await compSvc.close();

    const competitorSummaryLines = competitors.map((c, i) => {
      const kws = (c.keywords || []).slice(0, 5).join(", ");
      return `${i + 1}. ${c.name} : ${kws || "(키워드 없음)"}`;
    });

    // ✅ 추천 대표키워드 5개 (중복/동의어 제거 + 경쟁사 기반)
    const recommendedKeywords = buildRecommendedKeywords({
      industry: ind,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      myKeywords: crawlResult.data.keywords || [],
      competitorKeywords: competitors.map(c => c.keywords || [])
    });

    // ✅ GPT로 유료 개선안 생성 (추천키워드/경쟁사 요약을 함께 전달)
    const gpt = await generatePaidConsultingByGPT({
      industry: ind as any,
      placeData: crawlResult.data,
      scores: scored.scores as any,
      totalScore: scored.totalScore,
      totalGrade: scored.totalGrade,
      competitorSummaryLines,
      recommendedKeywords
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
        recommendedKeywords: gpt.recommendedKeywords || recommendedKeywords,

        competitors,
        competitorSummaryLines
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
  }
});

app.get("*", (req, res) => {
  if (req.path.startsWith("/api")) return res.status(404).json({ success: false, message: "Not Found" });
  return res.sendFile(path.join(publicDir, "index.html"));
});

app.listen(port, () => console.log(`🚀 Server running on port ${port}`));
