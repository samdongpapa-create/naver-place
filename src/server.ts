import express from 'express';
import cors from 'cors';
import path from 'path';
import { ModularCrawler } from './services/modularCrawler';
import { convertToMobileUrl, isValidPlaceUrl } from './utils/urlHelper';
import type { PlaceData } from './types';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ public 폴더 정적 서빙
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// ✅ 헬스체크
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ✅ 홈
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

type Grade = 'A' | 'B' | 'C' | 'D' | 'F';

function gradeFromScore(score: number): Grade {
  if (score >= 90) return 'A';
  if (score >= 80) return 'B';
  if (score >= 70) return 'C';
  if (score >= 60) return 'D';
  return 'F';
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function scoreByLength(len: number, issues: string[], label: string) {
  if (!len || len <= 0) {
    issues.push(`${label}이(가) 비어있습니다.`);
    return 0;
  }
  if (len >= 300) return 100;
  if (len >= 150) {
    issues.push(`${label} 길이가 조금 짧습니다. (권장: 300자 이상)`);
    return 80;
  }
  if (len >= 60) {
    issues.push(`${label}이(가) 짧습니다. (권장: 150~300자 이상)`);
    return 60;
  }
  issues.push(`${label}이(가) 너무 짧습니다. (권장: 150자 이상)`);
  return 40;
}

function scoreByCount(
  count: number,
  issues: string[],
  label: string,
  tiers: Array<{ min: number; score: number; hint?: string }>
) {
  if (!count || count <= 0) {
    issues.push(`${label}이(가) 거의 없습니다.`);
    return 0;
  }
  for (const t of tiers) {
    if (count >= t.min) {
      if (t.hint) issues.push(t.hint);
      return t.score;
    }
  }
  return 40;
}

function buildReport(placeData: PlaceData) {
  // 카테고리별 score/grade/issues 생성
  const scores: Record<
    'description' | 'directions' | 'keywords' | 'reviews' | 'photos',
    { score: number; grade: Grade; issues: string[] }
  > = {
    description: { score: 0, grade: 'F', issues: [] },
    directions: { score: 0, grade: 'F', issues: [] },
    keywords: { score: 0, grade: 'F', issues: [] },
    reviews: { score: 0, grade: 'F', issues: [] },
    photos: { score: 0, grade: 'F', issues: [] }
  };

  // 상세설명
  const descLen = (placeData.description || '').trim().length;
  scores.description.score = scoreByLength(descLen, scores.description.issues, '상세설명');
  scores.description.grade = gradeFromScore(scores.description.score);

  // 오시는길
  const dirLen = (placeData.directions || '').trim().length;
  scores.directions.score = scoreByLength(dirLen, scores.directions.issues, '오시는길');
  scores.directions.grade = gradeFromScore(scores.directions.score);

  // 대표키워드 (최대 5개 입력 기준)
  const kwCount = (placeData.keywords || []).length;
  if (kwCount >= 5) {
    scores.keywords.score = 100;
  } else if (kwCount >= 3) {
    scores.keywords.score = 80;
    scores.keywords.issues.push('대표키워드를 5개까지 채우면 노출에 더 유리합니다.');
  } else if (kwCount >= 1) {
    scores.keywords.score = 50;
    scores.keywords.issues.push('대표키워드가 부족합니다. (권장: 5개)');
  } else {
    scores.keywords.score = 0;
    scores.keywords.issues.push('대표키워드가 설정되어 있지 않거나 추출에 실패했습니다.');
  }
  scores.keywords.grade = gradeFromScore(scores.keywords.score);

  // 리뷰 수
  const reviewCount = placeData.reviewCount || 0;
  scores.reviews.score = scoreByCount(reviewCount, scores.reviews.issues, '리뷰', [
    { min: 2000, score: 100 },
    { min: 500, score: 90 },
    { min: 100, score: 80, hint: '리뷰를 꾸준히 누적하면 신뢰도/전환에 도움됩니다.' },
    { min: 30, score: 70, hint: '리뷰가 더 필요합니다. (권장: 100개 이상)' },
    { min: 10, score: 60, hint: '리뷰가 적은 편입니다. (권장: 30개 이상)' },
    { min: 1, score: 40, hint: '리뷰가 매우 적습니다. (권장: 10개 이상)' }
  ]);
  scores.reviews.grade = gradeFromScore(scores.reviews.score);

  // 사진 수
  const photoCount = placeData.photoCount || 0;
  scores.photos.score = scoreByCount(photoCount, scores.photos.issues, '사진', [
    { min: 2000, score: 100 },
    { min: 500, score: 90 },
    { min: 200, score: 80, hint: '사진이 충분하면 방문 결정에 도움이 됩니다.' },
    { min: 50, score: 70, hint: '사진을 더 추가하면 전환에 유리합니다. (권장: 200장 이상)' },
    { min: 20, score: 60, hint: '사진이 적은 편입니다. (권장: 50장 이상)' },
    { min: 1, score: 40, hint: '사진이 매우 적습니다. (권장: 20장 이상)' }
  ]);
  scores.photos.grade = gradeFromScore(scores.photos.score);

  const totalScoreRaw =
    (scores.description.score +
      scores.directions.score +
      scores.keywords.score +
      scores.reviews.score +
      scores.photos.score) /
    5;

  const totalScore = Math.round(clamp(totalScoreRaw, 0, 100));
  const totalGrade = gradeFromScore(totalScore);

  return {
    placeData,
    totalScore,
    totalGrade,
    scores
  };
}

app.post('/api/diagnose/free', async (req, res) => {
  try {
    const { placeUrl } = req.body;

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: '유효한 네이버 플레이스 URL이 아닙니다.',
        logs: []
      });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);

    const crawler = new ModularCrawler();
    const crawl = await crawler.crawlPlace(mobileUrl);

    // ✅ 실패해도 logs는 내려줘서 프론트에서 디버그 섹션이 보이게
    if (!crawl.success || !crawl.data) {
      return res.status(500).json({
        success: false,
        message: crawl.error || '크롤링 실패',
        logs: crawl.logs || []
      });
    }

    const report = buildReport(crawl.data);

    return res.json({
      success: true,
      data: report,         // ✅ 프론트가 기대하는 구조
      logs: crawl.logs || [] // ✅ debug 로그
    });
  } catch (error: any) {
    console.error('free diagnose 오류:', error);
    return res.status(500).json({
      success: false,
      message: '진단 중 오류 발생',
      logs: [String(error?.message || error)]
    });
  }
});

app.post('/api/diagnose/paid', async (req, res) => {
  try {
    const { placeUrl } = req.body;

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: '유효한 네이버 플레이스 URL이 아닙니다.',
        logs: []
      });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);

    const crawler = new ModularCrawler();
    const crawl = await crawler.crawlPlace(mobileUrl);

    if (!crawl.success || !crawl.data) {
      return res.status(500).json({
        success: false,
        message: crawl.error || '크롤링 실패',
        logs: crawl.logs || []
      });
    }

    const report = buildReport(crawl.data);

    // 유료 확장(지금은 준비중)
    return res.json({
      success: true,
      data: {
        ...report,
        improvements: null,
        competitors: null,
        recommendedKeywords: null
      },
      logs: crawl.logs || []
    });
  } catch (error: any) {
    console.error('paid diagnose 오류:', error);
    return res.status(500).json({
      success: false,
      message: '유료 진단 중 오류 발생',
      logs: [String(error?.message || error)]
    });
  }
});

// ✅ /api 제외한 나머지는 프론트로
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'Not Found' });
  }
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
