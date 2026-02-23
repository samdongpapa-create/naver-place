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

// ✅ 누락되어 TS 에러났던 유틸
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

function buildRecommendedKeywordsLocal(params: {
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
      const parts = ad.split(/\s+/).map((s) => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (/(역|구|동)$/.test(p) && p.length <= 10) toks.push(p);
      }
    }
    return Array.from(new Set(toks))[0] || "";
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

  if (locality) {
    for (const t of serviceTokens.slice(0, 4)) {
      push(`${locality}${t}`);
      if (out.length >= 3) break;
    }
  }

  const sorted = Array.from(freq.entries()).sort((a, b) => b[1] - a[1]);
  for (const [k] of sorted) {
    if (out.length >= 5) break;
    if (locality && !k.startsWith(locality)) push(`${locality}${k.replace(locality, "")}`);
    else push(k);
  }

  for (const k of myKeywords || []) {
    if (out.length >= 5) break;
    push(locality ? `${locality}${normalize(k).replace(locality, "")}` : k);
  }

  for (const t of serviceTokens) {
    if (out.length >= 5) break;
    push(locality ? `${locality}${t}` : t);
  }

  return out.slice(0, 5);
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
  queries: string[];
  limit: number;
  totalTimeoutMs: number;
}) {
  const { compSvc, industry, placeId, queries, limit, totalTimeoutMs } = params;

  const started = Date.now();
  const competitors: any[] = [];

  for (const q of queries) {
    const remainingMs = totalTimeoutMs - (Date.now() - started);
    if (remainingMs <= 200) break;

    try {
      console.log("[PAID][COMP] try query:", q, "remainingMs:", remainingMs);

      const ids = await withTimeout(compSvc.findTopPlaceIds(q, placeId, limit), Math.min(2500, remainingMs), "compIds-timeout");
      if (!ids?.length) continue;

      const comps = await withTimeout(
        compSvc.crawlCompetitorsByIds(ids, industry, limit),
        Math.min(3500, remainingMs),
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
    const indWord = ind === "hairshop" ? "미용실" : ind === "cafe" ? "카페" : "맛집";

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
      queries: queryCandidates,
      limit: 5,
      totalTimeoutMs: Number(process.env.COMPETITOR_TIMEOUT_MS || 6000)
    });

    console.log("[PAID] competitors:", competitors.length, "queries:", queryCandidates);

    const localKw = buildRecommendedKeywordsLocal({
      industry: ind,
      myName: crawlResult.data.name,
      myAddress: crawlResult.data.address,
      myKeywords: crawlResult.data.keywords || [],
      competitorKeywords: competitors.map((c: any) => c.keywords || [])
    });

    const gpt = await generatePaidConsultingGuaranteed({
      industry: ind,
      placeData: crawlResult.data,
      scoredNow: { totalScore: scored.totalScore, totalGrade: scored.totalGrade, scores: scored.scores },
      competitorTopKeywords: competitors.flatMap((c: any) => c.keywords || []),
      targetScore: 90
    });

    const gptKw = Array.isArray((gpt as any)?.improvements?.keywords) ? (gpt as any).improvements.keywords.slice(0, 5) : [];
    const gptRec = Array.isArray((gpt as any)?.recommendedKeywords) ? (gpt as any).recommendedKeywords.slice(0, 5) : [];

    const recommendedKeywords = (gptKw.length ? gptKw : gptRec.length ? gptRec : localKw).slice(0, 5);
    while (recommendedKeywords.length < 5) recommendedKeywords.push(...localKw);
    const finalRecommendedKeywords = uniq(recommendedKeywords).slice(0, 5);

    if ((gpt as any)?.improvements) (gpt as any).improvements.keywords = finalRecommendedKeywords;
    (gpt as any).recommendedKeywords = finalRecommendedKeywords;

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
