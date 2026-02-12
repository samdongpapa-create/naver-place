# 네이버 플레이스 최적화 진단 SaaS

네이버 플레이스 정보를 자동으로 분석하여 최적화 점수를 제공하는 서비스입니다.

## 🎯 주요 기능

### 무료 버전
- 플레이스 정보 자동 수집 (이름, 주소, 리뷰 수, 사진 수, 상세설명, 오시는길, 대표키워드)
- 5개 항목별 점수 및 등급 제공
  - 상세설명
  - 오시는길
  - 대표키워드
  - 리뷰
  - 사진
- 항목별 문제점 요약
- 유료 기능 미리보기 (블러 처리)

### 유료 버전 (₩9,900)
- 모든 무료 기능 포함
- 즉시 사용 가능한 개선안 제공
  - 상세설명 템플릿 (복사-붙여넣기)
  - 오시는길 템플릿
  - 리뷰 유도 가이드
  - 사진 촬영 가이드
- 경쟁업체 Top 5 분석
- 경쟁사 대표키워드 5개 + 추천키워드 5개

## 🛠️ 기술 스택

- **Backend**: Node.js, TypeScript, Express
- **Crawler**: Playwright
- **Deployment**: Railway
- **Frontend**: Vanilla JavaScript, HTML, CSS

## 📦 설치 및 실행

### 로컬 개발

```bash
# 의존성 설치
npm install

# Playwright 브라우저 설치
npx playwright install chromium --with-deps

# 개발 서버 실행
npm run dev
```

### 프로덕션 빌드

```bash
# 빌드
npm run build

# 서버 실행
npm start
```

## 🚀 Railway 배포

1. GitHub 저장소에 코드 푸시
2. Railway 프로젝트 생성
3. GitHub 연동
4. 자동 배포 완료

### 환경 변수 설정 (Railway)

Railway 대시보드에서 설정:
- `PORT`: 자동 설정됨 (Railway가 자동 할당)
- `NODE_ENV`: `production`

## 📝 사용 방법

이제 다양한 URL 형식을 지원합니다:

```
✅ https://m.place.naver.com/restaurant/1234567890
✅ https://place.naver.com/restaurant/1234567890
✅ https://map.naver.com/v5/entry/place/1234567890
✅ https://map.naver.com/p/entry/place/1443688242  ← 이런 형식도 OK!
✅ https://naver.me/xxxxx (단축 URL)
```

**실제 테스트 URL:**
```
https://map.naver.com/p/entry/place/1443688242
→ 자동 변환: https://m.place.naver.com/place/1443688242
```

```
naver-place-optimizer/
├── src/
│   ├── types/
│   │   └── index.ts          # TypeScript 타입 정의
│   ├── services/
│   │   ├── enrichPlace.ts    # 네이버 플레이스 크롤링
│   │   └── diagnosis.ts      # 진단 및 점수 계산
│   └── server.ts             # Express 서버
├── public/
│   ├── index.html            # 메인 UI
│   ├── styles.css            # 스타일
│   └── script.js             # 프론트엔드 로직
├── dist/                     # 빌드 결과물
├── package.json
├── tsconfig.json
├── railway.json              # Railway 설정
└── nixpacks.toml            # Nixpacks 설정
```

## 🔍 API 엔드포인트

### `POST /api/diagnose/free`
무료 진단 실행

**Request Body:**
```json
{
  "placeUrl": "https://m.place.naver.com/..."
}
```

### `POST /api/diagnose/paid`
유료 진단 실행 (경쟁사 분석 포함)

**Request Body:**
```json
{
  "placeUrl": "https://m.place.naver.com/...",
  "searchQuery": "강남 카페"
}
```

## 🎨 UI 특징

- 깔끔한 리포트 형식
- 직관적인 점수 및 등급 표시
- 항목별 상세 분석
- 복사-붙여넣기 가능한 개선안
- 반응형 디자인

## ⚠️ 주의사항

1. **크롤링 속도**: 네이버 플레이스 페이지 로딩 시간에 따라 진단에 10-30초 소요
2. **브라우저 리소스**: Playwright Chromium이 메모리를 사용하므로 서버 리소스 고려 필요
3. **URL 형식**: 네이버 플레이스 모바일 URL (`m.place.naver.com`) 사용 권장

## 📝 라이선스

MIT License

## 🤝 기여

이슈 및 PR 환영합니다!
