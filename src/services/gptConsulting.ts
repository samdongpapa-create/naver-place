import OpenAI from "openai";
import type { PlaceData, CategoryScores } from "../types";
import type { Industry } from "../lib/scoring/types";

const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

export type GptImprovementResult = {
  improvements: {
    description?: string;     // 바로 붙여넣기용 상세설명
    directions?: string;      // 바로 붙여넣기용 오시는길
    keywords?: string[];      // 대표키워드 5개
    reviewGuidance?: string;  // 리뷰 요청 문구/운영 가이드
    photoGuidance?: string;   // 사진 가이드
    priceGuidance?: string;   // 메뉴/가격 가이드 (업종별)
  };
  recommendedKeywords?: string[]; // 추가 추천(선택)
};

function normalizeIndustry(v: any): Industry {
  if (v === "hairshop" || v === "cafe" || v === "restaurant") return v;
  return "hairshop";
}

export async function generatePaidConsultingByGPT(args: {
  industry: Industry;
  placeData: PlaceData;
  scores: CategoryScores;
  totalScore: number;
  totalGrade: string;
}): Promise<GptImprovementResult> {
  const industry = normalizeIndustry(args.industry);

  const prompt = `
너는 "네이버 플레이스 최적화" 컨설턴트야.
아래 진단 결과(점수/이슈)와 현재 플레이스 데이터를 보고,
"실제로 네이버 스마트플레이스에 그대로 붙여넣을 수 있는 문구"를 만들어줘.

규칙:
- 결과는 반드시 JSON만 출력해. (설명/마크다운/코드블록 금지)
- keywords는 무조건 5개.
- description, directions는 300~600자 정도로 현실적으로 작성.
- 특정 과장/허위(1등, 최고 등) 표현 금지.
- 업종(${industry}) 특성 반영:
  - hairshop: '문의' 허용 비율이 다소 있어도 OK, 대신 핵심 메뉴는 가격 표기 권장
  - restaurant: 가격표기 엄격, 대표 메뉴 가격 표기 강조
  - cafe: 시그니처/원두/좌석/작업가능 여부 등 전환요소 포함

입력 데이터:
placeData:
${JSON.stringify(args.placeData, null, 2)}

scores(각 카테고리 score/grade/issues):
${JSON.stringify(args.scores, null, 2)}

총점/등급: ${args.totalScore} / ${args.totalGrade}

출력 JSON 스키마(엄수):
{
  "improvements": {
    "description": "string",
    "directions": "string",
    "keywords": ["string","string","string","string","string"],
    "reviewGuidance": "string",
    "photoGuidance": "string",
    "priceGuidance": "string"
  },
  "recommendedKeywords": ["string", "..."] // 선택
}
`.trim();

  const res = await client.chat.completions.create({
    // 모델은 필요에 따라 교체 가능
    model: "gpt-4.1-mini",
    temperature: 0.4,
    messages: [
      { role: "system", content: "You are a helpful assistant that outputs valid JSON only." },
      { role: "user", content: prompt }
    ]
  });

  const text = res.choices?.[0]?.message?.content?.trim() || "{}";

  // JSON 파싱 (모델이 실수하면 최소 복구)
  try {
    return JSON.parse(text);
  } catch {
    // JSON 외 텍스트가 섞인 경우를 대비해, 첫 { ... } 블록만 뽑아서 파싱 시도
    const m = text.match(/\{[\s\S]*\}$/);
    if (m) {
      try {
        return JSON.parse(m[0]);
      } catch {}
    }
    return { improvements: { keywords: [] as any } as any };
  }
}
