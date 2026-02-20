/* global document, window, fetch */

const $ = (sel) => document.querySelector(sel);

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

function setText(sel, text) {
  const el = $(sel);
  if (!el) return;
  el.textContent = text == null ? "" : String(text);
}

function setHtml(sel, html) {
  const el = $(sel);
  if (!el) return;
  el.innerHTML = html == null ? "" : String(html);
}

function renderChips(items) {
  const arr = asArray(items).filter(Boolean);
  if (!arr.length) return `<div class="muted">없음</div>`;
  return `<div class="chips">${arr.map((x) => `<span class="chip">${escapeHtml(x)}</span>`).join("")}</div>`;
}

function renderPre(text) {
  const t = String(text ?? "").trim();
  if (!t) return `<div class="muted">없음</div>`;
  return `<pre>${escapeHtml(t)}</pre>`;
}

function buildCard(title, bodyHtml) {
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      ${bodyHtml}
    </section>
  `;
}

function pick(obj, path, defVal = null) {
  const parts = String(path).split(".");
  let cur = obj;
  for (const k of parts) {
    if (cur && typeof cur === "object" && k in cur) cur = cur[k];
    else return defVal;
  }
  return cur == null ? defVal : cur;
}

function normalizeResponse(serverJson) {
  // 서버: { success, data, logs, message }
  const ok = !!serverJson?.success;
  const message = serverJson?.message || "";
  const logs = Array.isArray(serverJson?.logs) ? serverJson.logs : [];

  const data = serverJson?.data || {};

  // place data
  const placeData = data.placeData || {};
  const name = placeData.name || "";
  const address = placeData.address || "";
  const keywords = asArray(placeData.keywords || []);
  const description = placeData.description || "";
  const directions = placeData.directions || "";
  const reviewCount = toNumber(placeData.reviewCount ?? placeData.reviewsTotal, 0);
  const photoCount = toNumber(placeData.photoCount, 0);
  const recent30d = toNumber(placeData.recentReviewCount30d ?? placeData.recent30d, 0);

  // scores
  const totalScore = toNumber(data.totalScore, 0);
  const totalGrade = data.totalGrade || "";
  const scores = data.scores || null;

  // paid extras
  const recommendedKeywords = asArray(data.recommendedKeywords || []);
  const competitors = Array.isArray(data.competitors) ? data.competitors : [];
  const unifiedText = data.unifiedText || "";

  // improvements (paid)
  const improvements = data.improvements || null;

  return {
    ok,
    message,
    logs,
    placeData: { name, address, keywords, description, directions, reviewCount, photoCount, recent30d },
    scoring: { totalScore, totalGrade, scores },
    paid: { recommendedKeywords, competitors, unifiedText, improvements }
  };
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

function getValueByAnyId(ids) {
  for (const id of ids) {
    const el = document.getElementById(id);
    if (el && typeof el.value === "string") return el.value.trim();
  }
  return "";
}

async function analyze() {
  // ✅ 다양한 UI 버전 대응 (id가 조금 달라도 동작)
  const placeUrl = getValueByAnyId(["placeUrl", "url", "place_url"]);
  const plan = (getValueByAnyId(["plan", "mode"]) || "free").toLowerCase();
  const industry = (getValueByAnyId(["industry"]) || "hairshop").toLowerCase();
  const searchQuery = getValueByAnyId(["searchQuery", "query", "competitorQuery"]);

  if (!placeUrl) {
    alert("플레이스 주소를 입력해줘.");
    return;
  }

  // ✅ paid면 searchQuery 필수
  if (plan === "paid" && !searchQuery) {
    alert("유료 진단은 경쟁사 분석용 '검색어'가 필요해. (예: 서대문역 미용실)");
    return;
  }

  setText("#status", "분석 중...");
  setHtml("#result", "");

  const endpoint = plan === "paid" ? "/api/diagnose/paid" : "/api/diagnose/free";
  const payload = plan === "paid"
    ? { placeUrl, industry, searchQuery }
    : { placeUrl, industry };

  let res, json;
  try {
    const r = await postJson(endpoint, payload);
    res = r.res;
    json = r.json;
  } catch (e) {
    setText("#status", "실패");
    setHtml("#result", `<pre>${escapeHtml(String(e?.message || e))}</pre>`);
    return;
  }

  if (!res.ok || !json) {
    setText("#status", "실패");
    setHtml("#result", `<pre>${escapeHtml(JSON.stringify(json || { success: false, message: "응답 없음" }, null, 2))}</pre>`);
    return;
  }

  const n = normalizeResponse(json);

  if (!n.ok) {
    setText("#status", "실패");
    setHtml("#result", `
      ${buildCard("오류", `<pre>${escapeHtml(n.message || "진단 실패")}</pre>`)}
      ${buildCard("디버그 원본", `<pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>`)}
    `);
    return;
  }

  setText("#status", "완료");

  const html = [];

  html.push(
    buildCard("기본 정보", `
      <div><b>상호</b>: ${escapeHtml(n.placeData.name)}</div>
      <div><b>주소</b>: ${escapeHtml(n.placeData.address)}</div>
      <div style="margin-top:8px;"><b>리뷰</b>: ${escapeHtml(n.placeData.reviewCount)} (최근30일 ${escapeHtml(n.placeData.recent30d)})</div>
      <div><b>사진 수</b>: ${escapeHtml(n.placeData.photoCount)}</div>
    `)
  );

  html.push(
    buildCard("추출 대표키워드", renderChips(n.placeData.keywords))
  );

  html.push(
    buildCard("상세설명", renderPre(n.placeData.description))
  );

  html.push(
    buildCard("오시는길", renderPre(n.placeData.directions))
  );

  html.push(
    buildCard("점수", `
      <div><b>Total</b>: ${escapeHtml(n.scoring.totalScore)}점 / ${escapeHtml(n.scoring.totalGrade)}</div>
      <details style="margin-top:10px;">
        <summary>세부 점수 보기</summary>
        <pre>${escapeHtml(JSON.stringify(n.scoring.scores, null, 2))}</pre>
      </details>
    `)
  );

  if (plan === "paid") {
    // ✅ 추천 대표키워드 5개
    html.push(buildCard("추천 대표키워드 (5개)", renderChips(n.paid.recommendedKeywords)));

    // ✅ 유료 통합본
    if (n.paid.unifiedText && String(n.paid.unifiedText).trim()) {
      html.push(buildCard("유료 컨설팅 통합본", renderPre(n.paid.unifiedText)));
    }

    // 경쟁사
    if (n.paid.competitors && n.paid.competitors.length) {
      const list = n.paid.competitors.map((c) => {
        const name = c?.name ? String(c.name) : "경쟁사";
        const addr = c?.address ? String(c.address) : "";
        const rc = toNumber(c?.reviewCount, 0);
        const pc = toNumber(c?.photoCount, 0);
        const kws = asArray(c?.keywords || []).slice(0, 5).join(", ");
        return `• ${name}${addr ? " / " + addr : ""} (리뷰 ${rc}, 사진 ${pc})\n  - ${kws}`;
      }).join("\n");

      html.push(buildCard("경쟁사 (best effort)", `<pre>${escapeHtml(list)}</pre>`));
    } else {
      html.push(buildCard("경쟁사", `<div class="muted">경쟁사 데이터를 가져오지 못했습니다.</div>`));
    }
  }

  // 로그/원본 (문제 생기면 이거 복사해서 보내면 됨)
  html.push(buildCard("크롤링 로그", `<pre>${escapeHtml((n.logs || []).join("\n"))}</pre>`));

  html.push(`
    <section class="card">
      <details>
        <summary>서버 원본 JSON 보기</summary>
        <pre>${escapeHtml(JSON.stringify(json, null, 2))}</pre>
      </details>
    </section>
  `);

  setHtml("#result", html.join("\n"));
}

function bind() {
  // ✅ 버튼 클릭
  const btn = $("#analyzeBtn") || $("#diagnoseBtn") || document.querySelector('[data-action="analyze"]');
  if (btn) btn.addEventListener("click", analyze);

  // ✅ 폼 submit도 지원
  const form = document.querySelector("form");
  if (form) {
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      analyze();
    });
  }
}

window.addEventListener("DOMContentLoaded", bind);
