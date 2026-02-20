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

const SCORE_LABEL_MAP = {
  description: "상세설명",
  directions: "오시는길",
  keywords: "대표키워드",
  reviews: "리뷰",
  photos: "사진",
  price: "가격/메뉴"
};

function labelScoreKey(key) {
  const k = String(key || "").trim();
  return SCORE_LABEL_MAP[k] || k; // 모르는 키는 그대로
}

function normalizeServerResponse(serverJson) {
  const ok = !!serverJson?.success;
  const message = serverJson?.message || "";
  const logs = Array.isArray(serverJson?.logs) ? serverJson.logs : [];
  const data = serverJson?.data || {};

  const placeData = data.placeData || {};
  const place = {
    name: placeData.name || "",
    address: placeData.address || "",
    keywords: asArray(placeData.keywords || []),
    description: String(placeData.description || ""),
    directions: String(placeData.directions || ""),
    reviewCount: toNumber(placeData.reviewCount ?? placeData.reviewsTotal, 0),
    photoCount: toNumber(placeData.photoCount, 0),
    recent30d: toNumber(placeData.recentReviewCount30d ?? placeData.recent30d, 0),
    menuCount: toNumber(placeData.menuCount, 0)
  };

  const scoring = {
    totalScore: toNumber(data.totalScore, 0),
    totalGrade: String(data.totalGrade || ""),
    scores: data.scores || null
  };

  const paid = {
    recommendedKeywords: asArray(data.recommendedKeywords || []).slice(0, 5),
    competitors: Array.isArray(data.competitors) ? data.competitors : [],
    unifiedText: String(data.unifiedText || ""),
    improvements: data.improvements || null,
    attempts: toNumber(data.attempts, 0)
  };

  return { ok, message, logs, place, scoring, paid, raw: serverJson };
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
    return `<div style="opacity:.7;">세부 점수 데이터가 없습니다.</div>`;
  }

  // ✅ styles.css가 이미 category-card 스타일을 가지고 있음(스샷 기반)
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
            <div class="category-name">${escapeHtml(labelScoreKey(key))}</div>
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
  if (!arr.length) return `<div style="opacity:.7;">로그 없음</div>`;
  return arr.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
}

function renderKeywordChips(list) {
  const arr = asArray(list).filter(Boolean);
  if (!arr.length) return `<div style="opacity:.7;">없음</div>`;
  return `
    <div style="display:flex; flex-wrap:wrap; gap:8px;">
      ${arr
        .map(
          (t) => `<span style="display:inline-flex;align-items:center;padding:6px 10px;border-radius:999px;background:rgba(3,199,90,.12);color:#048b40;font-weight:700;font-size:13px;">${escapeHtml(
            t
          )}</span>`
        )
        .join("")}
    </div>
  `;
}

function renderPre(text) {
  const t = String(text ?? "").trim();
  if (!t) return `<div style="opacity:.7;">없음</div>`;
  return `<pre style="white-space:pre-wrap;margin:0;font-size:13px;line-height:1.55;background:rgba(0,0,0,.03);padding:12px;border-radius:12px;">${escapeHtml(
    t
  )}</pre>`;
}

function renderPaidImprovements(paid) {
  const rec5 = asArray(paid.recommendedKeywords).slice(0, 5);
  const imp = paid.improvements || {};

  const blocks = [];

  blocks.push(`
    <div class="upgrade-card" style="margin-top:12px;">
      <div class="upgrade-header">
        <h3>✅ 추천 대표키워드 (5개)</h3>
        <p>아래 5개를 플레이스 대표키워드에 그대로 넣으세요</p>
      </div>
      <div>${renderKeywordChips(rec5)}</div>
    </div>
  `);

  if (imp.description) {
    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>상세설명 개선안</h3>
          <p>복사해서 플레이스 상세설명에 붙여넣기</p>
        </div>
        ${renderPre(imp.description)}
      </div>
    `);
  }

  if (imp.directions) {
    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>오시는길 개선안</h3>
          <p>복사해서 플레이스 오시는길에 붙여넣기</p>
        </div>
        ${renderPre(imp.directions)}
      </div>
    `);
  }

  if (paid.unifiedText && paid.unifiedText.trim()) {
    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>📌 유료 컨설팅 통합본</h3>
          <p>필요한 항목을 그대로 복사-붙여넣기 하세요</p>
        </div>
        ${renderPre(paid.unifiedText)}
      </div>
    `);
  }

  return blocks.join("\n");
}

function renderCompetitors(competitors) {
  const list = Array.isArray(competitors) ? competitors : [];
  if (!list.length) {
    return `
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>🏁 경쟁사 Top 5</h3>
          <p>경쟁사 데이터를 가져오지 못했습니다. (검색어/구조/권한 문제 가능)</p>
        </div>
      </div>
    `;
  }

  const cards = list.slice(0, 5).map((c, idx) => {
    const name = c?.name ? String(c.name) : `경쟁사 ${idx + 1}`;
    const address = c?.address ? String(c.address) : "";
    const reviewCount = toNumber(c?.reviewCount, 0);
    const photoCount = toNumber(c?.photoCount, 0);
    const kws = asArray(c?.keywords || []).slice(0, 5);

    return `
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>${escapeHtml(`경쟁사 ${idx + 1}: ${name}`)}</h3>
          <p>${escapeHtml(address || "")}</p>
        </div>
        <div style="opacity:.85; margin:6px 0 10px 0;">리뷰 ${escapeHtml(reviewCount)} · 사진 ${escapeHtml(photoCount)}</div>
        ${renderKeywordChips(kws)}
      </div>
    `;
  });

  return cards.join("\n");
}

function fillCommonReport(n) {
  setText("placeName", n.place.name || "-");
  setText("placeAddress", n.place.address || "-");

  setText("totalScore", n.scoring.totalScore || 0);
  setText("totalGrade", n.scoring.totalGrade || "-");

  const badge = $("totalGradeBadge");
  if (badge) badge.className = "grade-badge " + gradeBadgeClass(n.scoring.totalGrade);

  setHtml("categoryScores", renderCategoryScores(n.scoring.scores));

  setHtml("debugLogs", renderDebugLogs(n.logs));
  setDisplay("debugSection", true);
}

async function diagnose(mode, paidSearchQuery) {
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
      const defaultQuery =
        industry === "hairshop" ? "서대문역 미용실" : industry === "cafe" ? "서대문역 카페" : "서대문역 맛집";

      const searchQuery = String(paidSearchQuery || "").trim() || defaultQuery;

      const payload = { placeUrl, industry, searchQuery };
      const { res, json } = await postJson("/api/diagnose/paid", payload);

      if (!res.ok || !json) {
        showError("서버 응답이 올바르지 않습니다. (paid)");
        return;
      }

      const n = normalizeServerResponse(json);
      if (!n.ok) {
        showError(n.message || "유료 진단 실패");
        setHtml("debugLogs", `<pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`);
        setDisplay("debugSection", true);
        return;
      }

      showReport();
      fillCommonReport(n);

      setDisplay("upgradeSection", false);

      // ✅ 유료 섹션 표시
      setHtml("improvementsSection", renderPaidImprovements(n.paid));
      setDisplay("improvementsSection", true);

      setHtml("competitorsSection", renderCompetitors(n.paid.competitors));
      setDisplay("competitorsSection", true);

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

    setDisplay("upgradeSection", true);
    setDisplay("improvementsSection", false);
    setDisplay("competitorsSection", false);
  } catch (e) {
    showError(String(e?.message || e));
  } finally {
    setDisplay("loadingSection", false);
  }
}

/* ====== index.html onclick 함수들 ====== */
window.diagnoseFree = function diagnoseFree() {
  return diagnose("free");
};

window.diagnosePaid = function diagnosePaid() {
  window.closePaidModal();

  // ✅ 유료는 검색어가 정확해야 경쟁사 데이터가 잘 나옴 → prompt로 입력 받기
  const industry = ($("industrySelect")?.value || "hairshop").trim();
  const defaultQuery =
    industry === "hairshop" ? "서대문역 미용실" : industry === "cafe" ? "서대문역 카페" : "서대문역 맛집";

  const q = window.prompt("경쟁사 분석 검색어를 입력하세요 (예: 서대문역 미용실)", defaultQuery);

  return diagnose("paid", q);
};

window.resetDiagnosis = function resetDiagnosis() {
  setDisplay("reportSection", false);
  setDisplay("loadingSection", false);
  setDisplay("errorSection", false);
  setDisplay("inputSection", true);

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
