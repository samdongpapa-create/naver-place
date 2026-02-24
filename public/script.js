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

/** ✅ 강력 매핑: 키가 조금 달라도 한국어로 바꿔줌 */
function normalizeScoreKey(rawKey) {
  const k = String(rawKey || "").trim();
  const low = k.toLowerCase();

  // 포함 기반(photosScore, review_count 등도 잡힘)
  if (low.includes("desc")) return "상세설명";
  if (low.includes("description")) return "상세설명";

  if (low.includes("direction")) return "오시는길";
  if (low.includes("route")) return "오시는길";
  if (low.includes("way")) return "오시는길";

  if (low.includes("keyword")) return "대표키워드";
  if (low.includes("tag")) return "대표키워드";

  if (low.includes("review")) return "리뷰";
  if (low.includes("visitor")) return "리뷰";

  if (low.includes("photo")) return "사진";
  if (low.includes("image")) return "사진";
  if (low.includes("media")) return "사진";

  if (low.includes("price")) return "가격/메뉴";
  if (low.includes("menu")) return "가격/메뉴";

  // 이미 한글이면 그대로
  if (/[가-힣]/.test(k)) return k;

  return k; // 마지막 fallback
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
    improvements: data.improvements || null
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

function renderCategoryScores(scoresObj, explainObj) {
  const scores = scoresObj && typeof scoresObj === "object" ? scoresObj : {};
  const explain = explainObj && typeof explainObj === "object" ? explainObj : {};
  const entries = Object.entries(scores);

  if (!entries.length) return "";

  const renderList = (items) => {
    const arr = asArray(items);
    if (!arr.length) return "";
    return `<ul class="mini-list">${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
  };

  return entries
    .map(([key, val]) => {
      let score = 0;
      let comment = "";

      if (typeof val === "number") {
        score = val;
      } else if (val && typeof val === "object") {
        score = toNumber(val.score ?? val.value ?? val.points ?? 0, 0);
        comment = String(val.message ?? val.comment ?? "");
      }

      const ex = explain[key] || null;
      const good = ex?.good || [];
      const bad = ex?.bad || [];

      return `
        <div class="category-card">
          <div class="category-top">
            <div class="category-name">${escapeHtml(normalizeScoreKey(key))}</div>
            <div class="category-score">${escapeHtml(score)}</div>
          </div>
          ${comment ? `<div class="category-comment">${escapeHtml(comment)}</div>` : ""}
          ${
            ex
              ? `
            <div class="score-explain">
              ${good.length ? `<div class="good"><div class="label">잘하고 있음</div>${renderList(good.slice(0,3))}</div>` : ""}
              ${bad.length ? `<div class="bad"><div class="label">부족한 점</div>${renderList(bad.slice(0,3))}</div>` : ""}
            </div>
          `
              : ""
          }
        </div>
      `;
    })
    .join("");
}

function renderDebugLogs(logs) {
  const arr = asArray(logs);
  if (!arr.length) return "";
  return arr.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
}

function renderKeywordChips(list) {
  const arr = asArray(list).filter(Boolean);
  if (!arr.length) return `<div style="opacity:.7;">없음</div>`;
  return `
    <div style="display:flex; flex-wrap:wrap; gap:8px; margin-top:8px;">
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
  return `<pre style="white-space:pre-wrap;margin:10px 0 0 0;font-size:13px;line-height:1.55;background:rgba(0,0,0,.03);padding:12px;border-radius:12px;">${escapeHtml(
    t
  )}</pre>`;
}

function fillCommonReport(n) {
  setText("placeName", n.place.name || "-");
  setText("placeAddress", n.place.address || "-");

  setText("totalScore", n.scoring.totalScore || 0);
  setText("totalGrade", n.scoring.totalGrade || "-");

  const badge = $("totalGradeBadge");
  if (badge) badge.className = "grade-badge " + gradeBadgeClass(n.scoring.totalGrade);

  setHtml("categoryScores", renderCategoryScores(n.scoring.scores, n.scoring.scoreExplain));

  setHtml("debugLogs", renderDebugLogs(n.logs));
  setDisplay("debugSection", true);
}

function renderPaidBlocks(paid) {
  const rec5 = asArray(paid.recommendedKeywords).slice(0, 5);
  const imp = paid.improvements || {};

  const blocks = [];

  blocks.push(`
    <div class="upgrade-card" style="margin-top:12px;">
      <div class="upgrade-header">
        <h3>✅ 추천 대표키워드 (5개)</h3>
        <p>아래 5개를 플레이스 대표키워드에 그대로 넣으세요</p>
      </div>
      ${renderKeywordChips(rec5)}
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

function renderCompetitors(paid) {
  const list = Array.isArray(paid?.competitorsSimple) ? paid.competitorsSimple : (Array.isArray(paid?.competitors) ? paid.competitors : []);
  const add5 = asArray(paid?.additionalRecommendedKeywords || []).slice(0, 5);

  const blocks = [];

  // 경쟁사
  if (!list.length) {
    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>🏁 경쟁업체 TOP5</h3>
          <p>경쟁사 데이터를 가져오지 못했습니다. (검색어/노출 구조 영향)</p>
        </div>
      </div>
    `);
  } else {
    const rows = list.slice(0, 5).map((c, idx) => {
      const name = c?.name ? String(c.name) : `경쟁사 ${idx + 1}`;
      const kws = asArray(c?.keywords || []).slice(0, 5).join(", ");
      return `<li><b>${escapeHtml(name)}</b> : ${escapeHtml(kws || "(키워드 없음)")}</li>`;
    }).join("");

    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>🏁 경쟁업체 TOP5 (심플)</h3>
          <p>“상호명 : 대표키워드” 형식</p>
        </div>
        <ul class="simple-list">${rows}</ul>
      </div>
    `);
  }

  // 추가 추천 키워드 5개
  if (add5.length) {
    blocks.push(`
      <div class="upgrade-card" style="margin-top:12px;">
        <div class="upgrade-header">
          <h3>➕ 경쟁사 기반 추가 추천 키워드 (5개)</h3>
          <p>대표키워드 5개와 별개로, 블로그/리뷰/본문에 자연스럽게 활용</p>
        </div>
        ${renderKeywordChips(add5)}
      </div>
    `);
  }

  return blocks.join("\n");
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
      const q = ($("paidSearchQuery")?.value || "").trim(); // ✅ 모달 입력 사용
      const payload = { placeUrl, industry, searchQuery: q };

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

      setHtml("improvementsSection", renderPaidBlocks(n.paid));
      setDisplay("improvementsSection", true);

      setHtml("competitorsSection", renderCompetitors(n.paid.competitors));
      setDisplay("competitorsSection", true);

      return;
    }

    // free
    const { res, json } = await postJson("/api/diagnose/free", { placeUrl, industry });

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
window.diagnoseFree = function () {
  return diagnose("free");
};

window.diagnosePaid = function () {
  window.closePaidModal();

  // ✅ 입력 없으면 기본값 자동 세팅(서버도 한 번 더 보정함)
  const industry = ($("industrySelect")?.value || "hairshop").trim();
  const defaultQuery =
    industry === "hairshop" ? "서대문역 미용실" : industry === "cafe" ? "서대문역 카페" : "서대문역 맛집";
  const el = $("paidSearchQuery");
  if (el && !String(el.value || "").trim()) el.value = defaultQuery;

  return diagnose("paid");
};

window.resetDiagnosis = function () {
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

window.showPaidModal = function () {
  // 모달 열 때 기본 검색어 자동 넣기
  const industry = ($("industrySelect")?.value || "hairshop").trim();
  const defaultQuery =
    industry === "hairshop" ? "서대문역 미용실" : industry === "cafe" ? "서대문역 카페" : "서대문역 맛집";
  const el = $("paidSearchQuery");
  if (el && !String(el.value || "").trim()) el.value = defaultQuery;

  setDisplay("paidModal", true);
};

window.closePaidModal = function () {
  setDisplay("paidModal", false);
};
