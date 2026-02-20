export type Industry = "hairshop" | "cafe" | "restaurant";
export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export interface MenuItem {
  name: string;
  price: string; // "24,000원" / "문의" / "변동" 등
  desc?: string;
}

export interface PlaceScoringInput {
  industry: Industry;

  name?: string;
  address?: string;

  description?: string;
  directions?: string;
  keywords?: string[];

  reviewCount?: number;
  recentReviewCount30d?: number;

  photoCount?: number;

  menuCount?: number;
  menus?: MenuItem[];
}

export interface ScoreResult100 {
  score: number;
  grade: Grade;
  issues: string[];

  /**
   * ✅ 프론트에서 "개수 외 점수요소"를 보여주기 위한 세부점수
   * 예: { count: 48, dedupe: 10, intent: 12, locality: 8, industryFit: 14, stopwordPenalty: -6 }
   */
  breakdown?: Record<string, number>;

  /**
   * (옵션) 디버깅/표시용 메타
   */
  meta?: Record<string, any>;
}

export interface ScoringOutput {
  scores: {
    description: ScoreResult100;
    directions: ScoreResult100;
    keywords: ScoreResult100;
    reviews: ScoreResult100;
    photos: ScoreResult100;
    price: ScoreResult100;
  };
  totalScore: number;
  totalGrade: Grade;
}
