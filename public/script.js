// API Base URL
const API_BASE = window.location.origin;

// 현재 플레이스 URL 저장
let currentPlaceUrl = '';

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
}

// 무료 진단
async function diagnoseFree() {
    const placeUrl = document.getElementById('placeUrl').value.trim();

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
            body: JSON.stringify({ placeUrl })
        });

        const result = await response.json();

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
    const searchQuery = document.getElementById('searchQuery').value.trim();

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

    closePaidModal();
    showSection('loadingSection');

    try {
        const response = await fetch(`${API_BASE}/api/diagnose/paid`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                placeUrl: currentPlaceUrl,
                searchQuery
            })
        });

        if (!response.ok) {
            const error = await response.json();
            throw new Error(error.message || error.error || '진단 중 오류가 발생했습니다');
        }

        const result = await response.json();
        displayReport(result.data, true);
    } catch (error) {
        console.error('Error:', error);
        showError(error.message);
    }
}

/**
 * ✅ 가격/메뉴 섹션 DOM을 보장 생성
 * - HTML에 menuSummary/menuList가 없어도 자동 생성됨
 */
function ensureMenuSection() {
    // 이미 존재하면 OK
    let summaryEl = document.getElementById('menuSummary');
    let listEl = document.getElementById('menuList');
    if (summaryEl && listEl) return { summaryEl, listEl };

    const anchor = document.getElementById('categoryScores');
    const reportSection = document.getElementById('reportSection');

    const wrap = document.createElement('div');
    wrap.className = 'improvement-card';
    wrap.style.marginTop = '18px';

    wrap.innerHTML = `
        <h3 class="section-title">💰 가격 / 메뉴</h3>
        <p id="menuSummary" style="color:#666; margin-bottom:12px;">메뉴 정보를 불러오는 중...</p>
        <div id="menuList"></div>
    `;

    if (anchor && anchor.parentNode) {
        anchor.parentNode.insertBefore(wrap, anchor.nextSibling);
    } else if (reportSection) {
        reportSection.appendChild(wrap);
    }

    summaryEl = wrap.querySelector('#menuSummary');
    listEl = wrap.querySelector('#menuList');
    return { summaryEl, listEl };
}

/**
 * ✅ 메뉴 데이터 표시
 * - 백엔드 응답이 data.placeData.menuCount / data.placeData.menus 일 수도 있고
 * - data.menuCount / data.menus 일 수도 있어서 둘 다 지원
 */
function renderMenu(data) {
    const { summaryEl, listEl } = ensureMenuSection();

    const menuCount =
        (data?.placeData && data.placeData.menuCount !== undefined ? data.placeData.menuCount : undefined) ??
        (data?.menuCount !== undefined ? data.menuCount : undefined);

    const menus =
        (data?.placeData && Array.isArray(data.placeData.menus) ? data.placeData.menus : null) ??
        (Array.isArray(data?.menus) ? data.menus : null) ??
        [];

    if (menuCount === undefined) {
        summaryEl.textContent = '가격/메뉴 데이터가 아직 응답에 포함되지 않았습니다.';
        listEl.innerHTML = '';
        return;
    }

    summaryEl.innerHTML = `총 메뉴 수: <strong>${menuCount}</strong>`;

    if (!Array.isArray(menus) || menus.length === 0) {
        listEl.innerHTML = `<div style="color:#999;">메뉴 목록을 찾지 못했습니다.</div>`;
        return;
    }

    const items = menus.slice(0, 12).map(m => {
        const name = (m?.name || '').toString().trim();
        const price = (m?.price || '').toString().trim();
        const desc = (m?.desc || '').toString().trim();

        return `
            <div style="padding:10px 0; border-top:1px solid #eee;">
                <div style="font-weight:700;">${name || '메뉴명 없음'}</div>
                <div style="color:#333; margin-top:2px;">
                    ${price ? price : '<span style="color:#999;">가격 정보 없음</span>'}
                </div>
                ${desc ? `<div style="color:#777; font-size:0.9rem; margin-top:4px;">${desc}</div>` : ''}
            </div>
        `;
    }).join('');

    listEl.innerHTML = items;
}

// 리포트 표시
function displayReport(data, isPaid) {
    // 플레이스 정보
    document.getElementById('placeName').textContent = data.placeData.name;
    document.getElementById('placeAddress').textContent = data.placeData.address;

    // 총점
    document.getElementById('totalScore').textContent = data.totalScore;
    document.getElementById('totalGrade').textContent = data.totalGrade;

    // 총점 배지 색상
    const gradeBadge = document.getElementById('totalGradeBadge');
    gradeBadge.className = `grade-badge grade-${data.totalGrade}`;

    // 카테고리별 점수
    displayCategoryScores(data.scores);

    // ✅ 가격/메뉴 UI 표시
    renderMenu(data);

    // 무료 버전 - 업그레이드 섹션 표시
    if (!isPaid) {
        document.getElementById('upgradeSection').style.display = 'block';
        document.getElementById('improvementsSection').style.display = 'none';
        document.getElementById('competitorsSection').style.display = 'none';
    } else {
        // 유료 버전 - 개선안 및 경쟁사 분석 표시
        document.getElementById('upgradeSection').style.display = 'none';

        if (data.improvements) {
            displayImprovements(data.improvements);
            document.getElementById('improvementsSection').style.display = 'block';
        }

        if (data.competitors) {
            displayCompetitors(data.competitors, data.recommendedKeywords);
            document.getElementById('competitorsSection').style.display = 'block';
        }
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
        // 색상 적용
        if (log.includes('===')) {
            return `<span class="log-section">${log}</span>`;
        } else if (log.includes('✅') || log.includes('성공') || log.includes('완료')) {
            return `<span class="log-success">${log}</span>`;
        } else if (log.includes('❌') || log.includes('실패') || log.includes('오류')) {
            return `<span class="log-error">${log}</span>`;
        } else if (log.includes('⚠️') || log.includes('경고')) {
            return `<span class="log-warning">${log}</span>`;
        } else if (log.includes('[')) {
            return `<span class="log-info">${log}</span>`;
        }
        return log;
    }).join('\n');

    debugLogs.innerHTML = formattedLogs;

    // 자동 스크롤
    debugLogs.scrollTop = debugLogs.scrollHeight;
}

// 카테고리별 점수 표시
function displayCategoryScores(scores) {
    const categoryScoresDiv = document.getElementById('categoryScores');
    categoryScoresDiv.innerHTML = '';

    const categories = [
        { key: 'description', icon: '📝', title: '상세설명' },
        { key: 'directions', icon: '🗺️', title: '오시는길' },
        { key: 'keywords', icon: '🔑', title: '대표키워드' },
        { key: 'reviews', icon: '⭐', title: '리뷰' },
        { key: 'photos', icon: '📸', title: '사진' },
        { key: 'price', icon: '💰', title: '가격/메뉴' } // ✅ 추가
    ];

    categories.forEach(cat => {
        const score = scores?.[cat.key];

        // 점수 로직이 아직 없을 수도 있으니 안전 처리
        const safeScore = score || { score: '-', grade: 'C', issues: ['점수 계산 로직 미적용(표시만 추가됨)'] };

        const card = document.createElement('div');
        card.className = 'category-card';

        const issuesList = safeScore.issues && safeScore.issues.length > 0
            ? safeScore.issues.map(issue => `<li>${issue}</li>`).join('')
            : '<li>문제가 발견되지 않았습니다 ✓</li>';

        card.innerHTML = `
            <div class="category-header">
                <div class="category-title">${cat.icon} ${cat.title}</div>
                <div class="category-score">
                    <span class="category-score-number">${safeScore.score}</span>
                    <span class="category-grade grade-${safeScore.grade}">${safeScore.grade}</span>
                </div>
            </div>
            <ul class="category-issues">
                ${issuesList}
            </ul>
        `;

        categoryScoresDiv.appendChild(card);
    });
}

// 개선안 표시 (유료)
function displayImprovements(improvements) {
    const improvementsSection = document.getElementById('improvementsSection');
    improvementsSection.innerHTML = '<h3 class="section-title">💡 맞춤 개선안</h3>';

    const improvementTypes = [
        { key: 'description', icon: '📝', title: '상세설명 개선안' },
        { key: 'directions', icon: '🗺️', title: '오시는길 개선안' },
        { key: 'reviewGuidance', icon: '⭐', title: '리뷰 개선 가이드' },
        { key: 'photoGuidance', icon: '📸', title: '사진 개선 가이드' }
    ];

    improvementTypes.forEach(type => {
        if (improvements[type.key]) {
            const card = document.createElement('div');
            card.className = 'improvement-card';

            const contentId = `improvement-${type.key}`;

            card.innerHTML = `
                <h3>${type.icon} ${type.title}</h3>
                <div class="improvement-content" id="${contentId}">${improvements[type.key]}</div>
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
            .map(kw => `<span class="keyword-tag">${kw}</span>`)
            .join('');

        card.innerHTML = `
            <h3>🔑 추천 대표키워드</h3>
            <div class="competitor-keywords">${keywordTags}</div>
        `;

        improvementsSection.appendChild(card);
    }
}

// 경쟁사 분석 표시 (유료)
function displayCompetitors(competitors, recommendedKeywords) {
    const competitorsSection = document.getElementById('competitorsSection');
    competitorsSection.innerHTML = '<h3 class="section-title">🏆 경쟁사 Top 5 분석</h3>';

    if (competitors && competitors.length > 0) {
        competitors.forEach((comp, index) => {
            const card = document.createElement('div');
            card.className = 'competitor-card';

            const keywordTags = comp.keywords && comp.keywords.length > 0
                ? comp.keywords.map(kw => `<span class="keyword-tag">${kw}</span>`).join('')
                : '<span style="color: #999;">키워드 없음</span>';

            card.innerHTML = `
                <h4>${index + 1}. ${comp.name}</h4>
                <p>${comp.address || '주소 정보 없음'}</p>
                <p style="font-size: 0.85rem; color: #999;">리뷰: ${comp.reviewCount}개 | 사진: ${comp.photoCount}개</p>
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
            .map(kw => `<span class="keyword-tag">${kw}</span>`)
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
    const text = element.textContent;

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

// 초기화
document.addEventListener('DOMContentLoaded', () => {
    showSection('inputSection');

    // Enter 키 이벤트
    document.getElementById('placeUrl').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            diagnoseFree();
        }
    });

    document.getElementById('searchQuery').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            diagnosePaid();
        }
    });

    // 모달 외부 클릭 시 닫기
    document.getElementById('paidModal').addEventListener('click', (e) => {
        if (e.target.id === 'paidModal') {
            closePaidModal();
        }
    });
});
