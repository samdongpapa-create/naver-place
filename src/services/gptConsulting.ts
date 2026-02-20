import OpenAI from "openai";
import type { PlaceData, CategoryScores } from "../types";
import type { Industry } from "../lib/scoring/types";
import { scorePlace } from "../lib/scoring/engine";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export type GptImprovementResult = {
  improvements: {
    description?: string; // 붙여넣기용 상세설명
    directions?: string;  // 붙여넣기용 오시는길
    keywords?: string[];  // 대표키워드 5개
    reviewGuidance?: string;
    photoGuidance?: string;
    priceGuidance?: string;
  };
  recommendedKeywords?: string[];
};

export type GuaranteedConsultingResult = GptImprovementResult & {
  predicted: {
    totalScore: number;
    totalGrade: string;
    // 카테고리별 예상점수도 같이 내려주면 신뢰도 + 디버깅 좋음
    scores: any;
  };
  attempts: number;
};

function normalizeIndustry(v: any): Industry {
  if (v === "hairshop" || v === "cafe" || v === "restaurant") return v;
  return "hairshop";
}

function extractRegionHint(address: string): string {
  // 아주 가볍게 “서울 종로구”, “제주 서귀포시” 같은 힌트만 뽑아줌
  const a = (address || "").replace(/\s+/g, " ").trim();
  if (!a) return "";
  const parts = a.split(" ");
  // [도/시] [구/시] 정도까지만
  return parts.slice(0, 2).join(" ");
}

function buildConstraints(industry: Industry) {
  // 네 “무료 점수 기준”을 여기서 강제한다 (중요)
  // 실제 scorePlace 기준에 맞게 너가 계속 숫자 조정 가능
  const base = {
    keywordsCount: 5,
    descriptionMin: 350,  // 상세설명 최소 글자수
    descriptionMax: 650,  // 너무 길면 과함
    directionsMin: 160,   // 오시는길 최소 글자수
    directionsMax: 420,
    includeCta: true,     // 예약/문의/방문 유도 문구
    includeTrust: true    // 운영 포인트/전문성/차별점 최소 1개
  };

  // 업종별 톤/포인트
  if (industry === "hairshop") {
    return {
      ...base,
      mustInclude: ["예약", "상담", "시술", "디자이너"],
      pricePolicy: "미용실은 '문의' 허용. 다만 주력 시술 5~10개는 가격을 가능한 한 표기."
    };
  }
  if (industry === "restaurant") {
    return {
      ...base,
      mustInclude: ["대표메뉴", "가격", "포장", "주차"],
      pricePolicy: "식당은 가격 표기 엄격. 대표 메뉴 가격을 명확히."
    };
  }
  // cafe
  return {
    ...base,
    mustInclude: ["시그니처", "좌석", "테이크아웃", "운영시간"],
    pricePolicy: "카페는 시그니처/원두/좌석/작업/콘센트 등 전환요소 강조."
  };
}

function ensureKeywords5(arr?: string[]) {
  const a = Array.isArray(arr) ? arr.filter(Boolean).map(s => String(s).trim()).filter(s => s) : [];
  // 중복 제거
  const uniq = Array.from(new Set(a));
  return uniq.slice(0, 5);
}

function clampText(s: string, min: number, max: number): string {
  const t = (s || "").trim();
  if (!t) return "";
  // 너무 길면 잘라내기(끝이 어색할 수 있지만, 점수 보장 우선)
  if (t.length > max) return t.slice(0, max).trim();
  // 너무 짧으면 그대로 리턴(재요청 루프에서 보강)
  return t;
}

async function callGptJSON(prompt: string): Promise<GptImprovementResult> {
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
    return { improvements: {} };
  }
}

/**
 * ✅ 유료 컨설팅(90점 보장 루프)
 * - GPT로 개선안 생성
 * - 우리 scorePlace로 재채점
 * - 90점 미만이면 보강 프롬프트로 최대 3회 재시도
 */
export async function generatePaidConsultingGuaranteed(args: {
  industry: Industry;
  placeData: PlaceData;
  scoredNow: { totalScore: number; totalGrade: string; scores: any };
  targetScore?: number; // 기본 90
}): Promise<GuaranteedConsultingResult> {
  const industry = normalizeIndustry(args.industry);
  const target = typeof args.targetScore === "number" ? args.targetScore : 90;

  const regionHint = extractRegionHint(args.placeData.address || "");
  const constraints = buildConstraints(industry);

  let last: GptImprovementResult | null = null;
  let bestSim: { totalScore: number; totalGrade: string; scores: any } = args.scoredNow;

  // 어떤 항목이 부족했는지 GPT에게 “정확히 피드백”을 주는 게 핵심
  let feedback = "";

  for (let attempt = 1; attempt <= 3; attempt++) {
    const prompt = `
너는 "네이버 플레이스 최적화" 컨설턴트야.
아래의 "점수 기준"을 반드시 충족하는 결과물을 만들어야 해.
결과물은 사용자가 네이버 스마트플레이스에 그대로 붙여넣을 문구다.

[중요 - 점수 기준(반드시 준수)]
- 대표키워드: 정확히 ${constraints.keywordsCount}개
- 상세설명: ${constraints.descriptionMin}~${constraints.descriptionMax}자
- 오시는길: ${constraints.directionsMin}~${constraints.directionsMax}자
- 지역 힌트(주소 기반): "${regionHint}"를 문장에 자연스럽게 1회 이상 포함
- 반드시 포함해야 할 단어/요소: ${constraints.mustInclude.join(", ")}
- 과장/허위(1등, 최고, 유일 등) 금지
- 문구는 현실적으로, 과도한 해시태그/이모지 남발 금지
- 가격/메뉴 정책: ${constraints.pricePolicy}

[현재 플레이스 데이터]
${JSON.stringify(args.placeData, null, 2)}

[현재 진단 점수(참고)]
${JSON.stringify(args.scoredNow, null, 2)}

[이전 시도 피드백(있으면 반영)]
${feedback ? feedback : "(없음)"}

[출력 형식]
반드시 JSON만 출력해 (설명/마크다운/코드블록 금지)
스키마:
{
  "improvements": {
    "description": "string",
    "directions": "string",
    "keywords": ["string","string","string","string","string"],
    "reviewGuidance": "string",
    "photoGuidance": "string",
    "priceGuidance": "string"
  },
  "recommendedKeywords": ["string","..."]
}
`.trim();

    const gpt = await callGptJSON(prompt);
    last = gpt;

    // 최소 안전 보정
    const improvedDesc = clampText(gpt.improvements?.description || "", constraints.descriptionMin, constraints.descriptionMax);
    const improvedDir = clampText(gpt.improvements?.directions || "", constraints.directionsMin, constraints.directionsMax);
    const improvedKw = ensureKeywords5(gpt.improvements?.keywords);

    // 가상 적용 후 재채점
    const simulated = scorePlace({
      industry,
      name: args.placeData.name,
      address: args.placeData.address,
      description: improvedDesc,
      directions: improvedDir,
      keywords: improvedKw,
      reviewCount: args.placeData.reviewCount,
      recentReviewCount30d: (args.placeData as any).recentReviewCount30d,
      photoCount: args.placeData.photoCount,
      menuCount: (args.placeData as any).menuCount,
      menus: (args.placeData as any).menus
    });

    const sim = {
      totalScore: simulated.totalScore,
      totalGrade: simulated.totalGrade,
      scores: simulated.scores
    };

    // best 갱신
    if (sim.totalScore > bestSim.totalScore) bestSim = sim;

    // 목표 달성하면 종료
    if (sim.totalScore >= target) {
      return {
        improvements: {
          ...gpt.improvements,
          description: improvedDesc,
          directions: improvedDir,
          keywords: improvedKw
        },
        recommendedKeywords: gpt.recommendedKeywords || [],
        predicted: bestSim,
        attempts: attempt
      };
    }

    // 다음 재요청을 위한 피드백 만들기(매우 중요)
    const lacks: string[] = [];
    if (improvedKw.length !== 5) lacks.push(`대표키워드가 5개가 아님(현재 ${improvedKw.length}개)`);
    if (improvedDesc.length < constraints.descriptionMin) lacks.push(`상세설명 글자수 부족(${improvedDesc.length}자)`);
    if (improvedDir.length < constraints.directionsMin) lacks.push(`오시는길 글자수 부족(${improvedDir.length}자)`);
    if (regionHint && !improvedDesc.includes(regionHint) && !improvedDir.includes(regionHint)) lacks.push(`지역 힌트("${regionHint}") 미포함`);
    for (const w of constraints.mustInclude) {
      if (!improvedDesc.includes(w) && !improvedDir.includes(w)) {
        lacks.push(`필수 요소 "${w}" 미포함`);
      }
    }

    feedback =
      `목표점수 ${target} 미달(예상 ${sim.totalScore}점, ${sim.totalGrade}). ` +
      (lacks.length ? `아래를 반드시 보완해서 다시 생성:\n- ${lacks.join("\n- ")}\n` : "") +
      `카테고리별 점수/이슈(참고): ${JSON.stringify(sim.scores)}`;

    // 다음 루프 계속
  }

  // 3회 안에 목표점수 미달이면 “최고 점수 결과” 반환
  return {
    improvements: {
      ...(last?.improvements || {}),
      // 마지막 결과라도 안전 보정
      description: clampText(last?.improvements?.description || "", constraints.descriptionMin, constraints.descriptionMax),
      directions: clampText(last?.improvements?.directions || "", constraints.directionsMin, constraints.directionsMax),
      keywords: ensureKeywords5(last?.improvements?.keywords)
    },
    recommendedKeywords: last?.recommendedKeywords || [],
    predicted: bestSim,
    attempts: 3
  };
}
