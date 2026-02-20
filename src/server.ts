import express from "express";
import path from "path";
import { modularCrawler } from "./services/modularCrawler";
import { DiagnosisService } from "./services/diagnosis";
import { GptConsultingService } from "./services/gptConsulting";
import { CompetitorService } from "./services/competitorService";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));

// static
app.use(express.static(path.join(process.cwd(), "public")));

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

/**
 * Main analyze endpoint
 * - mode: place_url
 * - plan: free/paid
 */
app.post("/api/analyze", async (req, res) => {
  try {
    const { placeUrl, plan = "free" } = req.body || {};
    if (!placeUrl || typeof placeUrl !== "string") {
      return res.status(400).json({ ok: false, error: "placeUrl is required" });
    }

    // 1) Crawl
    const crawl = await modularCrawler(placeUrl);

    // 2) Competitors (best effort)
    // Query string: placeName + area keyword
    const areaHint = (crawl.address || "").split(" ").slice(0, 2).join(" ");
    const compQuery = `${crawl.name || ""} ${areaHint}`.trim();

    let competitors: any[] = [];
    try {
      if (compQuery.length >= 2) {
        competitors = await CompetitorService.getCompetitors(compQuery, 5);
      }
    } catch {
      competitors = [];
    }

    // 3) Diagnosis (scoring/priority)
    const diagnosis = DiagnosisService.run({
      name: crawl.name,
      description: crawl.description,
      directions: crawl.directions,
      keywords: crawl.keywords,
      reviewsTotal: crawl.reviewsTotal,
      recent30d: crawl.recent30d,
      photoCount: crawl.photoCount,
    });

    // 4) GPT Consulting (대표키워드 5개 + 상세설명/오시는길)
    // ✅ recommendedKeywords5 를 "단일 소스"로 응답 통일
    let gpt: any = null;
    try {
      gpt = await GptConsultingService.run({
        placeName: crawl.name || "업체",
        category: crawl.category,
        address: crawl.address,
        currentKeywords: crawl.keywords || [],
        description: crawl.description,
        directions: crawl.directions,
        reviewsTotal: crawl.reviewsTotal,
        recent30d: crawl.recent30d,
        photoCount: crawl.photoCount,
        competitorNames: (competitors || []).map((c: any) => c?.name).filter(Boolean),
      });
    } catch {
      gpt = null;
    }

    // plan에 따라 통합본 제공(유료)
    const paidBundle =
      plan === "paid" && gpt
        ? {
            unifiedText: gpt.unifiedText,
          }
        : null;

    return res.json({
      ok: true,
      meta: crawl.meta,
      place: {
        name: crawl.name,
        placeId: crawl.placeId,
        placeUrl: crawl.placeUrl,
        category: crawl.category,
        address: crawl.address,
      },
      extracted: {
        keywords: crawl.keywords || [],
        description: crawl.description || "",
        directions: crawl.directions || "",
        reviewsTotal: crawl.reviewsTotal || 0,
        recent30d: crawl.recent30d || 0,
        photoCount: crawl.photoCount || 0,
      },
      diagnosis,
      competitors,
      // ✅ 프론트에서 이거만 쓰면 됨 (대표키워드 5개 단일 소스)
      recommendations: gpt
        ? {
            recommendedKeywords5: gpt.recommendedKeywords5,
            improvedDescription: gpt.improvedDescription,
            improvedDirections: gpt.improvedDirections,
          }
        : null,
      paid: paidBundle,
    });
  } catch (e: any) {
    return res.status(500).json({
      ok: false,
      error: e?.message || "unknown error",
    });
  }
});

// fallback
app.get("*", (_req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "index.html"));
});

const port = process.env.PORT ? Number(process.env.PORT) : 3000;
app.listen(port, () => {
  console.log(`[server] listening on ${port}`);
});
