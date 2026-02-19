export interface MenuItem {
  name: string;
  price: string; // "24,000원" / "문의" / "별도" 등
  desc: string;
}

export interface PlaceData {
  name: string;
  address: string;
  reviewCount: number;
  photoCount: number;
  description: string;
  directions: string;
  keywords: string[];

  // ✅ 추가
  menuCount?: number;
  menus?: MenuItem[];
}

export interface ScoreResult {
  score: number;
  grade: 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
  issues: string[];
}

export interface CategoryScores {
  description: ScoreResult;
  directions: ScoreResult;
  keywords: ScoreResult;
  reviews: ScoreResult;
  photos: ScoreResult;

  // ✅ 추가
  price: ScoreResult;
}

export interface CompetitorData {
  name: string;
  address: string;
  keywords: string[];
  reviewCount: number;
  photoCount: number;

  // ✅ 추가(옵션)
  menuCount?: number;
}

export interface DiagnosisReport {
  placeData: PlaceData;
  scores: CategoryScores;
  totalScore: number;
  totalGrade: 'S' | 'A' | 'B' | 'C' | 'D' | 'F';
  isPaid: boolean;
  improvements?: {
    description?: string;
    directions?: string;
    keywords?: string[];
    reviewGuidance?: string;
    photoGuidance?: string;

    // ✅ 추가(원하면 유료에만 가이드 노출 가능)
    priceGuidance?: string;
  };
  competitors?: CompetitorData[];
  recommendedKeywords?: string[];
}
