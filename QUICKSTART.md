# 🚀 빠른 시작 가이드

## Railway 배포 (권장)

### 1단계: GitHub에 코드 업로드

```bash
# 저장소 초기화
cd naver-place-optimizer
git init
git add .
git commit -m "Initial commit"

# GitHub 원격 저장소 연결
git remote add origin https://github.com/your-username/naver-place-optimizer.git
git push -u origin main
```

### 2단계: Railway 배포

1. [Railway](https://railway.app) 접속 및 로그인
2. "New Project" 클릭
3. "Deploy from GitHub repo" 선택
4. 저장소 선택: `naver-place-optimizer`
5. 자동 배포 시작 (약 5-10분 소요)
6. 배포 완료 후 제공되는 URL로 접속

### Railway 환경 변수 설정

Railway 대시보드 → Settings → Variables에서:
- `NODE_ENV`: `production`
- (PORT는 자동 설정됨)

---

## 로컬 실행 (개발/테스트용)

### 사전 요구사항
- Node.js 18 이상
- npm

### 실행 방법

```bash
# 1. 프로젝트 디렉토리 이동
cd naver-place-optimizer

# 2. 의존성 설치
npm install

# 3. Playwright 브라우저 설치
npx playwright install chromium --with-deps

# 4. 개발 서버 실행
npm run dev

# 5. 브라우저에서 접속
# http://localhost:3000
```

---

## 사용 방법

### 무료 진단
1. 네이버 플레이스 URL 입력
   - 예: `https://m.place.naver.com/restaurant/1234567890`
2. "무료 진단 시작" 버튼 클릭
3. 결과 확인 (10-30초 소요)

### 유료 진단
1. 네이버 플레이스 URL 입력
2. 경쟁사 검색어 입력 (예: "강남 카페")
3. "유료 진단" 버튼 클릭
4. 상세 개선안 및 경쟁사 분석 확인

---

## 문제 해결

### Playwright 설치 오류
```bash
# 시스템 의존성 설치 (Ubuntu/Debian)
sudo npx playwright install-deps chromium

# macOS
brew install playwright
```

### 메모리 부족 오류
Railway Free Tier는 512MB RAM 제공
→ 프로 플랜 업그레이드 권장 (크롤링 안정성 향상)

### 크롤링 실패
- 네이버 플레이스 URL 형식 확인
- 모바일 URL 사용 권장: `m.place.naver.com`
- 페이지 로딩 시간 고려 (느린 연결 시 타임아웃 가능)

---

## 프로젝트 구조

```
naver-place-optimizer/
├── src/
│   ├── types/index.ts          # 타입 정의
│   ├── services/
│   │   ├── enrichPlace.ts      # 네이버 플레이스 크롤링
│   │   └── diagnosis.ts        # 진단 로직
│   └── server.ts               # Express 서버
├── public/                     # 프론트엔드
│   ├── index.html
│   ├── styles.css
│   └── script.js
└── README.md
```

---

## 다음 단계

- [ ] 결제 시스템 통합 (Stripe, Toss Payments)
- [ ] 사용자 인증 (JWT, OAuth)
- [ ] 진단 기록 저장 (DB 연동)
- [ ] 대시보드 추가
- [ ] PDF 리포트 다운로드 기능

---

## 지원

문제 발생 시 GitHub Issues에 제보해주세요!
