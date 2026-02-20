// src/services/gptConsulting.ts
import OpenAI from "openai";
import type { PlaceData } from "../types";
import type { Industry } from "../lib/scoring/types";
import { scorePlace } from "../lib/scoring/engine";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type UnifiedPaidImprovements = {
  description: string;
  directions: string;
  keywords: string[];

  // ✅ 고객에게 요청하는 리뷰 문구(네이버 노출형)
  reviewRequestScripts: {
    short: string;
    friendly: string;
    polite: string;
  };

  // ✅ 매장 답글 템플릿(네이버 노출/신뢰형)
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

// ✅ server.ts에서 쓰던 이름도 같이 export (호환용)
export async function generatePaidConsultingByGPT(args: {
  industry: Industry;
  placeData: PlaceData;
  scoredNow: { totalScore: number; totalGrade: string; scores: any };
  competitorTopKeywords?: string[];
  targetScore?: number;
}): Promise<GuaranteedConsultingResult> {
  return generatePaidConsultingGuaranteed(args);
}

function normalizeIndustry(v: any): Industry {
  if (v === "hairshop" || v === "cafe" || v === "restaurant") return v;
  return "hairshop";
}

function safeStr(v: any) {
  return (typeof v === "string" ? v : "").trim();
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
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

function extractRegionHint(address: string): string {
  const a = (address || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  // "서울 종로구" 정도까지만
  return a.split(" ").slice(0, 2).join(" ");
}

// ✅ 역/동네 키워드 자동 추정(없어도 안전)
function inferStation(placeName: string, address: string): string {
  const name = (placeName || "").replace(/\s+/g, " ").trim();
  const addr = (address || "").replace(/\s+/g, " ").trim();

  // "서대문역", "강남역" 같은 패턴 찾기
  const m1 = name.match(/([가-힣A-Za-z0-9]{1,10}역)/);
  if (m1?.[1]) return m1[1];

  const m2 = addr.match(/([가-힣A-Za-z0-9]{1,10}역)/);
  if (m2?.[1]) return m2[1];

  // 서대문/종로/중구 등 휴리스틱
  if (/서대문/.test(name) || /서대문/.test(addr)) return "서대문역";
  if (/종로/.test(addr)) return "광화문";
  if (/중구/.test(addr)) return "시청";

  return "근처";
}

function industryKorean(industry: Industry): string {
  if (industry === "hairshop") return "미용실";
  if (industry === "restaurant") return "맛집";
  return "카페";
}

function serviceHint(industry: Industry, placeData: PlaceData): string {
  // 대표키워드/메뉴에서 힌트 우선
  const kws = Array.isArray(placeData.keywords) ? placeData.keywords : [];
  const menuNames =
    Array.isArray((placeData as any).menus) ? (placeData as any).menus.map((m: any) => String(m?.name || "")) : [];

  const pool = [...kws, ...menuNames].map(s => s.trim()).filter(Boolean).join(" ");

  if (industry === "hairshop") {
    if (/커트|컷/.test(pool)) return "커트";
    if (/펌|볼륨매직|매직|다운펌/.test(pool)) return "펌";
    if (/염색|컬러|아베다/.test(pool)) return "염색";
    return "커트";
  }
  if (industry === "restaurant") {
    if (/포장|배달/.test(pool)) return "포장";
    if (/점심|런치/.test(pool)) return "점심";
    return "대표메뉴";
  }
  // cafe
  if (/테이크아웃/.test(pool)) return "테이크아웃";
  if (/디저트/.test(pool)) return "디저트";
  return "시그니처";
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

// ✅ 추천 키워드 품질 개선(중복/파생 난사 방지)
function buildBetterKeywords(args: {
  industry: Industry;
  placeName: string;
  address: string;
  station: string;
  landmarks: string[];
  competitorTopKeywords: string[];
}): { five: string[]; ten: string[] } {
  const { industry, station, landmarks, competitorTopKeywords } = args;

  const region2 = extractRegionHint(args.address);
  const indK = industryKorean(industry);

  // 서비스 후보(업종별)
  const serviceCandidates =
    industry === "hairshop"
      ? ["커트", "펌", "염색", "다운펌", "볼륨매직", "클리닉", "매직"]
      : industry === "restaurant"
      ? ["맛집", "점심", "저녁", "포장", "회식", "데이트", "가족모임"]
      : ["카페", "디저트", "브런치", "테이크아웃", "작업", "조용한", "시그니처"];

  const landmarkOne = landmarks?.[0] || "";
  const landmarkTwo = landmarks?.[1] || "";
  const baseArea = station && station !== "근처" ? station : region2 || landmarkOne || "";

  const preferComp = uniq(competitorTopKeywords || [])
    .filter(k => k.length >= 2 && k.length <= 14)
    .filter(k => !/커트커트|펌펌|컷컷/.test(k))
    .slice(0, 12);

  const cand: string[] = [];

  // 1) 지역+업종(핵심)
  if (baseArea) cand.push(`${baseArea}${indK}`);
  if (baseArea && industry === "hairshop") cand.push(`${baseArea}미용실`);

  // 2) 지역+서비스
  for (const s of serviceCandidates.slice(0, 3)) {
    if (!baseArea) continue;
    cand.push(`${baseArea}${s}`);
  }

  // 3) 랜드마크 조합(최대 2개)
  if (landmarkOne) cand.push(`${landmarkOne}${indK}`);
  if (landmarkTwo && landmarkTwo !== landmarkOne) cand.push(`${landmarkTwo}${indK}`);

  // 4) 경쟁사 상위 키워드 일부 흡수(너무 길거나 이상한건 제외)
  cand.push(...preferComp);

  const five = ensureCount(cand, 5);

  // ten은 기존 시그니처 유지용(현재 프로젝트에서는 UI/통합본에서 사용하지 않음)
  const ten = ensureCount([...five, ...preferComp], 10);

  return { five, ten };
}

// (중간 템플릿/로직들은 원본 그대로 — 길어서 생략 없이 그대로 유지됩니다)
function buildReviewBundle(industry: Industry, placeName: string, station: string, landmarks: string[]) {
  const indK = industryKorean(industry);
  const lm = landmarks?.[0] ? landmarks[0] : station;

  const short = [`${placeName} 방문 후`, "후기 한 줄만 남겨주시면 큰 힘이 됩니다 🙏", "사진 1장도 함께 부탁드려요!"].join(" ");
  const friendly = [
    `${placeName} (${lm} 근처 ${indK}) 이용하셨다면`,
    "리뷰로 느낌을 남겨주시면 다음 고객분들께 도움이 돼요 😊",
    "가능하면 사진 1~2장도 부탁드릴게요!"
  ].join(" ");
  const polite = [
    `${placeName}를 이용해 주셔서 감사합니다.`,
    "방문 후기(리뷰)를 남겨주시면 서비스 개선에 큰 도움이 됩니다.",
    "사진 첨부도 가능하시면 함께 부탁드립니다."
  ].join(" ");

  const satisfied = [
    "소중한 리뷰 감사합니다 😊",
    "다음 방문에도 만족하실 수 있도록 더 꼼꼼히 준비하겠습니다.",
    "예약/상담 필요하시면 언제든 편하게 문의 주세요!"
  ].join(" ");

  const photoEncourage = [
    "리뷰 감사합니다 🙏",
    "혹시 가능하시다면 다음에는 사진도 함께 남겨주시면",
    "스타일 참고에 큰 도움이 됩니다!"
  ].join(" ");

  const repeatCustomer = [
    "재방문 정말 감사합니다 😊",
    "항상 같은 퀄리티로 만족드릴 수 있도록 노력하겠습니다.",
    "다음에도 편하게 예약 주시면 꼼꼼히 도와드릴게요!"
  ].join(" ");

  const complaint = [
    "불편을 드려 죄송합니다.",
    "말씀 주신 부분은 꼼꼼히 확인해 개선하겠습니다.",
    "가능하시다면 자세한 상황을 메시지/전화로 알려주시면 빠르게 도와드리겠습니다."
  ].join(" ");

  const noShowOrDelay = [
    "안내드립니다 🙏",
    "일정 변경이 필요하실 때 미리 연락 주시면 더 원활히 도와드릴 수 있습니다.",
    "다음 예약 때도 편하게 일정 조율 도와드릴게요."
  ].join(" ");

  return {
    reviewRequestScripts: { short, friendly, polite },
    ownerReplyTemplates: { satisfied, photoEncourage, repeatCustomer, complaint, noShowOrDelay }
  };
}

function buildUnifiedText(
  name: string,
  out: UnifiedPaidImprovements,
  _recommendedKeywords: string[],
  predictedScore: number,
  predictedGrade: string
) {
  const lines: string[] = [];
  lines.push(`✅ 유료 컨설팅 결과 (예상 점수: ${predictedScore}점 / ${predictedGrade})`);
  lines.push("");

  lines.push("1) 상세설명 (복사해서 붙여넣기)");
  lines.push(out.description || "(생성 실패)");
  lines.push("");

  lines.push("2) 오시는길 (복사해서 붙여넣기)");
  lines.push(out.directions || "(생성 실패)");
  lines.push("");

  lines.push("3) 대표키워드 5개");
  lines.push(out.keywords?.length ? out.keywords.map(k => `- ${k}`).join("\n") : "- (생성 실패)");
  lines.push("");

  lines.push("4) 고객 리뷰 요청 문구 (복사해서 보내기 / 3종)");
  lines.push(`- 짧게: ${out.reviewRequestScripts?.short || "(없음)"}`);
  lines.push(`- 친근: ${out.reviewRequestScripts?.friendly || "(없음)"}`);
  lines.push(`- 정중: ${out.reviewRequestScripts?.polite || "(없음)"}`);
  lines.push("");

  lines.push("5) 매장 답글 템플릿 (상황별 5종)");
  lines.push(`- 만족: ${out.ownerReplyTemplates?.satisfied || "(없음)"}`);
  lines.push(`- 사진 유도: ${out.ownerReplyTemplates?.photoEncourage || "(없음)"}`);
  lines.push(`- 재방문/단골: ${out.ownerReplyTemplates?.repeatCustomer || "(없음)"}`);
  lines.push(`- 불만/클레임: ${out.ownerReplyTemplates?.complaint || "(없음)"}`);
  lines.push(`- 지각/노쇼: ${out.ownerReplyTemplates?.noShowOrDelay || "(없음)"}`);
  lines.push("");

  lines.push("6) 사진 업로드 체크리스트");
  lines.push(out.photoChecklist?.length ? out.photoChecklist.map(x => `- ${x}`).join("\n") : "- (없음)");
  lines.push("");

  lines.push("7) 가격/메뉴 개선 가이드");
  lines.push(out.priceGuidance || "(없음)");
  lines.push("");

  lines.push("8) 경쟁사 키워드 인사이트");
  lines.push(out.competitorKeywordInsights || "(없음)");
  lines.push("");

  lines.push(`(매장명: ${name})`);
  return lines.join("\n");
}

async function callGptJSON(prompt: string): Promise<any> {
  const hasKey = Boolean(process.env.OPENAI_API_KEY);
  const model = process.env.OPENAI_MODEL || "gpt-4.1-mini";

  console.log("[GPT] callGptJSON start. hasKey=", hasKey, "model=", model);

  const res = await client.chat.completions.create({
    model,
    temperature: 0.35,
    messages: [
      { role: "system", content: "You output valid JSON only. No markdown. No explanation." },
      { role: "user", content: prompt }
    ]
  });

  const text = res.choices?.[0]?.message?.content?.trim() || "{}";
  console.log("[GPT] raw response (head 500):", text.slice(0, 500));

  try {
    const parsed = JSON.parse(text);
    console.log("[GPT] JSON.parse OK");
    return parsed;
  } catch {
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        const parsed = JSON.parse(m[0]);
        console.log("[GPT] JSON.parse OK (regex extracted)");
        return parsed;
      } catch {}
    }
    console.log("[GPT] JSON.parse FAIL -> returning {}");
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
  const constraints = buildConstraints(industry);

  const regionHint = extractRegionHint(args.placeData.address);
  const station = inferStation(args.placeData.name, args.placeData.address);
  const nearby = buildNearbyLandmarks(industry, args.placeData.address, args.placeData.name);
  const service = serviceHint(industry, args.placeData);

  const competitorTop = Array.isArray(args.competitorTopKeywords) ? args.competitorTopKeywords : [];
  const better = buildBetterKeywords({
    industry,
    placeName: args.placeData.name,
    address: args.placeData.address,
    station,
    landmarks: nearby,
    competitorTopKeywords: competitorTop
  });

  const reviewBundle = buildReviewBundle(industry, args.placeData.name, station, nearby);

  const target = clamp(args.targetScore ?? 90, 70, 98);

  let bestSim = args.scoredNow;
  let feedback = "";
  let lastRaw: any = null;

  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = `
[역할]
너는 네이버 플레이스 상위노출(검색 유입)과 전환(예약/문의)을 동시에 올리는 컨설팅 전문가다.

[목표]
- 상세설명: ${constraints.descriptionMin}~${constraints.descriptionMax}자
- 오시는길: ${constraints.directionsMin}~${constraints.directionsMax}자
- 대표키워드: 5개 (키워드 도배 금지, 자연스럽게 1~2회만 녹여쓰기)
- 지역 힌트: "${regionHint}"를 자연스럽게 포함
- 랜드마크: 최소 ${constraints.mustIncludeLandmarks}개 포함 (예: ${nearby.join(", ")})

[주의]
- ${constraints.mustInclude.join(", ")} 중 일부를 자연스럽게 포함
- ❌ 글자수 채우려고 가격/시술을 길게 나열하지 말 것 (주력 2~3개만 짧게 언급 가능)
- 가격 정책: ${constraints.pricePolicy}

[경쟁사 키워드 참고(빈도 TOP)]
${competitorTop.join(", ")}

[중요: 리뷰/답글은 이미 로직 템플릿으로 생성됨]
- GPT는 description/directions/keywords5/competitorKeywordInsights/priceGuidance만 보강해도 됨

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
    "keywords5": ["string","string","string","string","string"],
    "competitorKeywordInsights": "string",
    "priceGuidance": "string"
  }
}
`.trim();

    const raw = await callGptJSON(prompt);
    lastRaw = raw;

    const imp = raw?.improvements || {};

    let description = safeStr(imp.description);
    let directions = safeStr(imp.directions);

    if (!description) {
      description = `${args.placeData.name}은(는) ${regionHint}에 위치한 ${industryKorean(industry)}입니다. ${nearby
        .slice(0, 2)
        .join(", ")} 생활권에서 방문하기 편하고, 예약 후 1:1 상담으로 ${service} 등 시술을 진행합니다. 디자이너가 두상/모질/손질 습관을 고려해 과한 손상 없이 유지가 쉬운 스타일을 제안합니다.`;
    }
    if (!directions) {
      directions = `${regionHint} ${args.placeData.address}에 위치해 있습니다. ${station !== "근처" ? `${station} 기준` : "주변"}으로 도보 이동이 가능하며, 건물 입구/층수는 지도와 사진을 함께 확인하시면 더 빠릅니다. 예약은 네이버 예약을 권장드리며, 방문 전 상담 요청 시 더 정확한 안내가 가능합니다.`;
    }

    description = clampText(description, constraints.descriptionMax);
    directions = clampText(directions, constraints.directionsMax);

    const competitorKeywordInsights =
      safeStr(imp.competitorKeywordInsights) ||
      `경쟁사는 '지역+서비스' 조합을 반복적으로 사용합니다.\n- ${regionHint} + (${service})처럼 생활권 검색어를 문장에 자연스럽게 배치\n- 랜드마크(예: ${nearby.join(", ")})를 1~2개 포함해 주변 검색 유입 흡수\n- 예약/상담/디자이너 포인트를 넣어 전환 문구 강화\n- 키워드는 도배하지 말고 1~2회만 자연스럽게`;

    const priceGuidance = safeStr(imp.priceGuidance) || constraints.pricePolicy;

    // ✅ 대표키워드: GPT가 주면 우선 적용하되, 품질 검증 후 실패 시 로컬 생성으로 폴백
    let keywords = better.five;
    const gptKwRaw = (imp as any)?.keywords5;

    if (Array.isArray(gptKwRaw)) {
      const cleaned = uniq(gptKwRaw.map((x: any) => String(x || "").trim()))
        .filter(k => k.length >= 2 && k.length <= 18)
        .filter(k => !/추천$/.test(k));

      if (cleaned.length >= 5) {
        keywords = cleaned.slice(0, 5);
        console.log("[GPT] keywords5 적용:", keywords);
      } else {
        console.log("[GPT] keywords5 부족/품질불량 -> local fallback 사용. got=", cleaned);
      }
    } else {
      console.log("[GPT] keywords5 없음 -> local fallback 사용");
    }

    // ✅ UI/통합본 불일치 방지: recommendedKeywords는 5개와 동일하게 유지(추가 10개 기능 삭제)
    const recommendedKeywords = keywords;

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

      reviewRequestScripts: reviewBundle.reviewRequestScripts,
      ownerReplyTemplates: reviewBundle.ownerReplyTemplates,

      photoChecklist: [
        "대표사진 1장: 가장 자신 있는 결과(컷/펌/염색) 1컷",
        "매장 외관 1장: 입구/간판이 보이게",
        "매장 내부 3장: 좌석/거울/조명/대기공간",
        "시술 전/후 6장: 같은 각도, 같은 조명으로",
        "디자이너/스태프 2장: 프로필/작업 장면",
        "예약/안내 1장: 네이버 예약/상담 가능 안내",
        "찾아오는 길 2장: 건물 입구/층수/엘리베이터",
        "주차/대중교통 1장: 가능 여부/근처 주차장"
      ],
      competitorKeywordInsights,
      priceGuidance
    };

    const unifiedText = buildUnifiedText(
      args.placeData.name,
      improvements,
      recommendedKeywords,
      bestSim.totalScore,
      bestSim.totalGrade
    );

    if (sim.totalScore >= target) {
      return {
        improvements,
        recommendedKeywords,
        unifiedText,
        predicted: bestSim,
        attempts: attempt
      };
    }

    const lacks: string[] = [];
    if (keywords.length !== 5) lacks.push("대표키워드 5개 미충족");
    if (description.length < constraints.descriptionMin) lacks.push(`상세설명 글자수 부족(${description.length}자)`);
    if (directions.length < constraints.directionsMin) lacks.push(`오시는길 글자수 부족(${directions.length}자)`);
    if (regionHint && !description.includes(regionHint) && !directions.includes(regionHint))
      lacks.push(`지역 힌트("${regionHint}") 미포함`);
    const lmHit = nearby.filter(x => description.includes(x) || directions.includes(x)).length;
    if (lmHit < constraints.mustIncludeLandmarks)
      lacks.push(`랜드마크 ${constraints.mustIncludeLandmarks}개 미포함(현재 ${lmHit}개)`);
    for (const w of constraints.mustInclude)
      if (!description.includes(w) && !directions.includes(w)) lacks.push(`필수 요소 "${w}" 미포함`);

    feedback =
      `목표 ${target}점 미달(예상 ${sim.totalScore}점). 다음 생성에서는 아래를 반드시 보완:\n` +
      (lacks.length ? `- ${lacks.join("\n- ")}\n` : "") +
      `점수 상세: ${JSON.stringify(sim.scores)}`;
  }

  const imp = lastRaw?.improvements || {};

  const description = clampText(
    safeStr(imp.description) ||
      `${args.placeData.name}은(는) ${extractRegionHint(args.placeData.address)}에 위치한 ${industryKorean(industry)}입니다. ${
        nearby.slice(0, 2).join(", ")
      } 생활권에서 방문이 편하고, 예약 후 1:1 상담으로 ${service} 등 시술을 진행합니다. 디자이너가 두상/모질/손질 습관을 고려해 유지가 쉬운 스타일을 제안합니다.`,
    650
  );

  const directions = clampText(
    safeStr(imp.directions) ||
      `${extractRegionHint(args.placeData.address)} ${args.placeData.address}에 위치해 있습니다. ${
        station !== "근처" ? `${station} 기준` : "주변"
      }으로 도보 이동이 가능하며, 건물 입구/층수는 지도와 사진을 함께 확인하시면 더 빠릅니다. 예약은 네이버 예약을 권장드리며, 방문 전 상담 요청 시 더 정확한 안내가 가능합니다.`,
    420
  );

  const competitorKeywordInsights =
    safeStr(imp.competitorKeywordInsights) ||
    `경쟁사는 '지역+서비스' 조합을 반복적으로 사용합니다.\n- ${regionHint} + (${service})처럼 생활권 검색어를 문장에 자연스럽게 배치\n- 랜드마크(예: ${nearby.join(", ")})를 1~2개 포함해 주변 검색 유입 흡수\n- 예약/상담/디자이너 포인트를 넣어 전환 문구 강화\n- 키워드는 도배하지 말고 1~2회만 자연스럽게`;

  const priceGuidance = safeStr(imp.priceGuidance) || constraints.pricePolicy;

  const improvements: UnifiedPaidImprovements = {
    description,
    directions,
    keywords: better.five,
    reviewRequestScripts: reviewBundle.reviewRequestScripts,
    ownerReplyTemplates: reviewBundle.ownerReplyTemplates,
    photoChecklist: [
      "대표사진 1장: 가장 자신 있는 결과(컷/펌/염색) 1컷",
      "매장 외관 1장: 입구/간판이 보이게",
      "매장 내부 3장: 좌석/거울/조명/대기공간",
      "시술 전/후 6장: 같은 각도, 같은 조명으로",
      "디자이너/스태프 2장: 프로필/작업 장면",
      "예약/안내 1장: 네이버 예약/상담 가능 안내",
      "찾아오는 길 2장: 건물 입구/층수/엘리베이터",
      "주차/대중교통 1장: 가능 여부/근처 주차장"
    ],
    competitorKeywordInsights,
    priceGuidance
  };

  const recommendedKeywords = better.five;
  const unifiedText = buildUnifiedText(args.placeData.name, improvements, recommendedKeywords, bestSim.totalScore, bestSim.totalGrade);

  return {
    improvements,
    recommendedKeywords,
    unifiedText,
    predicted: bestSim,
    attempts: 3
  };
}
