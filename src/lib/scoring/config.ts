import { Industry } from "./types";

export type IndustryConfig = {
  weights: {
    description: number; // 합 100
    directions: number;
    keywords: number;
    reviews: number;
    photos: number;
    price: number;
  };

  description: {
    minLen: number;
    goodLen: number;
    // 대표키워드가 본문에 포함되면 가산(최대)
    keywordBoostMax: number;
  };

  directions: {
    minLen: number;
    goodLen: number;
    signals: string[]; // 포함되면 점수 가산
  };

  keywords: {
    targetCount: number; // 5
    stopWords: string[]; // 너무 일반적인 단어 감점
  };

  reviews: {
    targetCount: number; // 업종별 목표치
    // 최근성 반영 비율 (0~1)
    recentWeight: number;
  };

  photos: {
    targetCount: number;
  };

  price: {
    allowInquiryRatio: number; // "문의/변동/협의" 허용 비율 (미용실 높음, 식당 낮음)
    strictPriceLabel: boolean; // 식당 true (정가표기 엄격)
  };
};

export const CONFIG: Record<Industry, IndustryConfig> = {
  hairshop: {
    weights: { description: 22, directions: 18, keywords: 15, reviews: 25, photos: 12, price: 8 },
    description: { minLen: 80, goodLen: 250, keywordBoostMax: 12 },
    directions: {
      minLen: 60,
      goodLen: 180,
      signals: ["역", "출구", "도보", "분", "주차", "건물", "층", "엘리베이터", "정문", "후문"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["추천", "잘하는", "유명", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 800, recentWeight: 0.45 },
    photos: { targetCount: 120 },
    // ✅ 미용실은 ‘문의’ 허용 높게
    price: { allowInquiryRatio: 0.6, strictPriceLabel: false }
  },

  cafe: {
    weights: { description: 20, directions: 18, keywords: 15, reviews: 27, photos: 12, price: 8 },
    description: { minLen: 70, goodLen: 220, keywordBoostMax: 10 },
    directions: {
      minLen: 60,
      goodLen: 170,
      signals: ["역", "출구", "도보", "분", "주차", "골목", "코너", "건물", "층"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["맛집", "핫플", "인생", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 600, recentWeight: 0.5 },
    photos: { targetCount: 150 },
    price: { allowInquiryRatio: 0.35, strictPriceLabel: true }
  },

  restaurant: {
    weights: { description: 18, directions: 17, keywords: 14, reviews: 30, photos: 12, price: 9 },
    description: { minLen: 70, goodLen: 220, keywordBoostMax: 10 },
    directions: {
      minLen: 60,
      goodLen: 170,
      signals: ["역", "출구", "도보", "분", "주차", "골목", "코너", "건물", "층"]
    },
    keywords: {
      targetCount: 5,
      stopWords: ["맛집", "핫플", "인생", "가성비", "근처", "동네"]
    },
    reviews: { targetCount: 1200, recentWeight: 0.55 },
    photos: { targetCount: 200 },
    // ✅ 식당은 가격표기 엄격 + 문의비율 낮아야 함
    price: { allowInquiryRatio: 0.15, strictPriceLabel: true }
  }
};
