// URL 변환 테스트
function convertToMobileUrl(url) {
  try {
    const urlObj = new URL(url);
    
    // 이미 모바일 URL인 경우
    if (urlObj.hostname === 'm.place.naver.com') {
      return url;
    }
    
    // place ID 추출 시도
    let placeId = null;
    
    // 1. map.naver.com/p/entry/place/1234567 형식
    const entryMatch = url.match(/\/entry\/place\/(\d+)/);
    if (entryMatch && entryMatch[1]) {
      placeId = entryMatch[1];
    }
    
    // 2. place.naver.com/restaurant/1234567 형식
    if (!placeId) {
      const placeMatch = url.match(/place\.naver\.com\/[^/]+\/(\d+)/);
      if (placeMatch && placeMatch[1]) {
        placeId = placeMatch[1];
      }
    }
    
    // 3. map.naver.com?place=1234567 형식
    if (!placeId) {
      const paramMatch = url.match(/[?&]place=(\d+)/);
      if (paramMatch && paramMatch[1]) {
        placeId = paramMatch[1];
      }
    }
    
    // 4. 일반적인 숫자 추출
    if (!placeId) {
      const numberMatch = url.match(/(\d{7,})/);
      if (numberMatch && numberMatch[1]) {
        placeId = numberMatch[1];
      }
    }
    
    if (placeId) {
      return `https://m.place.naver.com/place/${placeId}`;
    }
    
    return url;
  } catch (error) {
    return url;
  }
}

// 테스트
const testUrl = 'https://map.naver.com/p/entry/place/1443688242';
const converted = convertToMobileUrl(testUrl);

console.log('원본 URL:', testUrl);
console.log('변환된 URL:', converted);
console.log('예상 결과:', 'https://m.place.naver.com/place/1443688242');
console.log('일치 여부:', converted === 'https://m.place.naver.com/place/1443688242');
