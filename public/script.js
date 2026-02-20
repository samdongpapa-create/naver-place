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

function normalizeServerResponse(serverJson) {
  // server: { success, data, logs, message }
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
    predictedAfter: data.predictedAfter || null,
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
  // styles.css가 이 클래스들을 안 갖고 있어도 UI가 깨지진 않게 하되,
  // 있으면 적용되도록만.
  const g = String(grade || "").toUpperCase();
  if (g === "S") return "grade-s";
  if (g === "A") return "grade-a";
  if (g === "B") return "grade-b";
  if (g === "C") return "grade-c";
  return "grade-d";
}

/** ✅ styles.css 몰라도 카드/칩 형태가 유지되도록 inline 스타일로 보장 */
function card(title, bodyHtml) {
  return `
    <div style="background:#fff; border:1px solid rgba(0,0,0,.06); border-radius:14px; padding:14px; margin:12px 0; box-shadow:0 4px 12px rgba(0,0,0,.04);">
      <div style="font-weight:800; font-size:15px; margin-bottom:10px;">${escapeHtml(title)}</div>
      <div>${bodyHtml}</div>
    </div>
  `;
}

function chips(items) {
  const arr = asArray(items).filter(Boolean);
  if (!arr.length) return `<div style="opacity:.7;">없음</div>`;
  return `
    <div style="display:flex; flex-wrap:wrap; gap:8px;">
      ${arr
        .map(
          (t) => `
        <span style="display:inline-flex; align-items:center; padding:6px 10px; border-radius:999px; background:rgba(3,199,90,.12); color:#048b40; font-weight:700; font-size:13px;">
          ${escapeHtml(t)}
        </span>
      `
        )
        .join("")}
    </div>
  `;
}

function pre(text) {
  const t = String(text ?? "").trim();
  if (!t) return `<div style="opacity:.7;">없음</div>`;
  return `<pre style="white-space:pre-wrap; margin:0; font-size:13px; line-height:1.55; background:rgba(0,0,0,.03); padding:12px; border-radius:12px;">${escapeHtml(
    t
  )}</pre>`;
}

function renderCategoryScores(scoresObj) {
  const scores = scoresObj && typeof scoresObj === "object" ? scoresObj : {};
  const entries = Object.entries(scores);

  if (!entries.length) {
    return `<div style="opacity:.7;">세부 점수 데이터가 없습니다.</div>`;
  }

  // 기존 category-grid 안에 들어가므로, grid 레이아웃은 styles.css가 처리
  // 만약 styles.css가 그리드를 안 잡아도 카드 형태는 inline으로 보장
  return entries
    .map(([key, val]) => {
      let score = 0;
      let msg = "";

      if (typeof val === "number") {
        score = val;
      } else if (val && typeof val === "object") {
        score = toNumber(val.score ?? val.value ?? val.points ?? 0, 0);
        msg = String(val.message ?? val.comment ?? "");
      }

      return `
        <div style="background:#fff; border:1px solid rgba(0,0,0,.06); border-radius:14px; padding:12px; box-shadow:0 4px 12px rgba(0,0,0,.04);">
          <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;">
            <div style="font-weight:800;">${escapeHtml(key)}</div>
            <div style="font-weight:900; font-size:18px;">${escapeHtml(score)}</div>
          </div>
          ${msg ? `<div style="margin-top:6px; font-size:12px; opacity:.75;">${escapeHtml(msg)}</div>` : ""}
        </div>
      `;
    })
    .join("");
}

function renderDebugLogs(logs) {
  const arr = asArray(logs);
  if (!arr.length) return `<div style="opacity:.7;">로그 없음</div>`;
  return `
    <div style="font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace; font-size:12px; line-height:1.6;">
      ${arr.map((l) => `<div>${escapeHtml(l)}</div>`).join("")}
    </div>
  `;
}

function fillCommonReport(n) {
  setText("placeName", n.place.name || "-");
  setText("placeAddress", n.place.address || "-");

  setText("totalScore", n.scoring.totalScore || 0);
  setText("totalGrade", n.scoring.totalGrade || "-");

  const badge = $("totalGradeBadge");
  if (badge) {
    badge.className = "grade-badge " + gradeBadgeClass(n.scoring.totalGrade);
  }

  setHtml("categoryScores", renderCategoryScores(n.scoring.scores));

  setHtml("debugLogs", renderDebugLogs(n.logs));
  setDisplay("debugSection", true);
}

function renderPaidSections(n) {
  // ✅ improvementsSection에 "추천 대표키워드 5개 + 통합본 + 개선안 일부"만 넣음
  const imp = n.paid.improvements || {};
  const rec5 = n.paid.recommendedKeywords || [];
  const blocks = [];

  blocks.push(card("✅ 추천 대표키워드 (5개)", chips(rec5)));

  // 개선안(있으면)
  if (imp.description) blocks.push(card("상세설명 개선안", pre(imp.description)));
  if (imp.directions) blocks.push(card("오시는길 개선안", pre(imp.directions)));

  // 통합본(있으면)
  if (n.paid.unifiedText && n.paid.unifiedText.trim()) {
    blocks.push(card("📌 유료 컨설팅 통합본 (복사-붙여넣기)", pre(n.paid.unifiedText)));
  }

  setHtml("improvementsSection", blocks.join("\n"));
  setDisplay("improvementsSection", true);

  // ✅ competitorsSection
  const comps = Array.isArray(n.paid.competitors) ? n.paid.competitors : [];
  if (!comps.length) {
    setHtml("competitorsSection", card("🏁 경쟁사 Top 5", `<div style="opacity:.7;">경쟁사 데이터를 가져오지 못했습니다.</div>`));
    setDisplay("competitorsSection", true);
    return;
  }

  const compHtml = comps
    .slice(0, 5)
    .map((c, idx) => {
      const name = c?.name ? String(c.name) : `경쟁사 ${idx + 1}`;
      const address = c?.address ? String(c.address) : "";
      const reviewCount = toNumber(c?.reviewCount, 0);
      const photoCount = toNumber(c?.photoCount, 0);
      const kws = asArray(c?.keywords || []).slice(0, 5);

      return card(
        `경쟁사 ${idx + 1}: ${name}`,
        `
        ${address ? `<div style="opacity:.8; margin-bottom:8px;">${escapeHtml(address)}</div>` : ""}
        <div style="opacity:.85; margin-bottom:10px;">리뷰 ${escapeHtml(reviewCount)} · 사진 ${escapeHtml(photoCount)}</div>
        <div>${chips(kws)}</div>
      `
      );
    })
    .join("\n");

  setHtml("competitorsSection", compHtml);
  setDisplay("competitorsSection", true);
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
      // ✅ UI에 검색어 입력칸이 없으니 기본값 자동 적용(필요시 나중에 입력칸 추가 가능)
      const defaultQuery =
        industry === "hairshop" ? "서대문역 미용실" : industry === "cafe" ? "서대문역 카페" : "서대문역 맛집";

      const payload = { placeUrl, industry, searchQuery: defaultQuery };
      const { res, json } = await postJson("/api/diagnose/paid", payload);

      if (!res.ok || !json) {
        showError("서버 응답이 올바르지 않습니다. (paid)");
        return;
      }

      const n = normalizeServerResponse(json);
      if (!n.ok) {
        showError(n.message || "유료 진단 실패");
        setHtml("debugLogs", pre(JSON.stringify(json, null, 2)));
        setDisplay("debugSection", true);
        return;
      }

      showReport();
      fillCommonReport(n);

      // 유료 섹션 표시
      setDisplay("upgradeSection", false);
      renderPaidSections(n);

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
      setHtml("debugLogs", pre(JSON.stringify(json, null, 2)));
      setDisplay("debugSection", true);
      return;
    }

    showReport();
    fillCommonReport(n);

    // 무료 진단 후 업셀 섹션 표시
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
  return diagnose("paid");
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
