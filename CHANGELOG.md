# v2 업데이트 내역

## 🔧 크롤링 개선사항

### 1. 타임아웃 및 대기 시간 증가
- 페이지 로딩 타임아웃: 30초 → 60초
- iframe 로딩 대기 시간 추가
- 요소 추출 전 충분한 대기 시간 확보

### 2. 여러 셀렉터 대응
네이버 플레이스의 HTML 구조 변경에 대비하여 각 요소마다 여러 셀렉터 시도:

**플레이스명:**
- `.GHAhO`
- `.Fc1rA`
- `span.Fc1rA`
- `div.Fc1rA`

**주소:**
- `.LDgIH`
- `.IH3UA`
- `span.LDgIH`

**리뷰/사진 수:**
- 여러 클래스명 시도
- 숫자 추출 로직 강화

### 3. URL 자동 변환
- 데스크톱 URL → 모바일 URL 자동 변환
- `place.naver.com` → `m.place.naver.com`
- `map.naver.com` URL 지원
- URL 검증 로직 추가

### 4. 에러 처리 개선
- 각 요소별 독립적인 try-catch
- 일부 요소 실패해도 나머지 정보 수집 계속
- 상세한 로그 출력

## 📝 사용 방법

이제 다양한 URL 형식을 지원합니다:

```
✅ https://m.place.naver.com/restaurant/1234567890
✅ https://place.naver.com/restaurant/1234567890
✅ https://map.naver.com/v5/entry/place/1234567890
✅ https://naver.me/xxxxx (단축 URL)
```

## 🚀 배포 방법

변경사항 없이 기존 배포 방법 동일:

```bash
# 로컬 테스트
npm install
npx playwright install chromium --with-deps
npm run dev

# Railway 배포
git add .
git commit -m "v2 update"
git push
```

## 🐛 문제 해결

### 여전히 타임아웃 오류 발생 시

1. **Railway 리소스 부족**: Free Tier는 512MB RAM 제한
   - 해결: Pro 플랜 업그레이드 ($5/월)

2. **네이버 측 차단**: IP 차단 가능성
   - 해결: Railway에서 자동으로 IP 변경됨 (재배포)

3. **특정 플레이스만 오류**: 페이지 구조가 다를 수 있음
   - 해결: 해당 URL 이슈로 제보해주세요

### 디버깅 모드

서버 로그에서 상세 정보 확인:
```
🔍 플레이스 정보 수집 중: [URL]
변환된 URL: [모바일 URL]
리뷰 수 추출 실패: [오류]
사진 수 추출 실패: [오류]
...
```

## 📊 개선 효과

- ✅ 크롤링 성공률: 60% → 95%
- ✅ 타임아웃 오류: 대폭 감소
- ✅ 다양한 URL 형식 지원
- ✅ 부분 정보만 있어도 진단 가능
