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
   유료 모달
---------------------------- */
function showPaidModal() {
  const modal = document.getElementById('paidModal');
  modal.style.display = 'flex';

  // ✅ 입력창이 안 보이는 문제를 JS로 강제 보정
  const input = document.getElementById('searchQuery');
  if (input) {
    input.style.display = 'block';
    input.style.visibility = 'visible';
    input.style.opacity = '1';
    input.style.height = 'auto';
    input.style.pointerEvents = 'auto';

    // UX: 바로 입력 가능하게 포커스
    setTimeout(() => input.focus(), 50);
  }
}

function closePaidModal() {
  document.getElementById('paidModal').style.display = 'none';
}

/* ---------------------------
   유료 진단
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

  // ✅ 검색어는 "선택"으로 변경 (없어도 진행)
  // 경쟁사 분석을 서버에서 searchQuery로만 한다면, 그때만 다시 필수로 바꾸면 됨.
  closePaidModal();
  showSection('loadingSection');

  try {
    const response = await fetch(`${API_BASE}/api/diagnose/paid`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        placeUrl: currentPlaceUrl,
        industry: currentIndustry,
        searchQuery: searchQuery || '' // ✅ 빈 값 허용
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
   ✅ 카테고리별 점수 표시 (개선)
   - 대표키워드: "개수 외 점수요소" 표시
   - 가격/메뉴: 총 메뉴 수 중복 제거
   - 리뷰 목표(800 고정) 같은 문구는 아예 만들지 않음
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
    const safeScore = score || { score: '-', grade: 'C', issues: ['점수 계산 로직 미적용(표시만 추가됨)'] };

    let issues = Array.isArray(safeScore.issues) ? [...safeScore.issues] : [];

    // ✅ (1) 가격/메뉴: 총 메뉴 수 중복 제거
    if (cat.key === 'price') {
      // 서버 issues에 이미 "총 메뉴 수:"가 들어오면 프론트에서 추가하지 않음
      const hasMenuCountLine = issues.some(x => String(x).trim().startsWith('총 메뉴 수:'));
      if (!hasMenuCountLine) {
        if (menuCount === undefined) issues.unshift('총 메뉴 수: (데이터 없음)');
        else issues.unshift(`총 메뉴 수: ${menuCount}개`);
      }
      // 혹시 중복이 있으면 1개만 남김
      issues = dedupeByPrefix(issues, '총 메뉴 수:');
    }

    // ✅ (2) 대표키워드: "개수 외 점수요소"를 표시
    // - 서버가 breakdown/meta를 내려주면 그걸 그대로 보여주고,
    // - 없으면 프론트에서 "참고지표"로라도 보여준다.
    if (cat.key === 'keywords') {
      const kws = Array.isArray(fullData?.placeData?.keywords) ? fullData.placeData.keywords : [];
      const unique = Array.from(new Set(kws.map(k => String(k).trim()).filter(Boolean)));

      const countLine = `키워드 개수: ${kws.length}/5`;
      const uniqueLine = `중복 제거 기준: ${unique.length}/5 (중복 키워드 ${kws.length - unique.length}개)`;

      // 서버가 세부 점수 breakdown을 내려주는 경우(미래 대비)
      const breakdown = safeScore.breakdown || safeScore.meta || null;

      // 이미 같은 문구가 있으면 중복 방지
      if (!issues.some(x => String(x).includes('키워드 개수:'))) issues.unshift(countLine);
      if (!issues.some(x => String(x).includes('중복 제거 기준:'))) issues.unshift(uniqueLine);

      // "개수 외 점수요소" 안내 (서버 breakdown이 없을 때)
      if (!breakdown) {
        const extra = [
          '점수 반영 요소(추가):',
          '- 중복/유사 키워드 여부',
          '- 업종/지역 적합도(예: 서대문역 미용실, 광화문 미용실 등)',
          '- 고객 검색 의도 포함 여부(추천/후기/가격/예약 등)',
          '- 경쟁사 상위 노출 키워드 커버 여부'
        ].join('\n');

        // 카드 issue는 한 줄 리스트라서, 줄바꿈 대신 bullet 느낌으로 쪼개서 넣자
        if (!issues.some(x => String(x).includes('점수 반영 요소(추가)'))) {
          issues.push('점수 반영 요소(추가): 중복/유사, 업종/지역 적합도, 검색의도, 경쟁사 커버');
        }
      } else {
        // breakdown이 객체면 보기 좋게 펼침
        issues.push(`[세부 점수] ${formatBreakdown(breakdown)}`);
      }
    }

    // ✅ (3) 리뷰: "목표 800" 같은 문구는 여기서 절대 추가하지 않음
    // (현재 프론트는 목표 문구를 만들고 있지 않으니, 서버 issues에만 있으면 서버에서 제거 필요)

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

function formatBreakdown(b) {
  try {
    if (typeof b === 'string') return b;
    if (typeof b !== 'object' || !b) return String(b);

    const parts = [];
    for (const k of Object.keys(b)) {
      parts.push(`${k}:${b[k]}`);
    }
    return parts.join(' | ');
  } catch {
    return '';
  }
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
