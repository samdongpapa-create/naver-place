import { PlaceData, ScoreResult, CategoryScores, DiagnosisReport } from '../types';

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

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
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

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
  }

  // 대표키워드 평가
  evaluateKeywords(keywords: string[]): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (!keywords || keywords.length === 0) {
      issues.push('대표키워드가 설정되지 않았습니다');
      score = 0;
    } else if (keywords.length < 3) {
      issues.push('대표키워드를 더 추가하세요 (3개 이상 권장)');
      score -= 40;
    } else if (keywords.length < 5) {
      issues.push('대표키워드를 5개까지 설정하는 것을 권장합니다');
      score -= 20;
    }

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
  }

  // 리뷰 평가
  evaluateReviews(reviewCount: number): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (!reviewCount || reviewCount === 0) {
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

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
  }

  // 사진 평가
  evaluatePhotos(photoCount: number): ScoreResult {
    const issues: string[] = [];
    let score = 100;

    if (!photoCount || photoCount === 0) {
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

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
  }

  // ✅ 가격/메뉴 평가 (menuCount / menus 기반)
  evaluatePrice(placeData: PlaceData): ScoreResult {
    const issues: string[] = [];

    const menuCount = placeData.menuCount ?? 0;
    const menus = Array.isArray(placeData.menus) ? placeData.menus : [];

    // 크롤링/데이터 자체가 없을 때
    if (placeData.menuCount === undefined) {
      issues.push('가격/메뉴 데이터를 수집하지 못했습니다 (표시/등록 여부 확인 필요)');
      return { score: 0, grade: 'F', issues };
    }

    // 메뉴가 0
    if (menuCount <= 0) {
      issues.push('가격/메뉴가 없거나 노출되지 않습니다');
      return { score: 0, grade: 'F', issues };
    }

    // 1) 메뉴 수 기반 기본 점수
    let score = 0;
    if (menuCount < 5) score = 40;
    else if (menuCount < 10) score = 60;
    else if (menuCount < 20) score = 80;
    else if (menuCount < 30) score = 95;
    else score = 100;

    issues.push(`총 메뉴 수: ${menuCount}개`);

    // 2) 메뉴 품질(가격 표기 비율/문의 비율) 반영
    // menus가 없을 수도 있으니(목록 미제공) 있을 때만 품질 평가
    if (menus.length > 0) {
      const total = menus.length;

      const hasNumericPrice = (p: string) => /[0-9][0-9,]*\s*원/.test(p || '');
      const isInquiry = (p: string) => /문의|별도|상담|협의/.test(p || '');

      const priced = menus.filter(m => hasNumericPrice(m.price)).length;
      const inquiry = menus.filter(m => isInquiry(m.price)).length;

      const pricedRatio = priced / total;
      const inquiryRatio = inquiry / total;

      // 가격 표기 비율이 낮으면 감점
      if (pricedRatio < 0.6) {
        issues.push(`가격 표기 메뉴 비율이 낮습니다 (${Math.round(pricedRatio * 100)}%)`);
        score -= 20;
      } else if (pricedRatio < 0.8) {
        issues.push(`가격 표기 메뉴를 더 늘리면 좋습니다 (${Math.round(pricedRatio * 100)}%)`);
        score -= 10;
      }

      // 문의/협의 비율이 너무 높으면 감점
      if (inquiryRatio > 0.35) {
        issues.push(`‘문의/협의’ 비율이 높습니다 (${Math.round(inquiryRatio * 100)}%)`);
        score -= 15;
      }
    } else {
      // 목록은 없고 count만 있을 때(현재 너 UI 요구엔 충분)
      issues.push('메뉴 상세 목록은 제공되지 않았습니다(총 메뉴 수만 반영)');
    }

    score = Math.max(0, Math.min(100, score));
    return { score, grade: this.scoreToGrade(score), issues };
  }

  // 전체 진단 생성
  generateDiagnosis(placeData: PlaceData, isPaid: boolean = false): DiagnosisReport {
    const scores: CategoryScores = {
      description: this.evaluateDescription(placeData.description),
      directions: this.evaluateDirections(placeData.directions),
      keywords: this.evaluateKeywords(placeData.keywords),
      reviews: this.evaluateReviews(placeData.reviewCount),
      photos: this.evaluatePhotos(placeData.photoCount),

      // ✅ 추가
      price: this.evaluatePrice(placeData)
    };

    // ✅ 6개 항목 평균으로 총점 계산
    const totalScore = Math.round(
      (scores.description.score +
        scores.directions.score +
        scores.keywords.score +
        scores.reviews.score +
        scores.photos.score +
        scores.price.score) / 6
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

    // ✅ 가격/메뉴 가이드(원하면)
    if (scores.price.score < 80) {
      improvements.priceGuidance =
        `가격/메뉴 탭을 강화하면 전환이 좋아집니다.\n` +
        `- 메뉴(시술)명을 고객이 바로 이해하게 작성\n` +
        `- 가능하면 '문의' 대신 실제 가격 표기 비율을 높이기\n` +
        `- 대표 메뉴(주력 시술) 10~20개는 가격을 명확히 표기 권장\n`;
    }

    return improvements;
  }

  private generateDescriptionImprovement(placeData: PlaceData): string {
    return `${placeData.name}은(는) [업종 설명]입니다.

✨ 주요 특징:
- 특징 1: [고객에게 제공하는 주요 가치]
- 특징 2: [차별화된 서비스/제품]
- 특징 3: [전문성 또는 경험]

🕒 영업시간: [영업시간 입력]
📍 위치: [주요 랜드마크/역에서 오시는 길]
💰 가격/서비스: [대표 서비스/메뉴 간단 안내]

#추천 #키워드 #지역명`;
  }

  private generateDirectionsImprovement(_placeData: PlaceData): string {
    return `🚇 지하철:
- [역명] [출구 번호]에서 도보 [N]분

🚌 버스:
- [정류장명] 하차 후 도보 [N]분

🚗 주차:
- [주차 가능 여부/요금/무료 조건]
- [인근 주차장 안내]

📌 찾는 팁:
- [건물명/간판/층수/입구 설명]`;
  }

  private generateKeywordImprovements(placeData: PlaceData): string[] {
    const base = placeData.name || '매장';
    return [
      `${base} 추천`,
      `근처 ${base}`,
      `${base} 후기`,
      `${base} 가격`,
      `${base} 예약`
    ];
  }

  private generateReviewGuidance(): string {
    return `리뷰를 늘리려면 '요청 타이밍'이 중요합니다.
- 시술/서비스 직후 만족도가 높을 때 안내
- 사진 첨부 리뷰 유도(전/후, 매장, 제품 등)
- 고객이 쓰기 쉬운 예시 문장 제공`;
  }

  private generatePhotoGuidance(): string {
    return `사진은 '신뢰'를 만드는 핵심입니다.
- 대표 사진: 매장 외관/내부/좌석/디자이너/시술결과
- 카테고리별로 균형 있게 업로드(전후/매장/제품/가격표)
- 최소 30장 이상 유지 권장`;
  }

  private generateRecommendedKeywords(_placeData: PlaceData): string[] {
    // (기존 로직이 있으면 그걸 유지해도 됨)
    return [];
  }
}
