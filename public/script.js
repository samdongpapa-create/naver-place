/* global document, window, fetch */

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function asArray(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) return [v.trim()];
  return [];
}

function toNumber(v, def = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : def;
}

function setDisplay(id, show) {
  const el = $(id);
  if (!el) return;
  el.style.display = show ? "" : "none";
}

function setText(id, text) {
  const el = $(id);
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

function setHtml(id, html) {
  const el = $(id);
  if (!el) return;
  el.innerHTML = html == null ? "" : String(html);
}

function renderTags(tags) {
  const arr = asArray(tags).filter(Boolean);
  if (!arr.length) return `<div class="muted">없음</div>`;
  return `<div class="keyword-tags">${arr
    .map((t) => `<span class="keyword-tag">${escapeHtml(t)}</span>`)
    .join("")}</div>`;
}

function renderPre(text) {
  const t = String(text ?? "").trim();
  if (!t) return `<div class="muted">없음</div>`;
  return `<pre style="white-space:pre-wrap; margin:0;">${escapeHtml(t)}</pre>`;
}

function normalizeServerResponse(serverJson) {
  // expected: { success, data, logs, message }
  const ok = !!serverJson?.success;
  const message = serverJson?.message || "";
  const logs = Array.isArray(serverJson?.logs) ? serverJson.logs : [];
  const data = serverJson?.data || {};

  const placeData = data.placeData || {};
  const place = {
    name: placeData.name || "",
    address: placeData.address || "",
    keywords: asArray(placeData.keywords || []),
    description: placeData.description || "",
    directions: placeData.directions || "",
    reviewCount: toNumber(placeData.reviewCount ?? placeData.reviewsTotal, 0),
    photoCount: toNumber(placeData.photoCount, 0),
    recent30d: toNumber(placeData.recentReviewCount30d ?? placeData.recent30d, 0)
  };

  const scoring = {
    totalScore: toNumber(data.totalScore, 0),
    totalGrade: String(data.totalGrade || ""),
    scores: data.scores || null
  };

  const paid = {
    recommendedKeywords: asArray(data.recommendedKeywords || []),
    competitors: Array.isArray(data.competitors) ? data.competitors : [],
    unifiedText: String(data.unifiedText || ""),
    improvements: data.improvements || null,
    predictedAfter: data.predictedAfter || null,
    attempts: toNumber(data.attempts, 0)
  };

  return { ok, message, logs, place, scoring, paid };
}

async function postJson(url, payload) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }

  return { res, json };
}

function showLoading() {
  setDisplay("inputSection", false);
  setDisplay("reportSection", false);
  setDisplay("errorSection", false);
  setDisplay("loadingSection", true);
}

function showReport() {
  setDisplay("loadingSection", false);
  setDisplay("errorSection", false);
  setDisplay("reportSection", true);
}

function showError(msg) {
  setDisplay("loadingSection", false);
  setDisplay("reportSection", false);
  setDisplay("errorSection", true);
  setText("errorMessage", msg || "알 수 없는 오류");
}

function clearReportSections() {
  setHtml("categoryScores", "");
  setHtml("improvementsSection", "");
  setHtml("competitorsSection", "");
  setHtml("debugLogs", "");

  setDisplay("upgradeSection", false);
  setDisplay("improvementsSection", false);
  setDisplay("competitorsSection", false);
  setDisplay("debugSection", false);
}

function gradeBadgeClass(grade) {
  // CSS가 따로 있다면 여기를 맞춰도 됨. 없으면 기본
  const g = String(grade || "").toUpperCase();
  if (g === "S") return "grade-s";
  if (g === "A") return "grade-a";
  if (g === "B") return "grade-b";
  if (g === "C") return "grade-c";
  return "grade-d";
}

function renderCategoryScores(scoresObj) {
  const scores = scoresObj && typeof scoresObj === "object" ? scoresObj : {};
  const entries = Object.entries(scores);

  if (!entries.length) {
    return `<div class="muted">세부 점수 데이터가 없습니다.</div>`;
  }

  // 점수 객체 구조가 어떻든 "label/value/priority"처럼 최대한 보여주기
  return entries
    .map(([key, val]) => {
      let score = 0;
      let grade = "";
      let comment = "";

      if (typeof val === "number") {
        score = val;
      } else if (val && typeof val === "object") {
        score = toNumber(val.score ?? val.value ?? val.points ?? 0, 0);
        grade = String(val.grade ?? "");
        comment = String(val.message ?? val.comment ?? "");
      }

      return `
        <div class="category-card">
          <div class="category-top">
            <div class="category-name">${escapeHtml(key)}</div>
            <div class="category-score">${escapeHtml(score)}</div>
          </div>
          ${grade ? `<div class="category-grade">${escapeHtml(grade)}</div>` : ""}
          ${comment ? `<div class="category-comment">${escapeHtml(comment)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderDebugLogs(logs) {
  const arr = asArray(logs);
  if (!arr.length) return `<div class="muted">로그 없음</div>`;
  return arr.map((l) => `<div class="log-line">${escapeHtml(l)}</div>`).join("");
}

function renderPaidImprovementsUI(paid) {
  const rec5 = asArray(paid.recommendedKeywords).slice(0, 5);

  // ✅ 추가추천키워드/10개 섹션은 "아예" 없음 (요구사항 반영)
  const parts = [];

  parts.push(`
    <div class="improvement-card">
      <h3>✅ 추천 대표키워드 (5개)</h3>
      ${renderTags(rec5)}
    </div>
  `);

  if (paid.unifiedText && paid.unifiedText.trim()) {
    parts.push(`
      <div class="improvement-card">
        <h3>📌 유료 컨설팅 통합본 (복사-붙여넣기)</h3>
        <div class="copy-block">${renderPre(paid.unifiedText)}</div>
      </div>
    `);
  }

  // improvements 구조가 있으면 보여주기 (description/directions/keywords 등)
  const imp = paid.improvements || null;
  if (imp && typeof imp === "object") {
    if (imp.description) {
      parts.push(`
        <div class="improvement-card">
          <h3>상세설명 개선안</h3>
          ${renderPre(imp.description)}
        </div>
      `);
    }
    if (imp.directions) {
      parts.push(`
        <div class="improvement-card">
          <h3>오시는길 개선안</h3>
          ${renderPre(imp.directions)}
        </div>
      `);
    }
    if (Array.isArray(imp.keywords) && imp.keywords.length) {
      parts.push(`
        <div class="improvement-card">
          <h3>키워드(유료 결과)</h3>
          ${renderTags(imp.keywords.slice(0, 5))}
        </div>
      `);
    }
    if (imp.competitorKeywordInsights) {
      parts.push(`
        <div class="improvement-card">
          <h3>경쟁사 키워드 인사이트</h3>
          ${renderPre(imp.competitorKeywordInsights)}
        </div>
      `);
    }
    if (imp.priceGuidance) {
      parts.push(`
        <div class="improvement-card">
          <h3>가격/메뉴 가이드</h3>
          ${renderPre(imp.priceGuidance)}
        </div>
      `);
    }
  }

  return parts.join("\n");
}

function renderCompetitorsUI(competitors) {
  const list = Array.isArray(competitors) ? competitors : [];
  if (!list.length) {
    return `
      <div class="improvement-card">
        <h3>경쟁사 Top 5</h3>
        <div class="muted">경쟁사 데이터를 가져오지 못했습니다.</div>
      </div>
    `;
  }

  return `
    <div class="improvement-card">
      <h3>🏁 경쟁사 Top ${list.length}</h3>
      <div class="competitor-list">
        ${list
          .map((c) => {
            const name = c?.name ? String(c.name) : "경쟁사";
            const address = c?.address ? String(c.address) : "";
            const reviewCount = toNumber(c?.reviewCount, 0);
            const photoCount = toNumber(c?.photoCount, 0);
            const keywords = asArray(c?.keywords || []).slice(0, 5);

            return `
              <div class="competitor-card">
                <div class="competitor-name">${escapeHtml(name)}</div>
                ${address ? `<div class="competitor-address">${escapeHtml(address)}</div>` : ""}
                <div class="competitor-meta">리뷰 ${escapeHtml(reviewCount)} · 사진 ${escapeHtml(photoCount)}</div>
                <div class="competitor-keywords">${renderTags(keywords)}</div>
              </div>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function fillCommonReport(n) {
  // place header
  setText("placeName", n.place.name || "-");
  setText("placeAddress", n.place.address || "-");

  // total score
  setText("totalScore", n.scoring.totalScore || 0);
  setText("totalGrade", n.scoring.totalGrade || "-");

  const badge = $("totalGradeBadge");
  if (badge) {
    badge.className = "grade-badge " + gradeBadgeClass(n.scoring.totalGrade);
  }

  // category scores
  setHtml("categoryScores", renderCategoryScores(n.scoring.scores));

  // debug logs
  setHtml("debugLogs", renderDebugLogs(n.logs));
  setDisplay("debugSection", true);
}

async function diagnose(mode) {
  const placeUrl = ($("placeUrl")?.value || "").trim();
  const industry = ($("industrySelect")?.value || "hairshop").trim();

  if (!placeUrl) {
    alert("네이버 플레이스 URL을 입력하세요.");
    return;
  }

  showLoading();
  clearReportSections();

  try {
    if (mode === "paid") {
      // ✅ 유료는 searchQuery가 필요
      // UI에 입력칸이 없으니: 기본값으로 "역/지역 + 업종" 조합을 자동 생성
      const placeText = placeUrl;
      const defaultQuery =
        industry === "hairshop"
          ? "서대문역 미용실"
          : industry === "cafe"
          ? "서대문역 카페"
          : "서대문역 맛집";

      const payload = {
        placeUrl: placeText,
        industry,
        searchQuery: defaultQuery
      };

      const { res, json } = await postJson("/api/diagnose/paid", payload);

      if (!res.ok || !json) {
        showError("서버 응답이 올바르지 않습니다. (paid)");
        return;
      }

      const n = normalizeServerResponse(json);

      if (!n.ok) {
        showError(n.message || "유료 진단 실패");
        // debug
        setHtml("debugLogs", `<pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`);
        setDisplay("debugSection", true);
        return;
      }

      showReport();
      fillCommonReport(n);

      // paid sections
      setHtml("improvementsSection", renderPaidImprovementsUI(n.paid));
      setDisplay("improvementsSection", true);

      setHtml("competitorsSection", renderCompetitorsUI(n.paid.competitors));
      setDisplay("competitorsSection", true);

      setDisplay("upgradeSection", false);

      return;
    }

    // free
    const payload = { placeUrl, industry };
    const { res, json } = await postJson("/api/diagnose/free", payload);

    if (!res.ok || !json) {
      showError("서버 응답이 올바르지 않습니다. (free)");
      return;
    }

    const n = normalizeServerResponse(json);

    if (!n.ok) {
      showError(n.message || "무료 진단 실패");
      setHtml("debugLogs", `<pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`);
      setDisplay("debugSection", true);
      return;
    }

    showReport();
    fillCommonReport(n);

    // ✅ 무료 진단 후 업셀 섹션 표시
    setDisplay("upgradeSection", true);
    setDisplay("improvementsSection", false);
    setDisplay("competitorsSection", false);
  } catch (e) {
    showError(String(e?.message || e));
  } finally {
    setDisplay("loadingSection", false);
  }
}

/* ====== index.html에서 직접 호출하는 함수들 ====== */
window.diagnoseFree = function diagnoseFree() {
  return diagnose("free");
};

window.diagnosePaid = function diagnosePaid() {
  // 모달 닫고 실행
  window.closePaidModal();
  return diagnose("paid");
};

window.resetDiagnosis = function resetDiagnosis() {
  // 입력 화면으로 복귀
  setDisplay("reportSection", false);
  setDisplay("loadingSection", false);
  setDisplay("errorSection", false);
  setDisplay("inputSection", true);

  // 결과 초기화
  clearReportSections();
  setText("placeName", "-");
  setText("placeAddress", "-");
  setText("totalScore", "-");
  setText("totalGrade", "-");
};

window.showPaidModal = function showPaidModal() {
  setDisplay("paidModal", true);
};

window.closePaidModal = function closePaidModal() {
  setDisplay("paidModal", false);
};
