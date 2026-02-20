import OpenAI from "openai";
import type { PlaceData } from "../types";
import type { Industry } from "../lib/scoring/types";
import { scorePlace } from "../lib/scoring/engine";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type UnifiedPaidImprovements = {
  description: string;
  directions: string;
  keywords: string[];

  reviewRequestScripts: {
    short: string;
    friendly: string;
    polite: string;
  };

  ownerReplyTemplates: {
    satisfied: string;
    photoEncourage: string;
    repeatCustomer: string;
    complaint: string;
    noShowOrDelay: string;
  };

  photoChecklist: string[];
  competitorKeywordInsights: string;
  priceGuidance?: string;
};

export type GuaranteedConsultingResult = {
  improvements: UnifiedPaidImprovements;
  recommendedKeywords: string[];
  unifiedText: string;
  predicted: {
    totalScore: number;
    totalGrade: string;
    scores: any;
  };
  attempts: number;
};

function normalizeIndustry(v: any): Industry {
  if (v === "hairshop" || v === "cafe" || v === "restaurant") return v;
  return "hairshop";
}

function extractRegionHint(address: string): string {
  const a = (address || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  return a.split(" ").slice(0, 2).join(" ");
}

function buildNearbyLandmarks(industry: Industry, address: string, placeName: string) {
  const a = address || "";
  const defaults =
    industry === "hairshop"
      ? ["서대문역", "광화문", "시청", "서울역", "경복궁", "종로", "명동"]
      : industry === "restaurant"
      ? ["역세권", "주차", "회식", "데이트", "가족모임"]
      : ["역세권", "작업", "콘센트", "조용한", "테이크아웃"];

  const hints: string[] = [];
  for (const k of defaults) if (placeName?.includes(k)) hints.push(k);

  if (/종로/i.test(a)) hints.unshift("광화문", "경복궁", "종로");
  if (/중구/i.test(a)) hints.unshift("시청", "명동", "서울역");
  if (/서대문/i.test(a)) hints.unshift("서대문역", "충정로", "광화문");

  return Array.from(new Set(hints.concat(defaults))).slice(0, 3);
}

function buildConstraints(industry: Industry) {
  const base = {
    keywordsCount: 5,
    descriptionMin: 360,
    descriptionMax: 650,
    directionsMin: 170,
    directionsMax: 420,
    mustIncludeLandmarks: 2
  };

  if (industry === "hairshop") {
    return {
      ...base,
      mustInclude: ["예약", "상담", "시술", "디자이너"],
      pricePolicy:
        "미용실은 '문의' 허용. 단, 글자수 늘리려고 가격/시술을 길게 나열하지 말 것. 주력 2~3개만 짧게 언급 가능."
    };
  }
  if (industry === "restaurant") {
    return {
      ...base,
      mustInclude: ["대표메뉴", "가격", "포장", "주차"],
      pricePolicy: "식당은 대표메뉴 2~3개 가격은 명확히. 대신 과도한 가격 나열 금지."
    };
  }
  return {
    ...base,
    mustInclude: ["시그니처", "좌석", "테이크아웃", "운영시간"],
    pricePolicy: "카페는 시그니처/좌석/작업/콘센트/테이크아웃 등 전환요소 강조. 가격 나열로 글자수 채우지 말 것."
  };
}

function uniq(arr: string[]) {
  return Array.from(new Set(arr.map(s => (s || "").trim()).filter(Boolean)));
}

function ensureCount(arr: string[], n: number) {
  const u = uniq(arr);
  while (u.length < n) u.push(u[u.length - 1] ? `${u[u.length - 1]} 추천` : "지역 추천");
  return u.slice(0, n);
}

function clampText(s: string, max: number): string {
  const t = (s || "").trim();
  if (!t) return "";
  if (t.length > max) return t.slice(0, max).trim();
  return t;
}

function safeStr(v: any) {
  return (typeof v === "string" ? v : "").trim();
}

function buildUnifiedText(
  name: string,
  out: UnifiedPaidImprovements,
  recommendedKeywords: string[],
  predictedScore: number,
  predictedGrade: string
) {
  const lines: string[] = [];
  lines.push(`✅ 유료 컨설팅 결과 (예상 점수: ${predictedScore}점 / ${predictedGrade})`);
  lines.push("");
  lines.push("1) 상세설명 (복사해서 붙여넣기)");
  lines.push(out.description);
  lines.push("");
  lines.push("2) 오시는길 (복사해서 붙여넣기)");
  lines.push(out.directions);
  lines.push("");
  lines.push("3) 대표키워드 5개");
  lines.push(out.keywords.map(k => `- ${k}`).join("\n"));
  lines.push("");
  lines.push("4) 리뷰 요청 문구 (고객용 3종)");
  lines.push(`- 짧게: ${out.reviewRequestScripts.short}`);
  lines.push(`- 친근: ${out.reviewRequestScripts.friendly}`);
  lines.push(`- 정중: ${out.reviewRequestScripts.polite}`);
  lines.push("");
  lines.push("5) 리뷰 답글 템플릿 (매장용 5종)");
  lines.push(`- 만족: ${out.ownerReplyTemplates.satisfied}`);
  lines.push(`- 사진 유도: ${out.ownerReplyTemplates.photoEncourage}`);
  lines.push(`- 재방문/단골: ${out.ownerReplyTemplates.repeatCustomer}`);
  lines.push(`- 불만/클레임: ${out.ownerReplyTemplates.complaint}`);
  lines.push(`- 지각/노쇼: ${out.ownerReplyTemplates.noShowOrDelay}`);
  lines.push("");
  lines.push("6) 사진 업로드 체크리스트");
  lines.push(out.photoChecklist.map(x => `- ${x}`).join("\n"));
  lines.push("");
  lines.push("7) 경쟁사 키워드 인사이트");
  lines.push(out.competitorKeywordInsights);
  lines.push("");
  lines.push("8) 추천 키워드 (추가로 블로그/소식/설명에 활용)");
  lines.push(ensureCount(recommendedKeywords, 10).map(k => `- ${k}`).join("\n"));
  lines.push("");
  lines.push(`(매장명: ${name})`);
  return lines.join("\n");
}

async function callGptJSON(prompt: string): Promise<any> {
  const res = await client.chat.completions.create({
    model: "gpt-4.1-mini",
    temperature: 0.35,
    messages: [
      { role: "system", content: "You output valid JSON only. No markdown. No explanation." },
      { role: "user", content: prompt }
    ]
  });

  const text = res.choices?.[0]?.message?.content?.trim() || "{}";
  try {
    return JSON.parse(text);
  } catch {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return {};
  }
}

export async function generatePaidConsultingGuaranteed(args: {
  industry: Industry;
  placeData: PlaceData;
  scoredNow: { totalScore: number; totalGrade: string; scores: any };
  competitorTopKeywords?: string[];
  targetScore?: number;
}): Promise<GuaranteedConsultingResult> {
  const industry = normalizeIndustry(args.industry);
  const target = typeof args.targetScore === "number" ? args.targetScore : 90;

  const regionHint = extractRegionHint(args.placeData.address || "");
  const nearby = buildNearbyLandmarks(industry, args.placeData.address || "", args.placeData.name || "");
  const constraints = buildConstraints(industry);
  const competitorTop = ensureCount(args.competitorTopKeywords || [], 10);

  let feedback = "";
  let bestSim = {
    totalScore: args.scoredNow.totalScore,
    totalGrade: args.scoredNow.totalGrade,
    scores: args.scoredNow.scores
  };
  let lastRaw: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = `
너는 "네이버 플레이스 최적화" 유료 컨설턴트다.
목표: 사용자가 그대로 붙여넣으면 다시 진단했을 때 종합점수 ${target}점 이상이 되게 만들어라.

[반드시 지켜야 할 정량 기준]
- 대표키워드: 정확히 ${constraints.keywordsCount}개 (중복 금지)
- 상세설명: ${constraints.descriptionMin}~${constraints.descriptionMax}자
- 오시는길: ${constraints.directionsMin}~${constraints.directionsMax}자
- 지역 힌트: "${regionHint}" 문장에 자연스럽게 1회 이상 포함
- 인근 랜드마크: ${nearby.join(", ")} 중 최소 ${constraints.mustIncludeLandmarks}개를 상세설명/오시는길에 자연스럽게 포함
- 반드시 포함 요소: ${constraints.mustInclude.join(", ")}
- 과장/허위(1등/유일/최저가 등) 금지
- ❌ 글자수 채우려고 가격/시술을 길게 나열하지 말 것 (주력 2~3개만 짧게 언급 가능)
- 가격 정책: ${constraints.pricePolicy}

[경쟁사 키워드 참고(빈도 TOP)]
${competitorTop.join(", ")}

[유료 컨설팅 추가 산출물(반드시 포함)]
- reviewRequestScripts: 고객에게 리뷰 요청 문구 3종(짧게/친근/정중)
- ownerReplyTemplates: 매장 답글 템플릿 5종(만족/사진유도/재방문/불만/노쇼-지각)
- photoChecklist: 업로드 체크리스트(대표/내부/시술전후/디자이너/가격표/주차/찾아오는 길)
- competitorKeywordInsights: 경쟁사 키워드에서 뽑은 인사이트(어떻게 녹일지) 5~8줄
- recommendedKeywords: "지역+업종+서비스" 조합 형태의 추천 키워드 10개

[현재 플레이스 데이터]
${JSON.stringify(args.placeData, null, 2)}

[현재 점수(참고)]
${JSON.stringify(args.scoredNow, null, 2)}

[이전 시도 피드백]
${feedback ? feedback : "(없음)"}

[출력 형식]
반드시 JSON만 출력.
{
  "improvements": {
    "description": "string",
    "directions": "string",
    "keywords": ["string","string","string","string","string"],
    "reviewRequestScripts": { "short":"string", "friendly":"string", "polite":"string" },
    "ownerReplyTemplates": { "satisfied":"string", "photoEncourage":"string", "repeatCustomer":"string", "complaint":"string", "noShowOrDelay":"string" },
    "photoChecklist": ["string","..."],
    "competitorKeywordInsights": "string",
    "priceGuidance": "string"
  },
  "recommendedKeywords": ["string","..."]
}
`.trim();

    const raw = await callGptJSON(prompt);
    lastRaw = raw;

    const imp = raw?.improvements || {};
    let description = safeStr(imp.description);
    let directions = safeStr(imp.directions);
    const keywords = ensureCount(Array.isArray(imp.keywords) ? imp.keywords : [], 5);

    // 글자수는 “넘치면 자르기”만 하고, 부족하면 루프에서 다시 생성
    description = clampText(description, constraints.descriptionMax);
    directions = clampText(directions, constraints.directionsMax);

    const reviewRequestScripts = {
      short: safeStr(imp?.reviewRequestScripts?.short) || "만족하셨다면 리뷰 한 줄 부탁드려요 😊",
      friendly:
        safeStr(imp?.reviewRequestScripts?.friendly) ||
        "오늘 스타일 마음에 드셨다면 사진 한 장과 함께 리뷰 남겨주시면 큰 힘이 돼요!",
      polite:
        safeStr(imp?.reviewRequestScripts?.polite) ||
        "방문 감사드립니다. 이용 후기를 리뷰로 남겨주시면 서비스 개선에 큰 도움이 됩니다."
    };

    const ownerReplyTemplates = {
      satisfied:
        safeStr(imp?.ownerReplyTemplates?.satisfied) ||
        "소중한 리뷰 감사합니다! 다음 방문에도 더 만족드릴 수 있도록 준비하겠습니다 😊",
      photoEncourage:
        safeStr(imp?.ownerReplyTemplates?.photoEncourage) ||
        "리뷰 감사합니다! 다음엔 사진도 함께 남겨주시면 다른 고객분들께 큰 도움이 됩니다 😊",
      repeatCustomer:
        safeStr(imp?.ownerReplyTemplates?.repeatCustomer) ||
        "재방문 감사합니다! 다음 예약도 편하게 도와드릴게요. 늘 최선을 다하겠습니다.",
      complaint:
        safeStr(imp?.ownerReplyTemplates?.complaint) ||
        "불편을 드려 죄송합니다. 말씀 주신 부분을 확인 후 개선하겠습니다. 가능하시면 매장으로 연락 주시면 빠르게 도와드릴게요.",
      noShowOrDelay:
        safeStr(imp?.ownerReplyTemplates?.noShowOrDelay) ||
        "일정 변경이 필요하셨다면 미리 연락 주시면 더 원활히 안내드릴 수 있습니다. 다음 예약 때 편하게 조율 도와드릴게요."
    };

    const photoChecklist = uniq(Array.isArray(imp.photoChecklist) ? imp.photoChecklist : []).slice(0, 20);
    const competitorKeywordInsights =
      safeStr(imp.competitorKeywordInsights) ||
      `경쟁사는 '지역+서비스' 조합 키워드를 반복 사용합니다.\n- ${regionHint} + (염색/펌/컷)처럼 검색어를 문장에 자연스럽게 배치\n- 랜드마크(예: ${nearby.join(", ")})를 함께 넣어 생활권 검색을 흡수\n- 예약/상담/디자이너 포인트로 전환 문구 강화`;

    const priceGuidance = safeStr(imp.priceGuidance) || constraints.pricePolicy;
    const recommendedKeywords = ensureCount(Array.isArray(raw.recommendedKeywords) ? raw.recommendedKeywords : [], 10);

    // ✅ 가상 적용 후 재채점(90점 보장 루프)
    const simulated = scorePlace({
      industry,
      name: args.placeData.name,
      address: args.placeData.address,
      description,
      directions,
      keywords,
      reviewCount: args.placeData.reviewCount,
      recentReviewCount30d: (args.placeData as any).recentReviewCount30d,
      photoCount: args.placeData.photoCount,
      menuCount: (args.placeData as any).menuCount,
      menus: (args.placeData as any).menus
    });

    const sim = { totalScore: simulated.totalScore, totalGrade: simulated.totalGrade, scores: simulated.scores };
    if (sim.totalScore > bestSim.totalScore) bestSim = sim;

    const improvements: UnifiedPaidImprovements = {
      description,
      directions,
      keywords,
      reviewRequestScripts,
      ownerReplyTemplates,
      photoChecklist: photoChecklist.length
        ? photoChecklist
        : [
            "대표사진 1장: 시술 결과(가장 자신 있는 스타일)",
            "내부/좌석/조명 3장: 실제 분위기",
            "시술 전/후 6장: 컷/펌/염색 대표 케이스",
            "디자이너/스태프 2장: 신뢰 강화",
            "가격/안내 2장: 대표 시술/예약 안내",
            "찾아오는 길/입구 2장: 건물/간판/층수"
          ],
      competitorKeywordInsights,
      priceGuidance
    };

    const unifiedText = buildUnifiedText(args.placeData.name, improvements, recommendedKeywords, bestSim.totalScore, bestSim.totalGrade);

    if (sim.totalScore >= target) {
      return {
        improvements,
        recommendedKeywords,
        unifiedText,
        predicted: bestSim,
        attempts: attempt
      };
    }

    // 다음 시도 피드백(강제)
    const lacks: string[] = [];
    if (keywords.length !== 5) lacks.push("대표키워드 5개 미충족");
    if (description.length < constraints.descriptionMin) lacks.push(`상세설명 글자수 부족(${description.length}자)`);
    if (directions.length < constraints.directionsMin) lacks.push(`오시는길 글자수 부족(${directions.length}자)`);
    if (regionHint && !description.includes(regionHint) && !directions.includes(regionHint)) lacks.push(`지역 힌트("${regionHint}") 미포함`);
    const lmHit = nearby.filter(x => description.includes(x) || directions.includes(x)).length;
    if (lmHit < constraints.mustIncludeLandmarks) lacks.push(`랜드마크 ${constraints.mustIncludeLandmarks}개 미포함(현재 ${lmHit}개)`);
    for (const w of constraints.mustInclude) if (!description.includes(w) && !directions.includes(w)) lacks.push(`필수 요소 "${w}" 미포함`);

    feedback =
      `목표 ${target}점 미달(예상 ${sim.totalScore}점). 다음 생성에서는 아래를 반드시 보완:\n` +
      (lacks.length ? `- ${lacks.join("\n- ")}\n` : "") +
      `점수 상세: ${JSON.stringify(sim.scores)}`;
  }

  // 3회 실패 시에도 포맷 통일
  const imp = lastRaw?.improvements || {};
  const improvements: UnifiedPaidImprovements = {
    description: clampText(safeStr(imp.description), 650),
    directions: clampText(safeStr(imp.directions), 420),
    keywords: ensureCount(Array.isArray(imp.keywords) ? imp.keywords : [], 5),
    reviewRequestScripts: {
      short: safeStr(imp?.reviewRequestScripts?.short) || "만족하셨다면 리뷰 한 줄 부탁드려요 😊",
      friendly:
        safeStr(imp?.reviewRequestScripts?.friendly) ||
        "오늘 스타일 마음에 드셨다면 사진 한 장과 함께 리뷰 남겨주시면 큰 힘이 돼요!",
      polite:
        safeStr(imp?.reviewRequestScripts?.polite) ||
        "방문 감사드립니다. 이용 후기를 리뷰로 남겨주시면 서비스 개선에 큰 도움이 됩니다."
    },
    ownerReplyTemplates: {
      satisfied:
        safeStr(imp?.ownerReplyTemplates?.satisfied) ||
        "소중한 리뷰 감사합니다! 다음 방문에도 더 만족드릴 수 있도록 준비하겠습니다 😊",
      photoEncourage:
        safeStr(imp?.ownerReplyTemplates?.photoEncourage) ||
        "리뷰 감사합니다! 다음엔 사진도 함께 남겨주시면 다른 고객분들께 큰 도움이 됩니다 😊",
      repeatCustomer:
        safeStr(imp?.ownerReplyTemplates?.repeatCustomer) ||
        "재방문 감사합니다! 다음 예약도 편하게 도와드릴게요. 늘 최선을 다하겠습니다.",
      complaint:
        safeStr(imp?.ownerReplyTemplates?.complaint) ||
        "불편을 드려 죄송합니다. 말씀 주신 부분을 확인 후 개선하겠습니다. 가능하시면 매장으로 연락 주시면 빠르게 도와드릴게요.",
      noShowOrDelay:
        safeStr(imp?.ownerReplyTemplates?.noShowOrDelay) ||
        "일정 변경이 필요하셨다면 미리 연락 주시면 더 원활히 안내드릴 수 있습니다. 다음 예약 때 편하게 조율 도와드릴게요."
    },
    photoChecklist: uniq(Array.isArray(imp.photoChecklist) ? imp.photoChecklist : []).slice(0, 20),
    competitorKeywordInsights: safeStr(imp.competitorKeywordInsights) || "",
    priceGuidance: safeStr(imp.priceGuidance) || ""
  };

  const recommendedKeywords = ensureCount(Array.isArray(lastRaw?.recommendedKeywords) ? lastRaw.recommendedKeywords : [], 10);
  const unifiedText = buildUnifiedText(args.placeData.name, improvements, recommendedKeywords, bestSim.totalScore, bestSim.totalGrade);

  return {
    improvements,
    recommendedKeywords,
    unifiedText,
    predicted: bestSim,
    attempts: 3
  };
}
