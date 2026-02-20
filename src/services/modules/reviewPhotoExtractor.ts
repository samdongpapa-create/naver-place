/* global document, window, fetch */

const $ = (sel) => document.querySelector(sel);

function escapeHtml(str) {
  return String(str || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderList(items) {
  if (!items || !items.length) return `<div class="muted">없음</div>`;
  return `<ul>${items.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function renderChips(items) {
  if (!items || !items.length) return `<div class="muted">없음</div>`;
  return `<div class="chips">${items
    .map((x) => `<span class="chip">${escapeHtml(x)}</span>`)
    .join("")}</div>`;
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

async function analyze() {
  const url = ($("#placeUrl")?.value || "").trim();
  const plan = ($("#plan")?.value || "free").trim();

  if (!url) {
    alert("플레이스 주소를 입력해줘.");
    return;
  }

  setText("#status", "분석 중...");
  setHtml("#result", "");

  const res = await fetch("/api/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ placeUrl: url, plan }),
  });

  const data = await res.json().catch(() => null);
  if (!data || !data.ok) {
    setText("#status", "실패");
    setHtml("#result", `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`);
    return;
  }

  setText("#status", "완료");

  const place = data.place || {};
  const extracted = data.extracted || {};
  const diag = data.diagnosis || {};
  const rec = data.recommendations || null;
  const paid = data.paid || null;

  const html = [];

  html.push(`
    <section class="card">
      <h2>기본 정보</h2>
      <div><b>상호</b>: ${escapeHtml(place.name || "")}</div>
      <div><b>카테고리</b>: ${escapeHtml(place.category || "")}</div>
      <div><b>주소</b>: ${escapeHtml(place.address || "")}</div>
      <div><b>Place ID</b>: ${escapeHtml(place.placeId || "")}</div>
      <div><b>URL</b>: <a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">${escapeHtml(url)}</a></div>
    </section>
  `);

  html.push(`
    <section class="card">
      <h2>추출 데이터</h2>
      <div class="grid2">
        <div><b>대표키워드(추출)</b>${renderChips(extracted.keywords || [])}</div>
        <div><b>리뷰</b><div>총 ${escapeHtml(extracted.reviewsTotal || 0)} / 최근30일 ${escapeHtml(extracted.recent30d || 0)}</div></div>
      </div>
      <div><b>사진 수</b>: ${escapeHtml(extracted.photoCount || 0)}</div>
      <div><b>상세설명</b><pre>${escapeHtml(extracted.description || "")}</pre></div>
      <div><b>오시는길</b><pre>${escapeHtml(extracted.directions || "")}</pre></div>
    </section>
  `);

  if (diag && diag.summary) {
    html.push(`
      <section class="card">
        <h2>진단 요약</h2>
        <pre>${escapeHtml(JSON.stringify(diag, null, 2))}</pre>
      </section>
    `);
  }

  // ✅ 추천 대표키워드(5개) - 단일 필드만 사용
  if (rec) {
    html.push(`
      <section class="card">
        <h2>추천 대표키워드 (5개)</h2>
        ${renderChips(rec.recommendedKeywords5 || [])}
      </section>
    `);

    html.push(`
      <section class="card">
        <h2>상세설명 개선안</h2>
        <pre>${escapeHtml(rec.improvedDescription || "")}</pre>
      </section>
    `);

    html.push(`
      <section class="card">
        <h2>오시는길 개선안</h2>
        <pre>${escapeHtml(rec.improvedDirections || "")}</pre>
      </section>
    `);
  } else {
    html.push(`
      <section class="card">
        <h2>추천 결과</h2>
        <div class="muted">GPT 추천을 불러오지 못했습니다(키 없음/오류).</div>
      </section>
    `);
  }

  // ✅ 유료 통합본: unifiedText만 노출
  if (paid && paid.unifiedText) {
    html.push(`
      <section class="card">
        <h2>유료 컨설팅 통합본</h2>
        <pre>${escapeHtml(paid.unifiedText)}</pre>
      </section>
    `);
  }

  // ✅ 경쟁사
  if (data.competitors && data.competitors.length) {
    html.push(`
      <section class="card">
        <h2>경쟁사 (best effort)</h2>
        ${renderList(
          data.competitors.map((c) => {
            const u = c.url || "";
            const label = c.name ? `${c.name} (${c.placeId})` : `${c.placeId}`;
            return u ? `${label} - ${u}` : label;
          })
        )}
      </section>
    `);
  } else {
    html.push(`
      <section class="card">
        <h2>경쟁사</h2>
        <div class="muted">경쟁사 데이터를 가져오지 못했습니다.</div>
      </section>
    `);
  }

  setHtml("#result", html.join("\n"));
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = $("#analyzeBtn");
  if (btn) btn.addEventListener("click", analyze);
});
