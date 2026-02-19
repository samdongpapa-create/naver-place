export type Industry = "hairshop" | "cafe" | "restaurant";

export type Grade = "S" | "A" | "B" | "C" | "D";

export type ScoreBreakdown = {
  total: number; // 0~100
  grade: Grade;
  parts: Record<string, {
    score: number;     // 0~partMax
    max: number;       // partMax
    notes: string[];   // 감점/가점 사유
  }>;
  notes: string[]; // 전체 코멘트
};

export type PlaceAuditInput = {
  industry: Industry;

  // 사용자가 입력(또는 크롤링된 값)
  description?: string;   // 상세설명
  directions?: string;    // 오시는길
  keywords?: string[];    // 대표키워드 (최대 5)
  reviewCount?: number;   // 방문자리뷰(총)
  blogReviewCount?: number;
  recentReviewCount30d?: number; // 30일 이내 리뷰 수 (없으면 undefined)
  photoCount?: number;

  // 가격/메뉴 정보(가능한 만큼)
  menuItems?: Array<{
    name: string;
    priceText?: string;  // "30,000원" / "문의" / "변동" 등
  }>;
};
