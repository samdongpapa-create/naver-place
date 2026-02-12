import { chromium, Browser, Page } from 'playwright';
import { PlaceData } from '../types';

export class NaverPlaceCrawler {
  private browser: Browser | null = null;

  async initialize(): Promise<void> {
    this.browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
  }

  async close(): Promise<void> {
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }

  async enrichPlace(placeUrl: string): Promise<PlaceData> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();
    
    try {
      console.log('페이지 로딩 중...');
      await page.goto(placeUrl, { 
        waitUntil: 'load',
        timeout: 60000 
      });

      // 충분한 로딩 대기
      await page.waitForTimeout(5000);

      // iframe 대기 (타임아웃 증가)
      console.log('iframe 대기 중...');
      try {
        await page.waitForSelector('iframe#entryIframe', { 
          timeout: 30000,
          state: 'attached'
        });
      } catch (e) {
        console.error('iframe 찾기 실패');
        throw new Error('네이버 플레이스 페이지를 찾을 수 없습니다. URL을 확인해주세요.');
      }

      const frameElement = await page.$('iframe#entryIframe');
      if (!frameElement) {
        throw new Error('iframe을 찾을 수 없습니다');
      }

      const frame = await frameElement.contentFrame();
      if (!frame) {
        throw new Error('iframe 콘텐츠에 접근할 수 없습니다');
      }

      console.log('iframe 로드 완료, 데이터 추출 시작');
      await page.waitForTimeout(3000);

      // 플레이스명 추출
      let name = '';
      const nameSelectors = [
        '.Fc1rA',
        '.GHAhO', 
        'span.Fc1rA', 
        'div.Fc1rA',
        'h1',
        '.place_detail_header h1'
      ];
      
      for (const selector of nameSelectors) {
        try {
          const element = await frame.$(selector);
          if (element) {
            const text = await element.textContent();
            if (text && text.trim().length > 0) {
              name = text.trim();
              console.log('플레이스명:', name);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }

      // 주소 추출
      let address = '';
      const addressSelectors = [
        '.LDgIH',
        '.IH3UA', 
        'span.LDgIH',
        '.place_detail_address'
      ];
      
      for (const selector of addressSelectors) {
        try {
          const element = await frame.$(selector);
          if (element) {
            const text = await element.textContent();
            if (text && text.trim().length > 0) {
              address = text.trim();
              console.log('주소:', address);
              break;
            }
          }
        } catch (e) {
          continue;
        }
      }

      // 리뷰/사진 탭으로 이동하여 정확한 수 가져오기
      let reviewCount = 0;
      let photoCount = 0;

      try {
        // 페이지 소스에서 직접 추출 시도
        const pageContent = await frame.content();
        
        // 리뷰 수 추출
        const reviewMatches = pageContent.match(/방문자리뷰\s*(\d+)/i) || 
                             pageContent.match(/리뷰\s*(\d+)/i) ||
                             pageContent.match(/"reviewCount["\s:]+(\d+)/i);
        if (reviewMatches && reviewMatches[1]) {
          reviewCount = parseInt(reviewMatches[1]);
          console.log('리뷰 수:', reviewCount);
        }

        // 사진 수 추출
        const photoMatches = pageContent.match(/사진\s*(\d+)/i) ||
                            pageContent.match(/"photoCount["\s:]+(\d+)/i);
        if (photoMatches && photoMatches[1]) {
          photoCount = parseInt(photoMatches[1]);
          console.log('사진 수:', photoCount);
        }
      } catch (e) {
        console.log('리뷰/사진 수 추출 중 오류:', e);
      }

      // 상세정보 탭 클릭
      console.log('상세정보 탭 찾는 중...');
      let description = '';
      
      try {
        // 홈/상세정보 탭 클릭 시도
        const homeTabs = [
          'a:has-text("홈")',
          'button:has-text("홈")',
          'a:has-text("상세정보")',
          'span:has-text("홈")',
        ];
        
        for (const tabSelector of homeTabs) {
          try {
            const tab = await frame.$(tabSelector);
            if (tab) {
              await tab.click();
              await page.waitForTimeout(2000);
              console.log('홈 탭 클릭 완료');
              break;
            }
          } catch (e) {
            continue;
          }
        }

        // 상세설명 더보기 버튼 클릭
        const moreButtonSelectors = [
          'a.zuyEj:has-text("더보기")',
          'button:has-text("더보기")',
          '.zuyEj',
          'a[class*="more"]'
        ];

        for (const btnSelector of moreButtonSelectors) {
          try {
            const elements = await frame.$$(btnSelector);
            for (const btn of elements) {
              const text = await btn.textContent();
              if (text && text.includes('더보기')) {
                await btn.click();
                await page.waitForTimeout(1500);
                console.log('더보기 버튼 클릭 완료');
              }
            }
          } catch (e) {
            continue;
          }
        }

        // 상세설명 텍스트 추출
        const descSelectors = [
          '.zPfVt',
          '.vV_z_',
          '.place_detail_introduction',
          'div[class*="introduction"]'
        ];
        
        for (const selector of descSelectors) {
          try {
            const element = await frame.$(selector);
            if (element) {
              const text = await element.textContent();
              if (text && text.trim().length > 10) {
                description = text.trim();
                console.log('상세설명 길이:', description.length);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.log('상세설명 추출 실패:', e);
      }

      // 오시는길 정보 추출
      console.log('오시는길 정보 찾는 중...');
      let directions = '';
      
      try {
        // 오시는길 탭 클릭
        const wayTabs = [
          'a:has-text("오시는길")',
          'button:has-text("오시는길")',
          'span:has-text("오시는길")',
        ];
        
        for (const tabSelector of wayTabs) {
          try {
            const tab = await frame.$(tabSelector);
            if (tab) {
              await tab.click();
              await page.waitForTimeout(2000);
              console.log('오시는길 탭 클릭 완료');
              break;
            }
          } catch (e) {
            continue;
          }
        }

        // 더보기 버튼 클릭
        const wayMoreButtons = [
          'a.zuyEj:has-text("더보기")',
          'button:has-text("더보기")',
        ];

        for (const btnSelector of wayMoreButtons) {
          try {
            const elements = await frame.$$(btnSelector);
            for (const btn of elements) {
              const text = await btn.textContent();
              if (text && text.includes('더보기')) {
                await btn.click();
                await page.waitForTimeout(1500);
                console.log('오시는길 더보기 클릭 완료');
              }
            }
          } catch (e) {
            continue;
          }
        }

        // 오시는길 텍스트 추출
        const directionSelectors = [
          '.vV_z_',
          '.way_description',
          'div[class*="way"]',
          'div[class*="direction"]'
        ];
        
        for (const selector of directionSelectors) {
          try {
            const element = await frame.$(selector);
            if (element) {
              const text = await element.textContent();
              if (text && text.trim().length > 10) {
                directions = text.trim();
                console.log('오시는길 길이:', directions.length);
                break;
              }
            }
          } catch (e) {
            continue;
          }
        }
      } catch (e) {
        console.log('오시는길 추출 실패:', e);
      }

      // 대표키워드 추출
      console.log('대표키워드 추출 중...');
      const keywords = await this.extractKeywords(page);
      console.log('추출된 키워드:', keywords);

      await page.close();

      const result = {
        name: name.trim(),
        address: address.trim(),
        reviewCount,
        photoCount,
        description: description.trim(),
        directions: directions.trim(),
        keywords
      };

      console.log('최종 결과:', result);
      return result;

    } catch (error) {
      await page.close();
      console.error('크롤링 오류:', error);
      throw new Error(`플레이스 정보 추출 실패: ${error}`);
    }
  }

  private async extractKeywords(page: Page): Promise<string[]> {
    try {
      // 페이지 소스에서 keywordList 찾기
      const content = await page.content();
      
      // keywordList 패턴 찾기
      const keywordMatch = content.match(/"keywordList":\[(.*?)\]/);
      
      if (keywordMatch && keywordMatch[1]) {
        // JSON 문자열에서 키워드 추출
        const keywordsJson = keywordMatch[1];
        const keywords = keywordsJson.match(/"text":"([^"]+)"/g);
        
        if (keywords) {
          return keywords
            .map(k => k.match(/"text":"([^"]+)"/)?.[1] || '')
            .filter(k => k.length > 0)
            .slice(0, 5); // 상위 5개만
        }
      }

      return [];
    } catch (error) {
      console.error('키워드 추출 실패:', error);
      return [];
    }
  }

  async searchCompetitors(query: string, count: number = 5): Promise<PlaceData[]> {
    if (!this.browser) {
      await this.initialize();
    }

    const page = await this.browser!.newPage();
    const competitors: PlaceData[] = [];

    try {
      // 네이버 플레이스 검색
      const searchUrl = `https://m.place.naver.com/search?query=${encodeURIComponent(query)}`;
      await page.goto(searchUrl, { 
        waitUntil: 'domcontentloaded', 
        timeout: 60000 
      });

      // 페이지 로딩 대기
      await page.waitForTimeout(3000);

      // 검색 결과에서 상위 업체 추출
      const placeLinks = await page.$$('a[href*="/place/"]');
      
      console.log(`검색 결과: ${placeLinks.length}개 발견`);
      
      for (let i = 0; i < Math.min(count, placeLinks.length); i++) {
        try {
          const href = await placeLinks[i].getAttribute('href');
          if (href) {
            const fullUrl = href.startsWith('http') ? href : `https://m.place.naver.com${href}`;
            console.log(`경쟁사 ${i + 1} 크롤링 중: ${fullUrl}`);
            const placeData = await this.enrichPlace(fullUrl);
            competitors.push(placeData);
            
            // 과도한 요청 방지
            await page.waitForTimeout(1000);
          }
        } catch (e) {
          console.log(`경쟁사 ${i + 1} 추출 실패:`, e);
        }
      }

      await page.close();
      return competitors;

    } catch (error) {
      await page.close();
      throw new Error(`경쟁사 검색 실패: ${error}`);
    }
  }
}
