import { Industry } from "./types";

export type IndustryScoringConfig = {
  weights: {
    description: number; // 합이 100 되게 권장
    directions: number;
    keywords: number;
    reviews: number;
    photos: number;
    menu: number;
  };

  // 상세설명
  description: {
    minLen: number;          // 최소 권장 글자수
    goodLen: number;         // 만점 기준 글자수
    keywordBoost: number;    // 키워드 포함 가산(최대)
  };

  // 오시는길
  directions: {
    minLen: number;
    goodLen: number;
    requireSignals: string[]; // 포함되면 가산점 주는 신호 단어들
  };

  // 대표키워드
  keywords: {
    targetCount: number; // 보통 5
    stopWords: string[]; // 너무 일반적인 단어 감점
  };

  // 리뷰
  reviews: {
    targetCount: number;      // 업종별 “강한 신뢰” 기준
    recentWeight: number;     // 최근성 가중(0~1)
  };

  // 사진
  photos: {
    targetCount: number;
  };

  // 메뉴/가격
  menu: {
    allowInquiryRatio: number; // "문의/변동" 허용 비율 (0~1)
    strictPriceLabel: boolean; // 식당은 true (정가표기 엄격)
  };
};

export const SCORING_BY_INDUSTRY: Record<Industry, IndustryScoringConfig> = {
  hairshop: {
    weights: { description: 22, directions: 18, keywords: 15, reviews: 25, photos: 12, menu: 8 },
    description: { minLen: 80, goodLen: 250, keywordBoost: 6 },
    directions: {
      minLen: 60, goodLen: 180,
      requireSignals: ["역", "출구", "도보", "분", "주차", "건물", "층", "엘리베이터", "정문", "후문"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["추천", "잘하는", "유명", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 800, recentWeight: 0.45 },
    photos: { targetCount: 120 },
    menu: { allowInquiryRatio: 0.6, strictPriceLabel: false }
  },

  cafe: {
    weights: { description: 20, directions: 18, keywords: 15, reviews: 27, photos: 12, menu: 8 },
    description: { minLen: 70, goodLen: 220, keywordBoost: 6 },
    directions: {
      minLen: 60, goodLen: 170,
      requireSignals: ["역", "출구", "도보", "분", "주차", "골목", "코너", "건물", "층"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["맛집", "핫플", "인생", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 600, recentWeight: 0.5 },
    photos: { targetCount: 150 },
    menu: { allowInquiryRatio: 0.35, strictPriceLabel: true }
  },

  restaurant: {
    weights: { description: 18, directions: 17, keywords: 14, reviews: 30, photos: 12, menu: 9 },
    description: { minLen: 70, goodLen: 220, keywordBoost: 5 },
    directions: {
      minLen: 60, goodLen: 170,
      requireSignals: ["역", "출구", "도보", "분", "주차", "골목", "코너", "건물", "층"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["맛집", "핫플", "인생", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 1200, recentWeight: 0.55 },
    photos: { targetCount: 200 },
    menu: { allowInquiryRatio: 0.15, strictPriceLabel: true }
  },
};
