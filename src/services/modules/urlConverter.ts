import { Page } from 'playwright';

export class UrlConverter {
  /**
   * 네이버 플레이스 URL을 모바일 버전으로 변환
   */
  static convertToMobileUrl(url: string): string {
    try {
      if (!url) return '';
      
      const urlObj = new URL(url);
      
      // 이미 모바일 URL인 경우
      if (urlObj.hostname === 'm.place.naver.com') {
        return url;
      }
      
      // place ID 추출
      let placeId = null;
      
      // 1. /entry/place/1234567 형식
      const entryMatch = url.match(/\/entry\/place\/(\d+)/);
      if (entryMatch && entryMatch[1]) {
        placeId = entryMatch[1];
      }
      
      // 2. place.naver.com/xxx/1234567
      if (!placeId) {
        const placeMatch = url.match(/place\.naver\.com\/[^/]+\/(\d+)/);
        if (placeMatch && placeMatch[1]) {
          placeId = placeMatch[1];
        }
      }
      
      // 3. ?place=1234567
      if (!placeId) {
        const paramMatch = url.match(/[?&]place=(\d+)/);
        if (paramMatch && paramMatch[1]) {
          placeId = paramMatch[1];
        }
      }
      
      // 4. 일반 숫자
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
   * URL 검증
   */
  static isValid(url: string): boolean {
    try {
      const urlObj = new URL(url);
      const validHosts = ['m.place.naver.com', 'place.naver.com', 'map.naver.com', 'naver.me'];
      return validHosts.includes(urlObj.hostname) && /\d{7,}/.test(url);
    } catch {
      return false;
    }
  }

  /**
   * Place ID 추출
   */
  static extractPlaceId(url: string): string | null {
    const patterns = [
      /\/entry\/place\/(\d+)/,
      /place\.naver\.com\/[^/]+\/(\d+)/,
      /m\.place\.naver\.com\/[^/]+\/(\d+)/,
      /[?&]place=(\d+)/,
      /(\d{7,})/
    ];
    
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) return match[1];
    }
    
    return null;
  }
}
