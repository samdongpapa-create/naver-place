export type Industry = "hairshop" | "cafe" | "restaurant";

export type Grade = "S" | "A" | "B" | "C" | "D" | "F";

export type ScoreResult100 = {
  score: number; // 0~100
  grade: Grade;
  issues: string[];
};

export type CategoryScores100 = {
  description: ScoreResult100;
  directions: ScoreResult100;
  keywords: ScoreResult100;
  reviews: ScoreResult100;
  photos: ScoreResult100;
  price: ScoreResult100;
};

export type MenuItemLike = {
  name: string;
  price: string; // "24,000원" / "문의" / "별도" / "변동" 등
  desc?: string;
};

export type PlaceScoringInput = {
  industry: Industry;

  name?: string;
  address?: string;

  description?: string;
  directions?: string;
  keywords?: string[];

  reviewCount?: number;
  recentReviewCount30d?: number; // 있으면 반영(없으면 중립)
  blogReviewCount?: number;

  photoCount?: number;

  menuCount?: number;
  menus?: MenuItemLike[];
};

export type ScoringOutput = {
  scores: CategoryScores100;
  totalScore: number; // 0~100
  totalGrade: Grade;
};
