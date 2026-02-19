import { PlaceData, CategoryScores, DiagnosisReport } from "../types";
import { scorePlace } from "../lib/scoring/engine";
import type { Industry } from "../lib/scoring/types";

export class DiagnosisService {
  // 유료일 때만 개선안 생성
  private generateImprovements(placeData: PlaceData, scores: CategoryScores): any {
    const improvements: any = {};

    if (scores.description.score < 80) {
      improvements.description = this.generateDescriptionImprovement(placeData);
    }
    if (scores.directions.score < 80) {
      improvements.directions = this.generateDirectionsImprovement(placeData);
    }
    if (scores.keywords.score < 80) {
      improvements.keywords = this.generateKeywordImprovements(placeData);
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
        `- 메뉴명은 고객이 바로 이해하게(시술/상품명 + 핵심효과) 작성\n`;
    }

    return improvements;
  }

  // ✅ 메인 진단 생성: industry 추가 (기본 hairshop)
  generateDiagnosis(placeData: PlaceData, isPaid: boolean = false, industry: Industry = "hairshop"): DiagnosisReport {
    const scored = scorePlace({
      industry,
      name: placeData.name,
      address: placeData.address,
      description: placeData.description,
      directions: placeData.directions,
      keywords: placeData.keywords,
      reviewCount: placeData.reviewCount,
      photoCount: placeData.photoCount,
      menuCount: placeData.menuCount,
      menus: placeData.menus
      // recentReviewCount30d / blogReviewCount는 추후 크롤링되면 추가 연결
    });

    const report: DiagnosisReport = {
      placeData,
      scores: scored.scores as any, // types.ts의 CategoryScores와 형태 동일(score/grade/issues)
      totalScore: scored.totalScore,
      totalGrade: scored.totalGrade as any,
      isPaid
    };

    if (isPaid) {
      report.improvements = this.generateImprovements(placeData, report.scores);
      report.recommendedKeywords = this.generateRecommendedKeywords(placeData, industry);
    }

    return report;
  }

  private generateDescriptionImprovement(placeData: PlaceData): string {
    return `${placeData.name}은(는) [업종/서비스 한 줄 소개]입니다.

✨ 이런 분께 추천:
- [고객상황 1]
- [고객상황 2]
- [고객상황 3]

✅ 강점:
- [강점 1]
- [강점 2]
- [강점 3]

🕒 운영/예약: [영업시간/예약 안내]
📍 위치: [역/랜드마크 기준 한 줄]
💡 팁: [첫 방문 고객이 궁금해할 내용 한 줄]`;
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

  private generateKeywordImprovements(placeData: PlaceData): string[] {
    const base = (placeData.name || "매장").replace(/\s+/g, " ").trim();
    return [
      `${base} 예약`,
      `${base} 후기`,
      `${base} 가격`,
      `${base} 추천`,
      `${base} 커트`
    ];
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
    // ✅ 여기서 업종별 “5개 추천” 로직을 더 고도화하면 유료 매력이 커짐
    if (industry === "hairshop") return ["서대문역 미용실", "커트", "염색", "펌", "두피케어"];
    if (industry === "cafe") return ["카페", "디저트", "커피", "테이크아웃", "분위기 좋은"];
    return ["맛집", "점심", "저녁", "대표메뉴", "단체"];
  }
}
