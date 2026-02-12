import { PlaceData, ScoreResult, CategoryScores, DiagnosisReport, CompetitorData } from '../types';

export class DiagnosisService {
  
  // 점수를 등급으로 변환
  private scoreToGrade(score: number): 'S' | 'A' | 'B' | 'C' | 'D' | 'F' {
    if (score >= 95) return 'S';
    if (score >= 85) return 'A';
    if (score >= 70) return 'B';
    if (score >= 55) return 'C';
    if (score >= 40) return 'D';
    return 'F';
  }

  // 상세설명 평가
  evaluateDescription(description: string): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (!description || description.length === 0) {
      issues.push('상세설명이 등록되지 않았습니다');
      score = 0;
    } else {
      if (description.length < 100) {
        issues.push('상세설명이 너무 짧습니다 (100자 이상 권장)');
        score -= 30;
      }
      if (description.length < 200) {
        issues.push('더 자세한 설명을 추가하면 좋습니다 (200자 이상 권장)');
        score -= 15;
      }
      if (!/영업시간|운영시간|오픈|가격|메뉴|서비스/.test(description)) {
        issues.push('영업시간, 가격, 주요 서비스 정보 추가 권장');
        score -= 20;
      }
    }

    return {
      score: Math.max(0, score),
      grade: this.scoreToGrade(Math.max(0, score)),
      issues
    };
  }

  // 오시는길 평가
  evaluateDirections(directions: string): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (!directions || directions.length === 0) {
      issues.push('오시는길 정보가 등록되지 않았습니다');
      score = 0;
    } else {
      if (directions.length < 50) {
        issues.push('오시는길 설명이 너무 짧습니다');
        score -= 30;
      }
      if (!/지하철|버스|도보|주차|출구/.test(directions)) {
        issues.push('대중교통 또는 주차 정보 추가 권장');
        score -= 25;
      }
    }

    return {
      score: Math.max(0, score),
      grade: this.scoreToGrade(Math.max(0, score)),
      issues
    };
  }

  // 대표키워드 평가
  evaluateKeywords(keywords: string[]): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (keywords.length === 0) {
      issues.push('대표키워드가 설정되지 않았습니다');
      score = 0;
    } else if (keywords.length < 3) {
      issues.push('대표키워드를 더 추가하세요 (3개 이상 권장)');
      score -= 40;
    } else if (keywords.length < 5) {
      issues.push('대표키워드를 5개까지 설정하는 것을 권장합니다');
      score -= 20;
    }

    return {
      score: Math.max(0, score),
      grade: this.scoreToGrade(Math.max(0, score)),
      issues
    };
  }

  // 리뷰 평가
  evaluateReviews(reviewCount: number): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (reviewCount === 0) {
      issues.push('리뷰가 없습니다. 고객 리뷰 유도가 필요합니다');
      score = 0;
    } else if (reviewCount < 10) {
      issues.push('리뷰가 부족합니다 (10개 이상 권장)');
      score = 30;
    } else if (reviewCount < 50) {
      issues.push('리뷰를 더 확보하면 좋습니다 (50개 이상 권장)');
      score = 60;
    } else if (reviewCount < 100) {
      issues.push('양호한 리뷰 수입니다');
      score = 80;
    }

    return {
      score: Math.max(0, score),
      grade: this.scoreToGrade(Math.max(0, score)),
      issues
    };
  }

  // 사진 평가
  evaluatePhotos(photoCount: number): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (photoCount === 0) {
      issues.push('사진이 없습니다. 매장 사진 등록이 필요합니다');
      score = 0;
    } else if (photoCount < 10) {
      issues.push('사진이 부족합니다 (10장 이상 권장)');
      score = 30;
    } else if (photoCount < 30) {
      issues.push('사진을 더 추가하면 좋습니다 (30장 이상 권장)');
      score = 60;
    } else if (photoCount < 50) {
      issues.push('양호한 사진 수입니다');
      score = 80;
    }

    return {
      score: Math.max(0, score),
      grade: this.scoreToGrade(Math.max(0, score)),
      issues
    };
  }

  // 전체 진단 생성
  generateDiagnosis(placeData: PlaceData, isPaid: boolean = false): DiagnosisReport {
    const scores: CategoryScores = {
      description: this.evaluateDescription(placeData.description),
      directions: this.evaluateDirections(placeData.directions),
      keywords: this.evaluateKeywords(placeData.keywords),
      reviews: this.evaluateReviews(placeData.reviewCount),
      photos: this.evaluatePhotos(placeData.photoCount)
    };

    const totalScore = Math.round(
      (scores.description.score +
       scores.directions.score +
       scores.keywords.score +
       scores.reviews.score +
       scores.photos.score) / 5
    );

    const report: DiagnosisReport = {
      placeData,
      scores,
      totalScore,
      totalGrade: this.scoreToGrade(totalScore),
      isPaid
    };

    // 유료 버전일 경우 개선안 제공
    if (isPaid) {
      report.improvements = this.generateImprovements(placeData, scores);
      report.recommendedKeywords = this.generateRecommendedKeywords(placeData);
    }

    return report;
  }

  // 개선안 생성 (유료)
  private generateImprovements(placeData: PlaceData, scores: CategoryScores): any {
    const improvements: any = {};

    // 상세설명 개선안
    if (scores.description.score < 80) {
      improvements.description = this.generateDescriptionImprovement(placeData);
    }

    // 오시는길 개선안
    if (scores.directions.score < 80) {
      improvements.directions = this.generateDirectionsImprovement(placeData);
    }

    // 키워드 개선안
    if (scores.keywords.score < 80) {
      improvements.keywords = this.generateKeywordImprovements(placeData);
    }

    // 리뷰 가이드
    if (scores.reviews.score < 80) {
      improvements.reviewGuidance = this.generateReviewGuidance();
    }

    // 사진 가이드
    if (scores.photos.score < 80) {
      improvements.photoGuidance = this.generatePhotoGuidance();
    }

    return improvements;
  }

  private generateDescriptionImprovement(placeData: PlaceData): string {
    return `${placeData.name}은(는) [업종 설명]입니다.

✨ 주요 특징:
- 특징 1: [고객에게 제공하는 주요 가치]
- 특징 2: [차별화된 서비스/제품]
- 특징 3: [전문성 또는 경험]

📍 위치: ${placeData.address}

⏰ 영업시간:
- 평일: [영업시간 입력]
- 주말: [영업시간 입력]

💰 가격대: [가격 정보 입력]

📞 문의: [전화번호]

[추가 안내사항이나 특별 프로모션 정보]`;
  }

  private generateDirectionsImprovement(placeData: PlaceData): string {
    return `📍 ${placeData.address}

🚇 지하철 이용 시:
- [호선] [역명] [출구]번 출구에서 도보 [분]
- 상세 경로: [구체적인 이동 경로]

🚌 버스 이용 시:
- [버스 노선] [정류장명] 하차
- 하차 후 [이동 방법]

🚗 자가용 이용 시:
- 주차: [주차 가능 여부 및 위치]
- 내비게이션: [건물명 또는 도로명 주소]

💡 Tip: [찾아오는 데 도움이 되는 추가 정보]`;
  }

  private generateKeywordImprovements(placeData: PlaceData): string[] {
    // 기존 키워드 기반으로 추천 키워드 생성
    const recommendations = [
      `${placeData.name.split(' ')[0]}`,
      '맛집',
      '추천',
      '인기',
      '유명'
    ];
    return recommendations.slice(0, 5);
  }

  private generateReviewGuidance(): string {
    return `📝 리뷰 개선 가이드:

1. 고객 리뷰 유도 방법:
   - 방문 후 리뷰 작성 시 소정의 혜택 제공
   - QR 코드를 통한 간편한 리뷰 작성 유도
   - SNS 이벤트 연계

2. 긍정 리뷰 확보 전략:
   - 우수한 서비스 제공으로 자연스러운 긍정 리뷰 유도
   - 고객 피드백에 신속하게 응답
   - 단골 고객 관리 강화

3. 리뷰 답변 가이드:
   - 모든 리뷰에 성실하게 답변
   - 부정 리뷰에도 진정성 있는 개선 의지 표현
   - 감사 인사와 함께 재방문 유도`;
  }

  private generatePhotoGuidance(): string {
    return `📸 사진 개선 가이드:

1. 필수 사진 종류:
   - 외관 사진 (낮/밤 각 1장 이상)
   - 내부 인테리어 (다양한 앵글 5장 이상)
   - 대표 메뉴/상품 (각 1장 이상)
   - 상세 메뉴/상품 사진

2. 사진 촬영 팁:
   - 자연광 활용 (낮 시간대 촬영)
   - 깔끔한 구도와 정리된 공간
   - 고해상도 이미지 사용
   - 계절별, 시간대별 다양한 사진

3. 업데이트 주기:
   - 월 1회 이상 새로운 사진 추가
   - 시즌 메뉴나 이벤트 사진 즉시 업로드
   - 오래된 사진은 주기적으로 교체`;
  }

  private generateRecommendedKeywords(placeData: PlaceData): string[] {
    // 업종별 추천 키워드 (실제로는 더 정교한 로직 필요)
    const baseKeywords = [
      `${placeData.address.split(' ')[0]}맛집`,
      `${placeData.address.split(' ')[1]}핫플`,
      '인스타감성',
      '데이트코스',
      '분위기좋은'
    ];
    return baseKeywords;
  }
}
