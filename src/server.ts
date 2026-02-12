// src/server.ts
import express from 'express';
import cors from 'cors';
import { ModularCrawler } from './services/modularCrawler';
import { convertToMobileUrl, isValidPlaceUrl } from './utils/urlHelper';

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.post('/api/diagnose/free', async (req, res) => {
  try {
    const { placeUrl } = req.body;

    if (!placeUrl || !isValidPlaceUrl(placeUrl)) {
      return res.status(400).json({
        success: false,
        message: '유효한 네이버 플레이스 URL이 아닙니다.'
      });
    }

    console.log('=== 1단계: URL 변환 ===');
    const mobileUrl = convertToMobileUrl(placeUrl);
    console.log('모바일 URL:', mobileUrl);

    const crawler = new ModularCrawler();

    const result = await crawler.crawlPlace(mobileUrl);

    res.json({
      success: true,
      data: result
    });

  } catch (error) {
    console.error('free diagnose 오류:', error);
    res.status(500).json({
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

    console.log('=== 유료 진단 시작 ===');

    const mobileUrl = convertToMobileUrl(placeUrl);

    const crawler = new ModularCrawler();
    const basicData = await crawler.crawlPlace(mobileUrl);

    // 🔥 경쟁사 분석은 추후 추가 예정
    const competitorAnalysis = {
      status: '준비중'
    };

    res.json({
      success: true,
      data: {
        basicData,
        competitorAnalysis
      }
    });

  } catch (error) {
    console.error('paid diagnose 오류:', error);
    res.status(500).json({
      success: false,
      message: '유료 진단 중 오류 발생'
    });
  }
});

app.listen(port, () => {
  console.log(`🚀 Server running on port ${port}`);
});
