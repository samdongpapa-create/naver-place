export interface PlaceData {
  name: string;
  address: string;
  reviewCount: number;
  photoCount: number;
  description: string;
  directions: string;
  keywords: string[];
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
}

export interface CompetitorData {
  name: string;
  address: string;
  keywords: string[];
  reviewCount: number;
  photoCount: number;
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
  };
  competitors?: CompetitorData[];
  recommendedKeywords?: string[];
}
