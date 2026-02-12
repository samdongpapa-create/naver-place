/**
 * 네이버 플레이스 URL을 모바일 버전으로 변환
 */
export function convertToMobileUrl(url: string): string {
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

/**
 * 네이버 플레이스 URL 검증
 */
export function isValidPlaceUrl(url: string): boolean {
  try {
    const urlObj = new URL(url);
    
    // 허용되는 호스트
    const validHosts = [
      'm.place.naver.com',
      'place.naver.com',
      'map.naver.com',
      'naver.me'
    ];
    
    if (!validHosts.includes(urlObj.hostname)) {
      return false;
    }
    
    // place ID가 포함되어 있는지 확인 (7자리 이상 숫자)
    return /\d{7,}/.test(url);
  } catch (error) {
    return false;
  }
}

/**
 * URL에서 Place ID 추출
 */
export function extractPlaceId(url: string): string | null {
  // 여러 패턴 시도
  const patterns = [
    /\/entry\/place\/(\d+)/,
    /place\.naver\.com\/[^/]+\/(\d+)/,
    /m\.place\.naver\.com\/[^/]+\/(\d+)/,
    /[?&]place=(\d+)/,
    /(\d{7,})/
  ];
  
  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  return null;
}
