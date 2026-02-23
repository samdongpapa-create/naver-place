// src/services/gptConsulting.ts
import OpenAI from "openai";
import type { PlaceData } from "../types";
import type { Industry } from "../lib/scoring/types";
import { scorePlace } from "../lib/scoring/engine";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export type UnifiedPaidImprovements = {
  description: string;
  directions: string;

  // ✅ 항상 5개로 고정(서버/프론트/통합본 모두 동일하게)
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

  // ✅ improvements.keywords와 100% 동일해야 함
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
  return Array.from(new Set(arr.map((s) => (s || "").trim()).filter(Boolean)));
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
  return a.split(" ").slice(0, 2).join(" ");
}

function inferStation(placeName: string, address: string): string {
  const name = (placeName || "").replace(/\s+/g, " ").trim();
  const addr = (address || "").replace(/\s+/g, " ").trim();

  const m1 = name.match(/([가-힣A-Za-z0-9]{1,10}역)/);
  if (m1?.[1]) return m1[1];

  const m2 = addr.match(/([가-힣A-Za-z0-9]{1,10}역)/);
  if (m2?.[1]) return m2[1];

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
  const kws = Array.isArray(placeData.keywords) ? placeData.keywords : [];
  const menuNames = Array.isArray((placeData as any).menus)
    ? (placeData as any).menus.map((m: any) => String(m?.name || ""))
    : [];

  const pool = [...kws, ...menuNames].map((s) => s.trim()).filter(Boolean).join(" ");

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

/**
 * ✅ 키워드 최종 정규화/검증/고정
 * - 반드시 5개
 * - 금칙어 제거
 * - 너무 짧거나 너무 긴 것 제거
 * - 유사/중복 줄이기
 */
function finalizeKeywords5(args: {
  industry: Industry;
  station: string;
  regionHint: string;
  landmarks: string[];
  gptKeywords5?: any;
  fallbackFive: string[];
}): string[] {
  const stop = new Set<string>([
    "추천",
    "인기",
    "잘하는곳",
    "잘하는집",
    "최고",
    "1등",
    "베스트",
    "가격",
    "할인",
    "예약"
  ]);

  const normalize = (k: string) => {
    let x = (k || "").replace(/\s+/g, "").trim();
    if (!x) return "";
    x = x.replace(/헤어샵/g, "미용실");
    x = x.replace(/컷$/g, "커트");
    x = x.replace(/컷/gi, "커트");
    x = x.replace(/[^\w가-힣]/g, "");
    return x;
  };

  const pushClean = (arr: string[], v: any) => {
    const s = normalize(String(v || ""));
    if (!s) return;
    if (s.length < 2 || s.length > 18) return;
    if (stop.has(s)) return;
    // "xxx추천" 류 방지
    if (/추천$/.test(s)) return;
    arr.push(s);
  };

  const cleaned: string[] = [];
  if (Array.isArray(args.gptKeywords5)) {
    for (const x of args.gptKeywords5) pushClean(cleaned, x);
  }

  // GPT 결과가 5개를 “정상적으로” 내놓았을 때만 채택
  let base = cleaned.length >= 5 ? cleaned.slice(0, 5) : args.fallbackFive.slice(0, 5);

  // 지역 접두(가능하면 2~3개는 지역 포함)
  const baseArea = args.station && args.station !== "근처" ? args.station : args.regionHint || args.landmarks?.[0] || "";
  if (baseArea) {
    const boosted: string[] = [];
    for (const k of base) {
      if (boosted.length >= 5) break;
      if (k.startsWith(baseArea)) boosted.push(k);
      else boosted.push(`${baseArea}${k.replace(baseArea, "")}`);
    }
    base = boosted;
  }

  // 중복 제거 후 5개 보장
  const out = uniq(base);
  while (out.length < 5) {
    for (const k of args.fallbackFive) {
      const nk = normalize(k);
      if (!nk) continue;
      if (!out.includes(nk)) out.push(nk);
      if (out.length >= 5) break;
    }
    // 그래도 모자라면 안전 채움
    if (out.length < 5 && baseArea) out.push(`${baseArea}${industryKorean(args.industry)}`);
    if (out.length < 5) out.push(`${industryKorean(args.industry)}추천`);
    // "추천" 금칙어라서 최종 필터 한번 더
    const filtered = out.filter((k) => !stop.has(k) && !/추천$/.test(k));
    out.length = 0;
    out.push(...uniq(filtered));
    if (out.length > 5) out.length = 5;
  }

  return out.slice(0, 5);
}

// ✅ 로컬 기반 “fallback 5개” 생성 (기존 betterKeywords의 핵심만)
function buildLocalFallbackFive(args: {
  industry: Industry;
  address: string;
  station: string;
  landmarks: string[];
  competitorTopKeywords: string[];
}): string[] {
  const indK = industryKorean(args.industry);
  const baseArea = args.station && args.station !== "근처" ? args.station : extractRegionHint(args.address) || args.landmarks?.[0] || "";

  const serviceCandidates =
    args.industry === "hairshop"
      ? ["미용실", "커트", "펌", "염색", "클리닉"]
      : args.industry === "restaurant"
      ? ["맛집", "점심", "저녁", "포장", "데이트"]
      : ["카페", "커피", "디저트", "브런치", "테이크아웃"];

  const cand: string[] = [];
  if (baseArea) cand.push(`${baseArea}${indK}`);

  for (const s of serviceCandidates.slice(0, 3)) {
    if (!baseArea) continue;
    cand.push(`${baseArea}${s}`);
  }

  const preferComp = uniq(args.competitorTopKeywords || [])
    .map((k) => String(k || "").trim())
    .filter((k) => k.length >= 2 && k.length <= 14)
    .filter((k) => !/추천$/.test(k))
    .slice(0, 10);

  cand.push(...preferComp);

  // 마지막 안전 장치
  const five = uniq(cand).slice(0, 5);
  while (five.length < 5) {
    const t = serviceCandidates[five.length % serviceCandidates.length];
    five.push(baseArea ? `${baseArea}${t}` : `${t}`);
  }
  return five.slice(0, 5);
}

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
  lines.push(out.keywords?.length ? out.keywords.map((k) => `- ${k}`).join("\n") : "- (생성 실패)");
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
  lines.push(out.photoChecklist?.length ? out.photoChecklist.map((x) => `- ${x}`).join("\n") : "- (없음)");
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

  // ✅ response_format 지원 모델이면 JSON 안정성 ↑ (지원 안 하면 에러날 수 있어서 try/catch)
  try {
    const res = await client.chat.completions.create({
      model,
      temperature: 0.25,
      response_format: { type: "json_object" } as any,
      messages: [
        { role: "system", content: "You output valid JSON only. No markdown. No explanation." },
        { role: "user", content: prompt }
      ]
    });

    const text = res.choices?.[0]?.message?.content?.trim() || "{}";
    console.log("[GPT] raw response (head 500):", text.slice(0, 500));

    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  } catch (e: any) {
    console.log("[GPT] response_format not supported or error -> fallback parser:", e?.message || String(e));
  }

  // ✅ fallback (기존 방식)
  const res = await client.chat.completions.create({
    model,
    temperature: 0.25,
    messages: [
      { role: "system", content: "You output valid JSON only. No markdown. No explanation." },
      { role: "user", content: prompt }
    ]
  });

  const text = res.choices?.[0]?.message?.content?.trim() || "{}";
  console.log("[GPT] raw response (head 500):", text.slice(0, 500));

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
  const constraints = buildConstraints(industry);

  const regionHint = extractRegionHint(args.placeData.address);
  const station = inferStation(args.placeData.name, args.placeData.address);
  const nearby = buildNearbyLandmarks(industry, args.placeData.address, args.placeData.name);
  const service = serviceHint(industry, args.placeData);

  const competitorTop = Array.isArray(args.competitorTopKeywords) ? args.competitorTopKeywords : [];

  // ✅ 로컬 fallback 5개는 무조건 준비 (경쟁사/모델 흔들려도 5개 고정)
  const fallbackFive = buildLocalFallbackFive({
    industry,
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
- ❌ 글자수 채우려고 가격/시술을 길게 나열하지 말 것
- 가격 정책: ${constraints.pricePolicy}

[경쟁사 키워드 참고(빈도 TOP)]
${competitorTop.slice(0, 40).join(", ")}

[중요]
- GPT는 description/directions/keywords5/competitorKeywordInsights/priceGuidance만 생성
- keywords5는 반드시 5개, 중복 없이, 2~18자, "추천/인기/베스트/가격/할인/1등/최고" 같은 단어는 넣지 말 것

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
      directions = `${regionHint} ${args.placeData.address}에 위치해 있습니다. ${
        station !== "근처" ? `${station} 기준` : "주변"
      }으로 도보 이동이 가능하며, 건물 입구/층수는 지도와 사진을 함께 확인하시면 더 빠릅니다. 예약은 네이버 예약을 권장드리며, 방문 전 상담 요청 시 더 정확한 안내가 가능합니다.`;
    }

    description = clampText(description, constraints.descriptionMax);
    directions = clampText(directions, constraints.directionsMax);

    const competitorKeywordInsights =
      safeStr(imp.competitorKeywordInsights) ||
      `경쟁사는 '지역+서비스' 조합을 반복적으로 사용합니다.\n- ${regionHint} + (${service})처럼 생활권 검색어를 문장에 자연스럽게 배치\n- 랜드마크(예: ${nearby.join(", ")})를 1~2개 포함해 주변 검색 유입 흡수\n- 예약/상담/디자이너 포인트를 넣어 전환 문구 강화\n- 키워드는 도배하지 말고 1~2회만 자연스럽게`;

    const priceGuidance = safeStr(imp.priceGuidance) || constraints.pricePolicy;

    // ✅ 최종 키워드 5개: 여기서만 “단일 확정”
    const finalKeywords5 = finalizeKeywords5({
      industry,
      station,
      regionHint,
      landmarks: nearby,
      gptKeywords5: (imp as any)?.keywords5,
      fallbackFive
    });

    const simulated = scorePlace({
      industry,
      name: args.placeData.name,
      address: args.placeData.address,
      description,
      directions,
      keywords: finalKeywords5,
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
      keywords: finalKeywords5,

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

    // ✅ 여기가 핵심: recommendedKeywords는 improvements.keywords와 100% 동일
    const recommendedKeywords = finalKeywords5;

    const unifiedText = buildUnifiedText(args.placeData.name, improvements, bestSim.totalScore, bestSim.totalGrade);

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
    if (finalKeywords5.length !== 5) lacks.push("대표키워드 5개 미충족");
    if (description.length < constraints.descriptionMin) lacks.push(`상세설명 글자수 부족(${description.length}자)`);
    if (directions.length < constraints.directionsMin) lacks.push(`오시는길 글자수 부족(${directions.length}자)`);
    if (regionHint && !description.includes(regionHint) && !directions.includes(regionHint))
      lacks.push(`지역 힌트("${regionHint}") 미포함`);
    const lmHit = nearby.filter((x) => description.includes(x) || directions.includes(x)).length;
    if (lmHit < constraints.mustIncludeLandmarks) lacks.push(`랜드마크 ${constraints.mustIncludeLandmarks}개 미포함(현재 ${lmHit}개)`);
    for (const w of constraints.mustInclude)
      if (!description.includes(w) && !directions.includes(w)) lacks.push(`필수 요소 "${w}" 미포함`);

    feedback =
      `목표 ${target}점 미달(예상 ${sim.totalScore}점). 다음 생성에서는 아래를 반드시 보완:\n` +
      (lacks.length ? `- ${lacks.join("\n- ")}\n` : "") +
      `점수 상세: ${JSON.stringify(sim.scores)}`;
  }

  // ✅ 최종 fallback (3회 실패해도 무조건 반환)
  const imp = lastRaw?.improvements || {};
  const regionHint = extractRegionHint(args.placeData.address);
  const station = inferStation(args.placeData.name, args.placeData.address);
  const nearby = buildNearbyLandmarks(industry, args.placeData.address, args.placeData.name);
  const service = serviceHint(industry, args.placeData);

  const fallbackFive = buildLocalFallbackFive({
    industry,
    address: args.placeData.address,
    station,
    landmarks: nearby,
    competitorTopKeywords: Array.isArray(args.competitorTopKeywords) ? args.competitorTopKeywords : []
  });

  const finalKeywords5 = finalizeKeywords5({
    industry,
    station,
    regionHint,
    landmarks: nearby,
    gptKeywords5: (imp as any)?.keywords5,
    fallbackFive
  });

  const description = clampText(
    safeStr(imp.description) ||
      `${args.placeData.name}은(는) ${regionHint}에 위치한 ${industryKorean(industry)}입니다. ${nearby
        .slice(0, 2)
        .join(", ")} 생활권에서 방문이 편하고, 예약 후 1:1 상담으로 ${service} 등 시술을 진행합니다. 디자이너가 두상/모질/손질 습관을 고려해 유지가 쉬운 스타일을 제안합니다.`,
    constraints.descriptionMax
  );

  const directions = clampText(
    safeStr(imp.directions) ||
      `${regionHint} ${args.placeData.address}에 위치해 있습니다. ${
        station !== "근처" ? `${station} 기준` : "주변"
      }으로 도보 이동이 가능하며, 건물 입구/층수는 지도와 사진을 함께 확인하시면 더 빠릅니다. 예약은 네이버 예약을 권장드리며, 방문 전 상담 요청 시 더 정확한 안내가 가능합니다.`,
    constraints.directionsMax
  );

  const reviewBundle = buildReviewBundle(industry, args.placeData.name, station, nearby);

  const improvements: UnifiedPaidImprovements = {
    description,
    directions,
    keywords: finalKeywords5,
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
    competitorKeywordInsights:
      safeStr((imp as any).competitorKeywordInsights) ||
      `경쟁사는 '지역+서비스' 조합을 반복적으로 사용합니다.\n- ${regionHint} + (${service})처럼 생활권 검색어를 문장에 자연스럽게 배치\n- 랜드마크(예: ${nearby.join(", ")})를 1~2개 포함해 주변 검색 유입 흡수\n- 예약/상담/디자이너 포인트를 넣어 전환 문구 강화\n- 키워드는 도배하지 말고 1~2회만 자연스럽게`,
    priceGuidance: safeStr((imp as any).priceGuidance) || buildConstraints(industry).pricePolicy
  };

  const unifiedText = buildUnifiedText(args.placeData.name, improvements, bestSim.totalScore, bestSim.totalGrade);

  return {
    improvements,
    recommendedKeywords: finalKeywords5,
    unifiedText,
    predicted: bestSim,
    attempts: 3
  };
}
