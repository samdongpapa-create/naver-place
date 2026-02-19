import { PlaceData, CategoryScores, DiagnosisReport } from "../types";
import { scorePlace } from "../lib/scoring/engine";
import type { Industry } from "../lib/scoring/types";

export class DiagnosisService {
  // ✅ 업종 normalize (서버에서 전달되는 값이 이상해도 안전)
  private normalizeIndustry(v: any): Industry {
    if (v === "cafe" || v === "restaurant" || v === "hairshop") return v;
    return "hairshop";
  }

  // ✅ 메인 진단 생성: 점수는 scoring 엔진으로 통일
  generateDiagnosis(placeData: PlaceData, isPaid: boolean = false, industry: Industry = "hairshop"): DiagnosisReport {
    const normalized = this.normalizeIndustry(industry);

    const scored = scorePlace({
      industry: normalized,
      name: placeData.name,
      address: placeData.address,
      description: placeData.description,
      directions: placeData.directions,
      keywords: placeData.keywords,
      reviewCount: placeData.reviewCount,
      recentReviewCount30d: placeData.recentReviewCount30d, // ✅ 최근성 연결
      photoCount: placeData.photoCount,
      menuCount: placeData.menuCount,
      menus: placeData.menus
      // blogReviewCount 등은 추후 크롤링되면 연결
    });

    const report: DiagnosisReport = {
      placeData,
      scores: scored.scores as unknown as CategoryScores,
      totalScore: scored.totalScore,
      totalGrade: scored.totalGrade as any,
      isPaid
    };

    // ✅ 유료일 때만 개선안/추천키워드 노출
    if (isPaid) {
      report.improvements = this.generateImprovements(placeData, report.scores, normalized);
      report.recommendedKeywords = this.generateRecommendedKeywords(placeData, normalized);
    }

    return report;
  }

  // =========================
  // 유료 개선안 생성
  // =========================
  private generateImprovements(placeData: PlaceData, scores: CategoryScores, industry: Industry): any {
    const improvements: any = {};

    if (scores.description.score < 80) {
      improvements.description = this.generateDescriptionImprovement(placeData, industry);
    }
    if (scores.directions.score < 80) {
      improvements.directions = this.generateDirectionsImprovement(placeData);
    }
    if (scores.keywords.score < 80) {
      improvements.keywords = this.generateKeywordImprovements(placeData, industry);
    }
    if (scores.reviews.score < 80) {
      improvements.reviewGuidance = this.generateReviewGuidance();
    }
    if (scores.photos.score < 80) {
      improvements.photoGuidance = this.generatePhotoGuidance();
    }
    if (scores.price.score < 80) {
      improvements.priceGuidance =
        `가격/메뉴 탭은 전환에 직접 영향이 큽니다.\n` +
        `- 가능하면 '문의' 대신 실제 가격 표기 비율을 높이기\n` +
        `- 대표 메뉴(주력) 10~20개는 가격을 명확히 표기 권장\n` +
        `- 메뉴명은 고객이 바로 이해하게(시술/상품명 + 핵심효과) 작성\n` +
        (industry === "restaurant"
          ? `- 식당은 가격표기가 특히 중요합니다(정가 표기 비율이 낮으면 신뢰도 하락)\n`
          : industry === "hairshop"
          ? `- 미용실은 '문의'가 일부 있어도 괜찮지만, 핵심 메뉴는 가격 공개가 유리합니다\n`
          : ``);
    }

    return improvements;
  }

  private generateDescriptionImprovement(placeData: PlaceData, industry: Industry): string {
    const name = placeData.name || "매장";

    if (industry === "hairshop") {
      return `${name}은(는) 커트/펌/염색 등 고객 맞춤 스타일을 제안하는 미용실입니다.

✨ 이런 분께 추천
- 손질이 쉬운 스타일이 필요한 분
- 이미지 변신(펌/염색/커트)이 필요한 분
- 두피/모발 컨디션까지 함께 관리하고 싶은 분

✅ 강점
- 상담 기반 맞춤 디자인
- 시술 전/후 관리 팁 안내
- 예약 우선으로 대기 최소화

🕒 운영/예약: [영업시간/예약 안내]
📍 위치: [역/랜드마크 기준 한 줄]
💡 팁: 첫 방문은 원하는 스타일 사진을 2~3장 준비하면 상담이 빨라집니다.`;
    }

    if (industry === "cafe") {
      return `${name}은(는) 커피와 디저트를 편하게 즐길 수 있는 카페입니다.

✨ 이런 분께 추천
- 조용히 대화/작업할 카페를 찾는 분
- 디저트/시그니처 메뉴를 찾는 분
- 사진 찍기 좋은 공간을 찾는 분

✅ 강점
- 시그니처 메뉴/원두 소개
- 좌석/콘센트/테이크아웃 안내
- 방문 시간대 추천

🕒 운영시간: [영업시간]
📍 위치: [역/랜드마크 기준 한 줄]
💡 팁: 인기 메뉴는 오후 시간대 조기 소진될 수 있어요.`;
    }

    return `${name}은(는) 대표 메뉴를 중심으로 만족도 높은 식사를 제공하는 매장입니다.

✨ 이런 분께 추천
- 점심/저녁 메뉴 고민하는 분
- 대표 메뉴가 확실한 곳을 찾는 분
- 단체/가족 식사 장소가 필요한 분

✅ 강점
- 대표 메뉴/인기 메뉴 소개
- 포장/배달/웨이팅 여부 안내
- 주차/단체석 등 편의 정보

🕒 운영시간: [영업시간]
📍 위치: [역/랜드마크 기준 한 줄]
💡 팁: 피크타임(12~13시 / 18~19시)은 대기 가능성이 있어요.`;
  }

  private generateDirectionsImprovement(_placeData: PlaceData): string {
    return `🚇 지하철
- [역명] [출구] → 도보 [N]분

🚌 버스
- [정류장명] 하차 → 도보 [N]분

🚗 주차
- [주차 가능/요금/무료 조건]
- [인근 주차장 안내]

📌 찾는 팁
- [건물명/간판/층수/입구 설명]`;
  }

  private generateKeywordImprovements(placeData: PlaceData, industry: Industry): string[] {
    const base = (placeData.name || "매장").replace(/\s+/g, " ").trim();

    if (industry === "hairshop") {
      return [`${base} 미용실`, "커트", "펌", "염색", "두피케어"];
    }
    if (industry === "cafe") {
      return ["카페", "디저트", "커피", "테이크아웃", "분위기 좋은"];
    }
    return ["맛집", "대표메뉴", "점심", "저녁", "단체"];
  }

  private generateReviewGuidance(): string {
    return `리뷰는 '요청 타이밍'이 전부입니다.
- 서비스 직후 만족도가 높을 때 안내
- 사진 첨부 리뷰 유도(전/후, 매장, 메뉴 등)
- 고객이 쓰기 쉬운 예시 문장 2~3개 제공`;
  }

  private generatePhotoGuidance(): string {
    return `사진은 방문 결정의 핵심 신뢰 요소입니다.
- 대표 사진: 외관/내부/작업(시술)/결과/가격표(가능시)
- 카테고리별로 균형 있게 업로드
- 최소 30장 이상 유지, 가능하면 100장 이상 누적 권장`;
  }

  private generateRecommendedKeywords(_placeData: PlaceData, industry: Industry): string[] {
    // ✅ 유료 매력 포인트: 업종별 “추천키워드 5개”는 계속 고도화 가능
    if (industry === "hairshop") return ["서대문역 미용실", "커트", "염색", "펌", "두피케어"];
    if (industry === "cafe") return ["카페", "디저트", "커피", "테이크아웃", "분위기"];
    return ["맛집", "점심", "저녁", "대표메뉴", "단체"];
  }
}
