/**
 * GPT Consulting Service
 *
 * 요구사항 반영:
 *  - 추천키워드10개(추가활용) 삭제
 *  - 추가 추천키워드 삭제
 *  - "추천 대표키워드"와 "유료컨설팅 통합본"에서 대표키워드가 서로 다르게 나오는 문제 해결
 *    => 단일 필드 recommendedKeywords5 로 통일하여 모든 출력에서 동일하게 사용
 */

import OpenAI from "openai";

export type GptConsultingInput = {
  placeName: string;
  category?: string;
  address?: string;
  currentKeywords?: string[];
  description?: string;
  directions?: string;
  reviewsTotal?: number;
  recent30d?: number;
  photoCount?: number;
  competitorNames?: string[];
};

export type GptConsultingResult = {
  recommendedKeywords5: string[]; // ✅ 대표키워드(5개) 단일 소스
  improvedDescription: string;
  improvedDirections: string;
  unifiedText: string; // 유료 컨설팅 통합본 (대표키워드도 recommendedKeywords5로 동일)
};

function cleanKeyword(k: string) {
  return k
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function uniq(arr: string[]) {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const a of arr) {
    const v = cleanKeyword(a);
    if (!v) continue;
    if (seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function enforce5(arr: string[]) {
  const u = uniq(arr);
  return u.slice(0, 5);
}

function fallbackKeywords(input: GptConsultingInput) {
  // GPT 실패 시에도 최소 5개는 제공
  const base = [
    ...(input.currentKeywords || []),
    input.placeName,
    input.category || "",
    (input.address || "").split(" ").slice(0, 2).join(" "),
  ].filter(Boolean) as string[];

  // 너무 긴 문구 방지
  const cleaned = base.map(cleanKeyword).filter((s) => s && s.length <= 18);
  const out = enforce5(cleaned);
  while (out.length < 5) out.push(`추천키워드${out.length + 1}`);
  return out;
}

function buildPrompt(input: GptConsultingInput) {
  const {
    placeName,
    category,
    address,
    currentKeywords,
    description,
    directions,
    reviewsTotal,
    recent30d,
    photoCount,
    competitorNames,
  } = input;

  return `
너는 네이버 플레이스 최적화 전문가야.
아래 정보를 바탕으로 "대표키워드 5개"와 "상세설명 개선안", "오시는길 개선안"을 만들어줘.

[업체]
- 상호: ${placeName}
- 카테고리: ${category || "미상"}
- 주소: ${address || "미상"}

[현재 상태]
- 현재 대표키워드(추출): ${(currentKeywords || []).join(", ") || "없음"}
- 현재 상세설명(추출): ${description || "없음"}
- 현재 오시는길(추출): ${directions || "없음"}
- 방문자리뷰(총): ${typeof reviewsTotal === "number" ? reviewsTotal : "미상"}
- 최근 30일 리뷰 수: ${typeof recent30d === "number" ? recent30d : "미상"}
- 사진 수(추정/추출): ${typeof photoCount === "number" ? photoCount : "미상"}
- 경쟁사(가능하면 참고): ${(competitorNames || []).join(", ") || "없음"}

[출력 형식 - 반드시 JSON만]
{
  "recommendedKeywords5": ["키워드1","키워드2","키워드3","키워드4","키워드5"],
  "improvedDescription": "최적화된 상세설명 (한국어, 300~450자 내, 자연스럽게)",
  "improvedDirections": "오시는길 안내 (한국어, 120~220자 내, 핵심만)"
}

규칙:
- recommendedKeywords5는 딱 5개
- 키워드는 너무 길지 않게(가능하면 6~12자)
- 검색 의도 고려(지역/서비스/강점 조합)
- 과장/허위/최상급 남발 금지
`.trim();
}

export class GptConsultingService {
  static async run(input: GptConsultingInput): Promise<GptConsultingResult> {
    // OpenAI 키가 없으면 fallback
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      const recommendedKeywords5 = fallbackKeywords(input);
      const improvedDescription =
        (input.description && input.description.trim().length >= 30
          ? input.description.trim()
          : `${input.placeName}의 강점을 명확히 전달하고, 주요 시술/서비스와 위치 정보를 함께 안내해보세요. 고객이 어떤 상황에서 방문하면 좋은지(컷/펌/염색/클리닉 등) 자연스럽게 담으면 전환에 유리합니다.`).slice(
          0,
          420
        ) + "";
      const improvedDirections =
        (input.directions && input.directions.trim().length >= 20
          ? input.directions.trim()
          : `가까운 지하철역/버스정류장에서 도보 경로를 한 문장으로 안내하고, 건물 입구/층수/주차 여부를 함께 적어 방문장벽을 낮춰보세요.`).slice(
          0,
          200
        ) + "";

      const unifiedText = this.buildUnifiedText(
        input,
        recommendedKeywords5,
        improvedDescription,
        improvedDirections
      );

      return { recommendedKeywords5, improvedDescription, improvedDirections, unifiedText };
    }

    const client = new OpenAI({ apiKey });

    try {
      const prompt = buildPrompt(input);

      const completion = await client.chat.completions.create({
        model: process.env.OPENAI_MODEL || "gpt-4o-mini",
        temperature: 0.5,
        messages: [
          { role: "system", content: "You are a helpful assistant." },
          { role: "user", content: prompt },
        ],
        response_format: { type: "json_object" },
      });

      const text = completion.choices?.[0]?.message?.content || "";
      let parsed: any = null;

      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = null;
      }

      const recommendedKeywords5 = enforce5(parsed?.recommendedKeywords5 || fallbackKeywords(input));
      const improvedDescription = String(parsed?.improvedDescription || "").trim() || (input.description || "").trim();
      const improvedDirections = String(parsed?.improvedDirections || "").trim() || (input.directions || "").trim();

      const finalDesc =
        improvedDescription && improvedDescription.length >= 40
          ? improvedDescription.slice(0, 480)
          : `${input.placeName}의 차별점(주력 시술/상담/제품/경험)을 한 문단으로 정리하고, 고객이 얻는 결과를 자연스럽게 표현해보세요. 위치/예약/주차처럼 방문 결정에 필요한 정보를 함께 담으면 전환에 유리합니다.`;

      const finalDir =
        improvedDirections && improvedDirections.length >= 20
          ? improvedDirections.slice(0, 240)
          : `가까운 역/정류장에서 도보 경로, 건물 입구/층수, 주차 가능 여부를 간단히 안내해 방문장벽을 낮춰보세요.`;

      const unifiedText = this.buildUnifiedText(input, recommendedKeywords5, finalDesc, finalDir);

      return {
        recommendedKeywords5,
        improvedDescription: finalDesc,
        improvedDirections: finalDir,
        unifiedText,
      };
    } catch {
      // GPT 오류 시 fallback
      const recommendedKeywords5 = fallbackKeywords(input);
      const improvedDescription =
        (input.description && input.description.trim().length >= 30
          ? input.description.trim()
          : `${input.placeName}의 강점을 명확히 전달하고, 주요 시술/서비스와 위치 정보를 함께 안내해보세요. 고객이 어떤 상황에서 방문하면 좋은지(컷/펌/염색/클리닉 등) 자연스럽게 담으면 전환에 유리합니다.`).slice(
          0,
          420
        ) + "";
      const improvedDirections =
        (input.directions && input.directions.trim().length >= 20
          ? input.directions.trim()
          : `가까운 지하철역/버스정류장에서 도보 경로를 한 문장으로 안내하고, 건물 입구/층수/주차 여부를 함께 적어 방문장벽을 낮춰보세요.`).slice(
          0,
          200
        ) + "";

      const unifiedText = this.buildUnifiedText(input, recommendedKeywords5, improvedDescription, improvedDirections);

      return { recommendedKeywords5, improvedDescription, improvedDirections, unifiedText };
    }
  }

  private static buildUnifiedText(
    input: GptConsultingInput,
    recommendedKeywords5: string[],
    improvedDescription: string,
    improvedDirections: string
  ) {
    // ✅ 통합본에도 recommendedKeywords5를 그대로 사용해서 "대표키워드 불일치" 방지
    const k = recommendedKeywords5.join(", ");
    const comp = (input.competitorNames || []).filter(Boolean).slice(0, 5).join(", ");

    return `
[유료 컨설팅 통합본]

1) 추천 대표키워드(5)
- ${k}

2) 상세설명 개선안
- ${improvedDescription}

3) 오시는길 개선안
- ${improvedDirections}

4) 현재 지표 요약
- 방문자리뷰(총): ${typeof input.reviewsTotal === "number" ? input.reviewsTotal : "미상"}
- 최근 30일 리뷰 수: ${typeof input.recent30d === "number" ? input.recent30d : "미상"}
- 사진 수(추정/추출): ${typeof input.photoCount === "number" ? input.photoCount : "미상"}

5) 경쟁사 참고(가능한 경우)
- ${comp || "확인 불가"}
`.trim();
  }
}
