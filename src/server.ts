import express from 'express';
import cors from 'cors';
import path from 'path';
import { ModularCrawler } from './services/modularCrawler';
import { convertToMobileUrl, isValidPlaceUrl } from './utils/urlHelper';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ✅ public 폴더 정적 서빙 (로컬 dev/배포 start 둘 다 동작)
const publicDir = path.join(__dirname, '../public');
app.use(express.static(publicDir));

// ✅ 헬스체크(레일웨이 확인용)
app.get('/health', (_req, res) => res.status(200).send('ok'));

// ✅ 홈(/)은 index.html 내려주기
app.get('/', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

app.post('/api/diagnose/free', async (req, res) => {
  try {
    const { placeUrl } = req.body;

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: '유효한 네이버 플레이스 URL이 아닙니다.'
      });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);

    const crawler = new ModularCrawler();
    const result = await crawler.crawlPlace(mobileUrl);

    return res.json({
      success: true,
      data: result
    });
  } catch (error: any) {
    console.error('free diagnose 오류:', error);
    return res.status(500).json({
      success: false,
      message: '진단 중 오류 발생'
    });
  }
});

app.post('/api/diagnose/paid', async (req, res) => {
  try {
    const { placeUrl } = req.body;

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: '유효한 네이버 플레이스 URL이 아닙니다.'
      });
    }

    const mobileUrl = convertToMobileUrl(placeUrl);

    const crawler = new ModularCrawler();
    const basicData = await crawler.crawlPlace(mobileUrl);

    // 경쟁사 분석은 추후 추가
    const competitorAnalysis = { status: '준비중' };

    return res.json({
      success: true,
      data: {
        basicData,
        competitorAnalysis
      }
    });
  } catch (error: any) {
    console.error('paid diagnose 오류:', error);
    return res.status(500).json({
      success: false,
      message: '유료 진단 중 오류 발생'
    });
  }
});

// ✅ 혹시 모르는 404에서 프론트로 보내기(단, /api 제외)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    return res.status(404).json({ success: false, message: 'Not Found' });
  }
  return res.sendFile(path.join(publicDir, 'index.html'));
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
