// API Base URL
const API_BASE = window.location.origin;

// 현재 플레이스 URL 저장
let currentPlaceUrl = '';

// (옵션) 업종 저장 (index.html에 industrySelect가 없으면 자동 hairshop)
let currentIndustry = 'hairshop';

// URL 변환 함수 (프론트엔드)
function convertToMobileUrl(url) {
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

// 섹션 표시 함수
function showSection(sectionId) {
  const sections = ['inputSection', 'loadingSection', 'reportSection', 'errorSection'];
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === sectionId ? 'block' : 'none';
  });
}

// 오류 표시
function showError(message) {
  document.getElementById('errorMessage').textContent = message;
  showSection('errorSection');
}

// 진단 초기화
function resetDiagnosis() {
  document.getElementById('placeUrl').value = '';
  currentPlaceUrl = '';
  showSection('inputSection');

  // 유료 섹션 리셋
  const upgrade = document.getElementById('upgradeSection');
  const imp = document.getElementById('improvementsSection');
  const comp = document.getElementById('competitorsSection');
  if (upgrade) upgrade.style.display = 'none';
  if (imp) {
    imp.style.display = 'none';
    imp.innerHTML = '';
  }
  if (comp) {
    comp.style.display = 'none';
    comp.innerHTML = '';
  }

  // 로그 리셋
  const debugSection = document.getElementById('debugSection');
  const debugLogs = document.getElementById('debugLogs');
  if (debugSection) debugSection.style.display = 'none';
  if (debugLogs) debugLogs.innerHTML = '';
}

// 무료 진단
async function diagnoseFree() {
  const placeUrl = document.getElementById('placeUrl').value.trim();
  const industrySel = document.getElementById('industrySelect');
  currentIndustry = industrySel ? industrySel.value : 'hairshop';

  if (!placeUrl) {
    alert('플레이스 URL을 입력해주세요');
    return;
  }

  currentPlaceUrl = placeUrl;
  showSection('loadingSection');

  try {
    const response = await fetch(`${API_BASE}/api/diagnose/free`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // ✅ industry도 함께 보내면 서버 업종별 점수에 바로 반영 가능
      body: JSON.stringify({ placeUrl, industry: currentIndustry })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      // 오류 발생 시에도 로그 표시
      if (result.logs) {
        displayLogs(result.logs);
        showSection('reportSection');
      } else {
        throw new Error(result.message || result.error || '진단 중 오류가 발생했습니다');
      }
      return;
    }

    displayReport(result.data, false);

    // 로그 표시
    if (result.logs) {
      displayLogs(result.logs);
    }
  } catch (error) {
    console.error('Error:', error);
    showError(error.message);
  }
}

// 유료 진단 모달 표시
function showPaidModal() {
  document.getElementById('paidModal').style.display = 'flex';
}

// 유료 진단 모달 닫기
function closePaidModal() {
  document.getElementById('paidModal').style.display = 'none';
}

// 유료 진단
async function diagnosePaid() {
  // ✅ 기존 UI(검색어 입력) 유지: 서버가 searchQuery를 안 쓰더라도 프론트는 그대로 보냄
  const searchQueryEl = document.getElementById('searchQuery');
  const searchQuery = searchQueryEl ? searchQueryEl.value.trim() : '';

  if (!searchQuery) {
    alert('경쟁사 분석을 위한 검색어를 입력해주세요\n(예: 강남 카페, 이태원 맛집)');
    return;
  }

  if (!currentPlaceUrl) {
    alert('플레이스 URL이 없습니다. 다시 시도해주세요.');
    closePaidModal();
    resetDiagnosis();
    return;
  }

  const industrySel = document.getElementById('industrySelect');
  currentIndustry = industrySel ? industrySel.value : (currentIndustry || 'hairshop');

  closePaidModal();
  showSection('loadingSection');

  try {
    const response = await fetch(`${API_BASE}/api/diagnose/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        placeUrl: currentPlaceUrl,
        industry: currentIndustry, // ✅ 추가
        searchQuery // ✅ 유지
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.message || result.error || '진단 중 오류가 발생했습니다');
    }

    // ✅ 유료 리포트 표시
    displayReport(result.data, true);

    // 로그 표시(유료도)
    if (result.logs) {
      displayLogs(result.logs);
    }
  } catch (error) {
    console.error('Error:', error);
    showError(error.message);
  }
}

// 리포트 표시
function displayReport(data, isPaid) {
  // 플레이스 정보
  document.getElementById('placeName').textContent = data.placeData?.name || '-';
  document.getElementById('placeAddress').textContent = data.placeData?.address || '-';

  // 총점
  document.getElementById('totalScore').textContent = data.totalScore ?? '-';
  document.getElementById('totalGrade').textContent = data.totalGrade ?? '-';

  // 총점 배지 색상
  const gradeBadge = document.getElementById('totalGradeBadge');
  gradeBadge.className = `grade-badge grade-${data.totalGrade || 'C'}`;

  // 카테고리별 점수
  displayCategoryScores(data.scores, data);

  // 무료/유료 섹션 토글
  if (!isPaid) {
    document.getElementById('upgradeSection').style.display = 'block';
    document.getElementById('improvementsSection').style.display = 'none';
    document.getElementById('competitorsSection').style.display = 'none';
  } else {
    document.getElementById('upgradeSection').style.display = 'none';

    // ✅ 유료: 개선안 (무조건 섹션 하나는 보이게)
    displayImprovementsPaid(data);
    document.getElementById('improvementsSection').style.display = 'block';

    // ✅ 유료: 경쟁사
    displayCompetitorsPaid(data);
    document.getElementById('competitorsSection').style.display = 'block';
  }

  showSection('reportSection');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// 디버그 로그 표시
function displayLogs(logs) {
  const debugSection = document.getElementById('debugSection');
  const debugLogs = document.getElementById('debugLogs');

  if (!logs || logs.length === 0) {
    debugSection.style.display = 'none';
    return;
  }

  debugSection.style.display = 'block';

  // 로그 포맷팅
  const formattedLogs = logs.map(log => {
    if (log.includes('===')) {
      return `<span class="log-section">${escapeHtml(log)}</span>`;
    } else if (log.includes('✅') || log.includes('성공') || log.includes('완료')) {
      return `<span class="log-success">${escapeHtml(log)}</span>`;
    } else if (log.includes('❌') || log.includes('실패') || log.includes('오류')) {
      return `<span class="log-error">${escapeHtml(log)}</span>`;
    } else if (log.includes('⚠️') || log.includes('경고')) {
      return `<span class="log-warning">${escapeHtml(log)}</span>`;
    } else if (log.includes('[')) {
      return `<span class="log-info">${escapeHtml(log)}</span>`;
    }
    return escapeHtml(log);
  }).join('\n');

  debugLogs.innerHTML = formattedLogs;
  debugLogs.scrollTop = debugLogs.scrollHeight;
}

// 카테고리별 점수 표시
function displayCategoryScores(scores, fullData) {
  const categoryScoresDiv = document.getElementById('categoryScores');
  categoryScoresDiv.innerHTML = '';

  // menuCount 위치가 왔다갔다 해서 둘 다 커버
  const menuCount =
    (fullData?.placeData && fullData.placeData.menuCount !== undefined ? fullData.placeData.menuCount : undefined) ??
    (fullData?.menuCount !== undefined ? fullData.menuCount : undefined);

  const categories = [
    { key: 'description', icon: '📝', title: '상세설명' },
    { key: 'directions', icon: '🗺️', title: '오시는길' },
    { key: 'keywords', icon: '🔑', title: '대표키워드' },
    { key: 'reviews', icon: '⭐', title: '리뷰' },
    { key: 'photos', icon: '📸', title: '사진' },
    { key: 'price', icon: '💰', title: '가격/메뉴' }
  ];

  categories.forEach(cat => {
    const score = scores?.[cat.key];
    const safeScore = score || { score: '-', grade: 'C', issues: ['점수 계산 로직 미적용(표시만 추가됨)'] };

    let issues = Array.isArray(safeScore.issues) ? [...safeScore.issues] : [];

    if (cat.key === 'price') {
      if (menuCount === undefined) issues.unshift('총 메뉴 수: (데이터 없음)');
      else issues.unshift(`총 메뉴 수: ${menuCount}개`);
    }

    const card = document.createElement('div');
    card.className = 'category-card';

    const issuesList = issues.length > 0
      ? issues.map(issue => `<li>${escapeHtml(issue)}</li>`).join('')
      : '<li>문제가 발견되지 않았습니다 ✓</li>';

    card.innerHTML = `
      <div class="category-header">
        <div class="category-title">${cat.icon} ${escapeHtml(cat.title)}</div>
        <div class="category-score">
          <span class="category-score-number">${escapeHtml(safeScore.score)}</span>
          <span class="category-grade grade-${escapeHtml(safeScore.grade)}">${escapeHtml(safeScore.grade)}</span>
        </div>
      </div>
      <ul class="category-issues">
        ${issuesList}
      </ul>
    `;

    categoryScoresDiv.appendChild(card);
  });
}

/* ---------------------------
   ✅ 유료 섹션 렌더링 (핵심)
---------------------------- */

// 유료 개선안 표시(새)
function displayImprovementsPaid(fullData) {
  const improvementsSection = document.getElementById('improvementsSection');
  improvementsSection.innerHTML = '<h3 class="section-title">💡 맞춤 개선안</h3>';

  const improvements = fullData.improvements || null;

  // 0) 추천 대표키워드 5개 (서버가 이 필드를 내려주면 가장 우선)
  // - recommendedKeywords5 (권장) / recommendedKeywords (fallback)
  const rec5 =
    (Array.isArray(fullData.recommendedKeywords5) ? fullData.recommendedKeywords5 : null) ||
    (Array.isArray(fullData.recommendedKeywords) ? fullData.recommendedKeywords.slice(0, 5) : []);

  if (rec5 && rec5.length) {
    const card = document.createElement('div');
    card.className = 'improvement-card';

    const contentId = `improvement-recommendedKeywords5`;
    const text = rec5.join('\n');

    const keywordTags = rec5.map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('');

    card.innerHTML = `
      <h3>🔑 추천 대표키워드 5개</h3>
      <p style="margin-top:-6px; color:#666; font-size:0.9rem;">대표키워드 칸(최대 5개)에 그대로 입력하세요</p>
      <div class="competitor-keywords">${keywordTags}</div>
      <pre id="${contentId}" style="display:none;">${escapeHtml(text)}</pre>
      <button class="copy-button" onclick="copyToClipboard('${contentId}')">📋 키워드 5개 복사</button>
    `;
    improvementsSection.appendChild(card);
  }

  // 1) 통합본(unifiedText) — 프론트가 무엇을 보여주든 이것 하나로 “전부” 보이게
  if (fullData.unifiedText) {
    const card = document.createElement('div');
    card.className = 'improvement-card';
    const contentId = `improvement-unifiedText`;
    card.innerHTML = `
      <h3>📌 유료 컨설팅 결과 통합본 (한 번에 복사)</h3>
      <div class="improvement-content" id="${contentId}" style="white-space:pre-wrap;">${escapeHtml(fullData.unifiedText)}</div>
      <button class="copy-button" onclick="copyToClipboard('${contentId}')">📋 전체 복사</button>
    `;
    improvementsSection.appendChild(card);
  }

  // 2) 섹션별 improvements 표시 (기존 로직 + 확장)
  // 기존에는 description/directions/reviewGuidance/photoGuidance만 있었음 → priceGuidance까지 추가
  const improvementTypes = [
    { key: 'description', icon: '📝', title: '상세설명 개선안' },
    { key: 'directions', icon: '🗺️', title: '오시는길 개선안' },
    { key: 'reviewGuidance', icon: '⭐', title: '리뷰 개선 가이드 (요청/답변 포함)' },
    { key: 'photoGuidance', icon: '📸', title: '사진 개선 가이드' },
    { key: 'priceGuidance', icon: '💰', title: '가격/메뉴 개선 가이드' }
  ];

  // improvements가 있으면 그걸 우선 표시
  if (improvements) {
    improvementTypes.forEach(type => {
      if (improvements[type.key]) {
        const card = document.createElement('div');
        card.className = 'improvement-card';

        const contentId = `improvement-${type.key}`;
        card.innerHTML = `
          <h3>${type.icon} ${escapeHtml(type.title)}</h3>
          <div class="improvement-content" id="${contentId}" style="white-space:pre-wrap;">${escapeHtml(improvements[type.key])}</div>
          <button class="copy-button" onclick="copyToClipboard('${contentId}')">📋 복사하기</button>
        `;
        improvementsSection.appendChild(card);
      }
    });

    // improvements.keywords (추가 추천 키워드)
    if (improvements.keywords && Array.isArray(improvements.keywords)) {
      const card = document.createElement('div');
      card.className = 'improvement-card';
      const keywordTags = improvements.keywords.map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('');
      card.innerHTML = `
        <h3>🔎 추가 추천 키워드</h3>
        <div class="competitor-keywords">${keywordTags}</div>
      `;
      improvementsSection.appendChild(card);
    }
  }

  // 3) 적용 후 예상점수 (서버가 내려주면 표시)
  if (fullData.predictedAfterApply) {
    const p = fullData.predictedAfterApply;
    const card = document.createElement('div');
    card.className = 'improvement-card';

    const contentId = `improvement-predictedAfterApply`;
    const text =
      `예상 점수: ${p.totalScore ?? '-'}점\n` +
      `예상 등급: ${p.totalGrade ?? '-'}\n\n` +
      `* 목표: 컨설팅 적용 후 재진단 시 90점 이상`;

    card.innerHTML = `
      <h3>📈 적용 후 예상 점수(목표: 90점+)</h3>
      <div class="improvement-content" id="${contentId}" style="white-space:pre-wrap;">${escapeHtml(text)}</div>
      <button class="copy-button" onclick="copyToClipboard('${contentId}')">📋 복사하기</button>
    `;
    improvementsSection.appendChild(card);
  }

  // 4) 아무것도 없을 때 안내
  const hasAnything =
    !!fullData.unifiedText ||
    (rec5 && rec5.length) ||
    !!improvements;

  if (!hasAnything) {
    const card = document.createElement('div');
    card.className = 'improvement-card';
    card.innerHTML = `
      <h3>💡 맞춤 개선안</h3>
      <div class="improvement-content" style="white-space:pre-wrap;">
서버에서 개선안 데이터가 내려오지 않았습니다.
- /api/diagnose/paid 응답 JSON의 data.improvements / data.unifiedText / data.recommendedKeywords5 를 확인해주세요.
      </div>
    `;
    improvementsSection.appendChild(card);
  }
}

// 유료 경쟁사 섹션 표시(새)
function displayCompetitorsPaid(fullData) {
  const competitorsSection = document.getElementById('competitorsSection');
  competitorsSection.innerHTML = '<h3 class="section-title">🏆 경쟁사 Top 5 분석</h3>';

  // 1) 서버가 "요약 라인"을 내려주면 그대로 1~5. 업체명 : 키워드 형태로 표시
  // - competitorSummaryLines 권장
  if (Array.isArray(fullData.competitorSummaryLines) && fullData.competitorSummaryLines.length) {
    const card = document.createElement('div');
    card.className = 'improvement-card';

    const contentId = 'competitorSummaryLines';
    const text = fullData.competitorSummaryLines.join('\n');

    card.innerHTML = `
      <h3>📌 경쟁사 TOP5 한 줄 요약</h3>
      <div class="improvement-content" id="${contentId}" style="white-space:pre-wrap;">${escapeHtml(text)}</div>
      <button class="copy-button" onclick="copyToClipboard('${contentId}')">📋 전체 복사</button>
    `;
    competitorsSection.appendChild(card);
  }

  // 2) 기존 competitors 배열이 있으면 상세 카드로 표시 (기존 로직 유지)
  if (Array.isArray(fullData.competitors) && fullData.competitors.length > 0) {
    fullData.competitors.slice(0, 5).forEach((comp, index) => {
      const card = document.createElement('div');
      card.className = 'competitor-card';

      const keywordTags = comp.keywords && comp.keywords.length > 0
        ? comp.keywords.slice(0, 5).map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('')
        : '<span style="color: #999;">키워드 없음</span>';

      card.innerHTML = `
        <h4>${index + 1}. ${escapeHtml(comp.name || '')}</h4>
        <p>${escapeHtml(comp.address || '주소 정보 없음')}</p>
        <p style="font-size: 0.85rem; color: #999;">리뷰: ${escapeHtml(comp.reviewCount)}개 | 사진: ${escapeHtml(comp.photoCount)}개</p>
        <div class="competitor-keywords">${keywordTags}</div>
      `;

      competitorsSection.appendChild(card);
    });
  } else {
    // competitors 없을 때도 섹션은 보여야 함
    const info = document.createElement('div');
    info.className = 'improvement-card';
    info.innerHTML = `
      <h3>경쟁사 데이터</h3>
      <div class="improvement-content" style="white-space:pre-wrap;">
경쟁사 데이터가 없습니다.
- 서버에서 competitors 또는 competitorSummaryLines 를 내려주도록 구현되어 있어야 합니다.
      </div>
    `;
    competitorsSection.appendChild(info);
  }

  // 3) 추천 키워드(추가) — 기존 recommendedKeywords도 계속 표시
  if (Array.isArray(fullData.recommendedKeywords) && fullData.recommendedKeywords.length > 0) {
    const recommendCard = document.createElement('div');
    recommendCard.className = 'improvement-card';
    recommendCard.style.marginTop = '20px';

    const keywordTags = fullData.recommendedKeywords
      .map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`)
      .join('');

    recommendCard.innerHTML = `
      <h3>💡 추천 키워드(추가)</h3>
      <p style="margin-bottom: 15px; color: #666;">경쟁사 분석을 바탕으로 한 추천 키워드입니다</p>
      <div class="competitor-keywords">${keywordTags}</div>
    `;

    competitorsSection.appendChild(recommendCard);
  }
}

/* ---------------------------
   기존 함수들 (유지/호환)
---------------------------- */

// 개선안 표시 (유료) — 기존 함수는 유지하지만, 이제 유료는 displayImprovementsPaid를 사용
function displayImprovements(improvements) {
  const improvementsSection = document.getElementById('improvementsSection');
  improvementsSection.innerHTML = '<h3 class="section-title">💡 맞춤 개선안</h3>';

  const improvementTypes = [
    { key: 'description', icon: '📝', title: '상세설명 개선안' },
    { key: 'directions', icon: '🗺️', title: '오시는길 개선안' },
    { key: 'reviewGuidance', icon: '⭐', title: '리뷰 개선 가이드' },
    { key: 'photoGuidance', icon: '📸', title: '사진 개선 가이드' },
    { key: 'priceGuidance', icon: '💰', title: '가격/메뉴 개선 가이드' } // ✅ 추가
  ];

  improvementTypes.forEach(type => {
    if (improvements[type.key]) {
      const card = document.createElement('div');
      card.className = 'improvement-card';

      const contentId = `improvement-${type.key}`;

      card.innerHTML = `
        <h3>${type.icon} ${type.title}</h3>
        <div class="improvement-content" id="${contentId}" style="white-space:pre-wrap;">${escapeHtml(improvements[type.key])}</div>
        <button class="copy-button" onclick="copyToClipboard('${contentId}')">
          📋 복사하기
        </button>
      `;

      improvementsSection.appendChild(card);
    }
  });

  // 추천 키워드
  if (improvements.keywords && Array.isArray(improvements.keywords)) {
    const card = document.createElement('div');
    card.className = 'improvement-card';

    const keywordTags = improvements.keywords
      .map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`)
      .join('');

    card.innerHTML = `
      <h3>🔑 추천 대표키워드</h3>
      <div class="competitor-keywords">${keywordTags}</div>
    `;

    improvementsSection.appendChild(card);
  }
}

// 경쟁사 분석 표시 (유료) — 기존 함수도 유지하지만, 이제 displayCompetitorsPaid가 우선
function displayCompetitors(competitors, recommendedKeywords) {
  const competitorsSection = document.getElementById('competitorsSection');
  competitorsSection.innerHTML = '<h3 class="section-title">🏆 경쟁사 Top 5 분석</h3>';

  if (competitors && competitors.length > 0) {
    competitors.forEach((comp, index) => {
      const card = document.createElement('div');
      card.className = 'competitor-card';

      const keywordTags = comp.keywords && comp.keywords.length > 0
        ? comp.keywords.map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`).join('')
        : '<span style="color: #999;">키워드 없음</span>';

      card.innerHTML = `
        <h4>${index + 1}. ${escapeHtml(comp.name || '')}</h4>
        <p>${escapeHtml(comp.address || '주소 정보 없음')}</p>
        <p style="font-size: 0.85rem; color: #999;">리뷰: ${escapeHtml(comp.reviewCount)}개 | 사진: ${escapeHtml(comp.photoCount)}개</p>
        <div class="competitor-keywords">${keywordTags}</div>
      `;

      competitorsSection.appendChild(card);
    });
  }

  // 추천 키워드
  if (recommendedKeywords && recommendedKeywords.length > 0) {
    const recommendCard = document.createElement('div');
    recommendCard.className = 'improvement-card';
    recommendCard.style.marginTop = '20px';

    const keywordTags = recommendedKeywords
      .map(kw => `<span class="keyword-tag">${escapeHtml(kw)}</span>`)
      .join('');

    recommendCard.innerHTML = `
      <h3>💡 추천 키워드</h3>
      <p style="margin-bottom: 15px; color: #666;">경쟁사 분석을 바탕으로 한 추천 키워드입니다</p>
      <div class="competitor-keywords">${keywordTags}</div>
    `;

    competitorsSection.appendChild(recommendCard);
  }
}

// 클립보드 복사
function copyToClipboard(elementId) {
  const element = document.getElementById(elementId);
  const text = element ? element.textContent : '';

  if (!text || !text.trim()) {
    alert('복사할 내용이 없습니다.');
    return;
  }

  navigator.clipboard.writeText(text).then(() => {
    alert('✅ 복사되었습니다!\n네이버 플레이스에 붙여넣기 하세요.');
  }).catch(err => {
    console.error('복사 실패:', err);

    // Fallback: 텍스트 선택
    const range = document.createRange();
    range.selectNode(element);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);

    try {
      document.execCommand('copy');
      alert('✅ 복사되었습니다!');
    } catch (e) {
      alert('❌ 복사에 실패했습니다. 수동으로 복사해주세요.');
    }

    window.getSelection().removeAllRanges();
  });
}

// HTML escape (로그/컨텐츠 안전 표시)
function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

// 초기화
document.addEventListener('DOMContentLoaded', () => {
  showSection('inputSection');

  // Enter 키 이벤트
  document.getElementById('placeUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      diagnoseFree();
    }
  });

  const sq = document.getElementById('searchQuery');
  if (sq) {
    sq.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') {
        diagnosePaid();
      }
    });
  }

  // 모달 외부 클릭 시 닫기
  document.getElementById('paidModal').addEventListener('click', (e) => {
    if (e.target.id === 'paidModal') {
      closePaidModal();
    }
  });
});
