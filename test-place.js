import { chromium } from 'playwright';

async function testNaverPlace() {
  console.log('🚀 네이버 플레이스 구조 테스트 시작\n');
  
  const browser = await chromium.launch({ headless: false }); // 브라우저 보기
  const page = await browser.newPage();
  
  // 테스트할 URL (예시)
  const testUrl = process.argv[2] || 'https://m.place.naver.com/restaurant/1057854280';
  
  console.log('📍 테스트 URL:', testUrl);
  
  try {
    console.log('\n1. 페이지 로딩...');
    await page.goto(testUrl, { waitUntil: 'load', timeout: 60000 });
    await page.waitForTimeout(5000);
    
    console.log('2. iframe 확인...');
    const iframes = await page.$$('iframe');
    console.log(`   - iframe 개수: ${iframes.length}`);
    
    for (let i = 0; i < iframes.length; i++) {
      const id = await iframes[i].getAttribute('id');
      const src = await iframes[i].getAttribute('src');
      console.log(`   - iframe[${i}]: id="${id}", src="${src?.substring(0, 50)}..."`);
    }
    
    // entryIframe 확인
    const entryIframe = await page.$('iframe#entryIframe');
    if (entryIframe) {
      console.log('✅ iframe#entryIframe 찾음');
      
      const frame = await entryIframe.contentFrame();
      if (frame) {
        console.log('✅ iframe 콘텐츠 접근 성공');
        
        console.log('\n3. 페이지 내용 확인...');
        const html = await frame.content();
        console.log(`   - HTML 길이: ${html.length} 바이트`);
        
        // 주요 클래스 확인
        const selectors = [
          '.Fc1rA',
          '.GHAhO',
          '.LDgIH',
          '.IH3UA',
          'h1',
          'span[class*="name"]',
          'div[class*="title"]'
        ];
        
        console.log('\n4. 셀렉터 테스트...');
        for (const selector of selectors) {
          const element = await frame.$(selector);
          if (element) {
            const text = await element.textContent();
            console.log(`   ✅ ${selector}: "${text?.substring(0, 50)}"`);
          } else {
            console.log(`   ❌ ${selector}: 찾을 수 없음`);
          }
        }
        
        // 전체 텍스트 출력
        console.log('\n5. 전체 body 텍스트 (처음 500자):');
        const bodyText = await frame.textContent('body');
        console.log(bodyText?.substring(0, 500));
        
      } else {
        console.log('❌ iframe 콘텐츠 접근 실패');
      }
    } else {
      console.log('❌ iframe#entryIframe 찾을 수 없음');
      
      // 전체 페이지 구조 확인
      console.log('\n페이지 전체 HTML (처음 1000자):');
      const pageHtml = await page.content();
      console.log(pageHtml.substring(0, 1000));
    }
    
    console.log('\n\n⏸️  브라우저를 10초간 열어둡니다. 직접 확인하세요...');
    await page.waitForTimeout(10000);
    
  } catch (error) {
    console.error('❌ 오류 발생:', error);
  } finally {
    await browser.close();
    console.log('\n✅ 테스트 완료');
  }
}

testNaverPlace();
