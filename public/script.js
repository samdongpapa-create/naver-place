// API Base URL
const API_BASE = window.location.origin;

// 현재 플레이스 URL 저장
let currentPlaceUrl = '';

// (옵션) 업종 저장 (index.html에 industrySelect가 없으면 자동 hairshop)
let currentIndustry = 'hairshop';

/* ---------------------------
   URL 변환 함수 (프론트엔드)
---------------------------- */
function convertToMobileUrl(url) {
  try {
    if (!url) return '';
    const urlObj = new URL(url);

    // 이미 모바일 URL인 경우
    if (urlObj.hostname === 'm.place.naver.com') return url;

    // place ID 추출
    let placeId = null;

    const entryMatch = url.match(/\/entry\/place\/(\d+)/);
    if (entryMatch && entryMatch[1]) placeId = entryMatch[1];

    if (!placeId) {
      const placeMatch = url.match(/place\.naver\.com\/[^/]+\/(\d+)/);
      if (placeMatch && placeMatch[1]) placeId = placeMatch[1];
    }

    if (!placeId) {
      const paramMatch = url.match(/[?&]place=(\d+)/);
      if (paramMatch && paramMatch[1]) placeId = paramMatch[1];
    }

    if (!placeId) {
      const numberMatch = url.match(/(\d{7,})/);
      if (numberMatch && numberMatch[1]) placeId = numberMatch[1];
    }

    if (placeId) return `https://m.place.naver.com/place/${placeId}`;
    return url;
  } catch (error) {
    return url;
  }
}

/* ---------------------------
   섹션/에러/초기화
---------------------------- */
function showSection(sectionId) {
  const sections = ['inputSection', 'loadingSection', 'reportSection', 'errorSection'];
  sections.forEach(id => {
    const el = document.getElementById(id);
    if (el) el.style.display = id === sectionId ? 'block' : 'none';
  });
}

function showError(message) {
  document.getElementById('errorMessage').textContent = message;
  showSection('errorSection');
}

function resetDiagnosis() {
  document.getElementById('placeUrl').value = '';
  currentPlaceUrl = '';
  showSection('inputSection');

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

  const debugSection = document.getElementById('debugSection');
  const debugLogs = document.getElementById('debugLogs');
  if (debugSection) debugSection.style.display = 'none';
  if (debugLogs) debugLogs.innerHTML = '';
}

/* ---------------------------
   무료 진단
---------------------------- */
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
      body: JSON.stringify({ placeUrl, industry: currentIndustry })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      if (result.logs) {
        displayLogs(result.logs);
        showSection('reportSection');
      } else {
        throw new Error(result.message || result.error || '진단 중 오류가 발생했습니다');
      }
      return;
    }

    displayReport(result.data, false);
    if (result.logs) displayLogs(result.logs);
  } catch (error) {
    console.error('Error:', error);
    showError(error.message);
  }
}

/* ---------------------------
   유료 모달 (입력창 강제 표시 + 필수)
---------------------------- */

function showPaidModal() {
  const modal = document.getElementById('paidModal');
  modal.style.display = 'flex';

  // 1) searchQuery가 없으면 모달 안에 직접 생성해서 넣어버림 (✅ 무조건 입력칸 생김)
  let input = document.getElementById('searchQuery');
  if (!input) {
    const modalBody = modal.querySelector('.modal-body') || modal;

    input = document.createElement('input');
    input.id = 'searchQuery';
    input.type = 'text';
    input.className = 'modal-input';
    input.placeholder = '예: 서대문역 미용실, 광화문 미용실';

    // 가격 표시 위에 넣고 싶으면 적당히 위치 잡아 삽입
    const priceEl = modal.querySelector('.modal-price');
    if (priceEl && priceEl.parentNode) {
      priceEl.parentNode.insertBefore(input, priceEl);
    } else {
      modalBody.appendChild(input);
    }

    // Enter로 바로 유료진단
    input.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') diagnosePaid();
    });
  }

  // 2) CSS로 숨겨져도 강제 표시
  input.style.display = 'block';
  input.style.visibility = 'visible';
  input.style.opacity = '1';
  input.style.height = 'auto';
  input.style.pointerEvents = 'auto';
  input.style.position = 'relative';
  input.style.zIndex = '9999';

  // 3) 모달 콘텐츠도 혹시 z-index에 밀리면 강제 보정
  const content = modal.querySelector('.modal-content');
  if (content) {
    content.style.position = 'relative';
    content.style.zIndex = '9999';
  }
  modal.style.zIndex = '9998';

  setTimeout(() => input.focus(), 50);
}

function closePaidModal() {
  document.getElementById('paidModal').style.display = 'none';
}

/* ---------------------------
   유료 진단 (searchQuery 필수)
---------------------------- */
async function diagnosePaid() {
  const searchQueryEl = document.getElementById('searchQuery');
  const searchQuery = searchQueryEl ? searchQueryEl.value.trim() : '';

  if (!currentPlaceUrl) {
    alert('플레이스 URL이 없습니다. 다시 시도해주세요.');
    closePaidModal();
    resetDiagnosis();
    return;
  }

  const industrySel = document.getElementById('industrySelect');
  currentIndustry = industrySel ? industrySel.value : (currentIndustry || 'hairshop');

  // ✅ 유료는 경쟁사 검색어 필수
  if (!searchQuery) {
    alert('경쟁사 분석을 위한 검색어를 입력해주세요.\n예: 서대문역 미용실, 광화문 미용실');
    if (searchQueryEl) searchQueryEl.focus();
    return;
  }

  closePaidModal();
  showSection('loadingSection');

  try {
    const response = await fetch(`${API_BASE}/api/diagnose/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        placeUrl: currentPlaceUrl,
        industry: currentIndustry,
        searchQuery
      })
    });

    const result = await response.json().catch(() => ({}));

    if (!response.ok) {
      throw new Error(result.message || result.error || '진단 중 오류가 발생했습니다');
    }

    displayReport(result.data, true);
    if (result.logs) displayLogs(result.logs);
  } catch (error) {
    console.error('Error:', error);
    showError(error.message);
  }
}

/* ---------------------------
   리포트 표시
---------------------------- */
function displayReport(data, isPaid) {
  document.getElementById('placeName').textContent = data.placeData?.name || '-';
  document.getElementById('placeAddress').textContent = data.placeData?.address || '-';

  document.getElementById('totalScore').textContent = data.totalScore ?? '-';
  document.getElementById('totalGrade').textContent = data.totalGrade ?? '-';

  const gradeBadge = document.getElementById('totalGradeBadge');
  gradeBadge.className = `grade-badge grade-${data.totalGrade || 'C'}`;

  displayCategoryScores(data.scores, data);

  if (!isPaid) {
    document.getElementById('upgradeSection').style.display = 'block';
    document.getElementById('improvementsSection').style.display = 'none';
    document.getElementById('competitorsSection').style.display = 'none';
  } else {
    document.getElementById('upgradeSection').style.display = 'none';

    displayImprovementsPaid(data);
    document.getElementById('improvementsSection').style.display = 'block';

    displayCompetitorsPaid(data);
    document.getElementById('competitorsSection').style.display = 'block';
  }

  showSection('reportSection');
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* ---------------------------
   디버그 로그
---------------------------- */
function displayLogs(logs) {
  const debugSection = document.getElementById('debugSection');
  const debugLogs = document.getElementById('debugLogs');

  if (!logs || logs.length === 0) {
    debugSection.style.display = 'none';
    return;
  }

  debugSection.style.display = 'block';

  const formattedLogs = logs.map(log => {
    if (log.includes('===')) return `<span class="log-section">${escapeHtml(log)}</span>`;
    if (log.includes('✅') || log.includes('성공') || log.includes('완료')) return `<span class="log-success">${escapeHtml(log)}</span>`;
    if (log.includes('❌') || log.includes('실패') || log.includes('오류')) return `<span class="log-error">${escapeHtml(log)}</span>`;
    if (log.includes('⚠️') || log.includes('경고')) return `<span class="log-warning">${escapeHtml(log)}</span>`;
    if (log.includes('[')) return `<span class="log-info">${escapeHtml(log)}</span>`;
    return escapeHtml(log);
  }).join('\n');

  debugLogs.innerHTML = formattedLogs;
  debugLogs.scrollTop = debugLogs.scrollHeight;
}

/* ---------------------------
   ✅ 카테고리별 점수 표시
   - 대표키워드: 너무 많은 issues → 3줄 핵심만 출력
   - 가격/메뉴: 총 메뉴 수 중복 제거
---------------------------- */
function displayCategoryScores(scores, fullData) {
  const categoryScoresDiv = document.getElementById('categoryScores');
  categoryScoresDiv.innerHTML = '';

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
    const safeScore = score || { score: '-', grade: 'C', issues: ['점수 계산 로직 미적용'] };
    let issues = Array.isArray(safeScore.issues) ? [...safeScore.issues] : [];

    // ✅ 가격/메뉴: "총 메뉴 수" 중복 제거
    if (cat.key === 'price') {
      const hasMenuCountLine = issues.some(x => String(x).trim().startsWith('총 메뉴 수:'));
      if (!hasMenuCountLine) {
        if (menuCount === undefined) issues.unshift('총 메뉴 수: (데이터 없음)');
        else issues.unshift(`총 메뉴 수: ${menuCount}개`);
      }
      issues = dedupeByPrefix(issues, '총 메뉴 수:');
    }

    // ✅ 대표키워드: 3줄 핵심으로 축약
    if (cat.key === 'keywords') {
      issues = summarizeKeywordIssues(fullData, safeScore);
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
   ✅ 대표키워드 issues를 3줄로 요약
   (서버가 breakdown/meta를 내려주면 그걸 우선 활용)
---------------------------- */
function summarizeKeywordIssues(fullData, safeScore) {
  const kws = Array.isArray(fullData?.placeData?.keywords) ? fullData.placeData.keywords : [];
  const uniqKws = Array.from(new Set(kws.map(k => String(k).trim()).filter(Boolean)));
  const dup = Math.max(0, kws.length - uniqKws.length);

  const breakdown = safeScore.breakdown || safeScore.meta || null;

  // 기본 1줄: 개수/중복
  const line1 = `키워드: ${kws.length}/5 · 중복 ${dup}개`;

  // 2줄: 지역+업종 조합 여부 (네가 원한 핵심)
  // 서버 issues에 경고문이 있으면 그걸 살리고, 없으면 간단 판별
  const localityWarn =
    (Array.isArray(safeScore.issues) && safeScore.issues.find(x => String(x).includes('지역+업종'))) ||
    (kws.some(k => /(역|구|동|로|길)/.test(String(k))) ? '' : '⚠️ "지역+업종" 조합 키워드가 부족합니다 (예: 서대문역미용실)');

  const line2 = localityWarn ? String(localityWarn) : '지역+업종 조합 키워드 OK';

  // 3줄: 점수에 영향을 주는 “핵심 요소”를 한 줄로
  // breakdown이 있으면 점수 요약, 없으면 고정 문구
  let line3 = '반영요소: 중복/일반단어 감점 · 지역커버 · 검색의도 · 업종적합도';
  if (breakdown && typeof breakdown === 'object') {
    const b = breakdown;
    const parts = [];
    if (b.count !== undefined) parts.push(`개수 ${b.count}`);
    if (b.dedupe !== undefined) parts.push(`중복 ${b.dedupe}`);
    if (b.locality !== undefined) parts.push(`지역 ${b.locality}`);
    if (b.intent !== undefined) parts.push(`의도 ${b.intent}`);
    if (b.industryFit !== undefined) parts.push(`업종 ${b.industryFit}`);
    if (b.stopwordPenalty !== undefined && b.stopwordPenalty !== 0) parts.push(`일반단어 ${b.stopwordPenalty}`);
    if (parts.length) line3 = `세부: ${parts.join(' · ')}`;
  }

  // 결과는 3줄 고정
  return [line1, line2, line3].filter(Boolean).slice(0, 3);
}

/* ---------------------------
   ✅ 유료 섹션 렌더링
---------------------------- */
function displayImprovementsPaid(fullData) {
  const improvementsSection = document.getElementById('improvementsSection');
  improvementsSection.innerHTML = '<h3 class="section-title">💡 맞춤 개선안</h3>';

  const improvements = fullData.improvements || null;

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

  const improvementTypes = [
    { key: 'description', icon: '📝', title: '상세설명 개선안' },
    { key: 'directions', icon: '🗺️', title: '오시는길 개선안' },
    { key: 'reviewGuidance', icon: '⭐', title: '리뷰 개선 가이드 (요청/답변 포함)' },
    { key: 'photoGuidance', icon: '📸', title: '사진 개선 가이드' },
    { key: 'priceGuidance', icon: '💰', title: '가격/메뉴 개선 가이드' }
  ];

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

  const hasAnything = !!fullData.unifiedText || (rec5 && rec5.length) || !!improvements;

  if (!hasAnything) {
    const card = document.createElement('div');
    card.className = 'improvement-card';
    card.innerHTML = `
      <h3>💡 맞춤 개선안</h3>
      <div class="improvement-content" style="white-space:pre-wrap;">
서버에서 개선안 데이터가 내려오지 않았습니다.
- /api/diagnose/paid 응답 JSON의 data.improvements / data.unifiedText / data.recommendedKeywords 를 확인해주세요.
      </div>
    `;
    improvementsSection.appendChild(card);
  }
}

function displayCompetitorsPaid(fullData) {
  const competitorsSection = document.getElementById('competitorsSection');
  competitorsSection.innerHTML = '<h3 class="section-title">🏆 경쟁사 Top 5 분석</h3>';

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
}

/* ---------------------------
   복사 / 유틸
---------------------------- */
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

function escapeHtml(str) {
  return String(str ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function dedupeByPrefix(lines, prefix) {
  const out = [];
  let seen = false;
  for (const l of lines) {
    const s = String(l);
    if (s.trim().startsWith(prefix)) {
      if (seen) continue;
      seen = true;
    }
    out.push(l);
  }
  return out;
}

/* ---------------------------
   초기화
---------------------------- */
document.addEventListener('DOMContentLoaded', () => {
  showSection('inputSection');

  document.getElementById('placeUrl').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') diagnoseFree();
  });

  const sq = document.getElementById('searchQuery');
  if (sq) {
    sq.addEventListener('keypress', (e) => {
      if (e.key === 'Enter') diagnosePaid();
    });
  }

  document.getElementById('paidModal').addEventListener('click', (e) => {
    if (e.target.id === 'paidModal') closePaidModal();
  });
});
