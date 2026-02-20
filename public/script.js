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

function pick(obj, paths, defVal = null) {
  // paths: ["a.b.c", "x.y"]
  for (const p of paths) {
    const parts = p.split(".");
    let cur = obj;
    let ok = true;
    for (const k of parts) {
      if (cur && typeof cur === "object" && k in cur) cur = cur[k];
      else {
        ok = false;
        break;
      }
    }
    if (ok && cur != null) return cur;
  }
  return defVal;
}

function toNumber(v, def = 0) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  const n = Number(String(v ?? "").replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : def;
}

function renderChips(items) {
  const arr = asArray(items).filter(Boolean);
  if (!arr.length) return `<div class="muted">없음</div>`;
  return `<div class="chips">${arr
    .map((x) => `<span class="chip">${escapeHtml(x)}</span>`)
    .join("")}</div>`;
}

function renderList(items) {
  const arr = asArray(items).filter(Boolean);
  if (!arr.length) return `<div class="muted">없음</div>`;
  return `<ul>${arr.map((x) => `<li>${escapeHtml(x)}</li>`).join("")}</ul>`;
}

function renderPre(text) {
  const t = String(text ?? "").trim();
  if (!t) return `<div class="muted">없음</div>`;
  return `<pre>${escapeHtml(t)}</pre>`;
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

function buildCard(title, bodyHtml) {
  return `
    <section class="card">
      <h2>${escapeHtml(title)}</h2>
      ${bodyHtml}
    </section>
  `;
}

/**
 * Normalize server response across versions.
 * - New expected structure:
 *   data.place, data.extracted, data.recommendations, data.paid, data.competitors
 * - Older/legacy structure might have:
 *   data.data, data.result, data.improvements, data.gpt, etc.
 */
function normalize(data) {
  // place
  const place = pick(data, ["place", "data.place", "result.place"], {}) || {};
  const extracted = pick(data, ["extracted", "data.extracted", "result.extracted", "data"], {}) || {};
  const diagnosis = pick(data, ["diagnosis", "data.diagnosis", "result.diagnosis"], null);

  // recommendations (대표키워드/개선문구)
  const rec = pick(data, ["recommendations", "data.recommendations"], null);
  const legacyImpr = pick(data, ["improvements", "data.improvements", "gpt", "data.gpt"], null);

  const recommendedKeywords5 =
    pick(rec, ["recommendedKeywords5"], null) ??
    pick(legacyImpr, ["recommendedKeywords5", "recommendedKeywords", "keywords5", "keywords"], null) ??
    pick(data, ["recommendedKeywords5", "recommendedKeywords"], null) ??
    [];

  const improvedDescription =
    pick(rec, ["improvedDescription"], null) ??
    pick(legacyImpr, ["improvedDescription", "description", "optimizedDescription"], null) ??
    pick(data, ["improvedDescription"], null) ??
    "";

  const improvedDirections =
    pick(rec, ["improvedDirections"], null) ??
    pick(legacyImpr, ["improvedDirections", "directions", "optimizedDirections"], null) ??
    pick(data, ["improvedDirections"], null) ??
    "";

  // paid unified
  const paid = pick(data, ["paid", "data.paid"], null);
  const unifiedText =
    pick(paid, ["unifiedText"], null) ??
    pick(legacyImpr, ["unifiedText", "paidText"], null) ??
    pick(data, ["unifiedText"], null) ??
    "";

  // competitors
  const competitors =
    pick(data, ["competitors", "data.competitors", "result.competitors"], null) ?? [];

  // extracted fields fallback
  const keywords =
    pick(extracted, ["keywords"], null) ??
    pick(data, ["keywords"], null) ??
    [];

  const description =
    pick(extracted, ["description"], null) ??
    pick(data, ["description"], null) ??
    "";

  const directions =
    pick(extracted, ["directions"], null) ??
    pick(data, ["directions"], null) ??
    "";

  const reviewsTotal =
    toNumber(pick(extracted, ["reviewsTotal", "reviewCount"], null) ?? pick(data, ["reviewsTotal", "reviewCount"], null), 0);

  const recent30d =
    toNumber(pick(extracted, ["recent30d", "recentReviewCount30d"], null) ?? pick(data, ["recent30d", "recentReviewCount30d"], null), 0);

  const photoCount =
    toNumber(pick(extracted, ["photoCount"], null) ?? pick(data, ["photoCount"], null), 0);

  return {
    place,
    extracted: { keywords, description, directions, reviewsTotal, recent30d, photoCount },
    diagnosis,
    rec: { recommendedKeywords5, improvedDescription, improvedDirections },
    unifiedText,
    competitors,
  };
}

async function analyze() {
  const inputUrlEl = $("#placeUrl");
  const planEl = $("#plan");

  const placeUrl = (inputUrlEl?.value || "").trim();
  const plan = (planEl?.value || "free").trim();

  if (!placeUrl) {
    alert("플레이스 주소를 입력해줘.");
    return;
  }

  setText("#status", "분석 중...");
  setHtml("#result", "");

  let data = null;

  try {
    const res = await fetch("/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ placeUrl, plan }),
    });

    data = await res.json().catch(() => null);

    if (!res.ok || !data) {
      setText("#status", "실패");
      setHtml("#result", `<pre>${escapeHtml(JSON.stringify(data || { ok: false }, null, 2))}</pre>`);
      return;
    }

    if (!data.ok && data.success === false) {
      // some legacy responses use success:false
      setText("#status", "실패");
      setHtml("#result", `<pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>`);
      return;
    }
  } catch (e) {
    setText("#status", "실패");
    setHtml("#result", `<pre>${escapeHtml(String(e?.message || e))}</pre>`);
    return;
  }

  setText("#status", "완료");

  const n = normalize(data);

  const place = n.place || {};
  const extracted = n.extracted || {};
  const diagnosis = n.diagnosis;
  const rec = n.rec || {};
  const competitors = Array.isArray(n.competitors) ? n.competitors : [];
  const unifiedText = n.unifiedText || "";

  const html = [];

  // 기본 정보
  html.push(
    buildCard(
      "기본 정보",
      `
      <div><b>상호</b>: ${escapeHtml(place.name || place.placeName || "")}</div>
      <div><b>카테고리</b>: ${escapeHtml(place.category || "")}</div>
      <div><b>주소</b>: ${escapeHtml(place.address || "")}</div>
      <div><b>Place ID</b>: ${escapeHtml(place.placeId || "")}</div>
      <div><b>URL</b>: <a href="${escapeHtml(placeUrl)}" target="_blank" rel="noreferrer">${escapeHtml(placeUrl)}</a></div>
    `
    )
  );

  // 추출 데이터
  html.push(
    buildCard(
      "추출 데이터",
      `
      <div class="grid2">
        <div>
          <b>대표키워드(추출)</b>
          ${renderChips(extracted.keywords || [])}
        </div>
        <div>
          <b>리뷰</b>
          <div>총 ${escapeHtml(extracted.reviewsTotal || 0)} / 최근30일 ${escapeHtml(extracted.recent30d || 0)}</div>
        </div>
      </div>

      <div style="margin-top:10px;"><b>사진 수</b>: ${escapeHtml(extracted.photoCount || 0)}</div>

      <div style="margin-top:10px;"><b>상세설명</b>${renderPre(extracted.description || "")}</div>
      <div style="margin-top:10px;"><b>오시는길</b>${renderPre(extracted.directions || "")}</div>
    `
    )
  );

  // 진단(있으면)
  if (diagnosis) {
    html.push(
      buildCard("진단 결과", `<pre>${escapeHtml(JSON.stringify(diagnosis, null, 2))}</pre>`)
    );
  }

  // ✅ 추천 대표키워드(5) + 개선안 (추가 추천 키워드/10개 섹션 없음)
  const rec5 = asArray(rec.recommendedKeywords5).filter(Boolean);
  const hasRecText =
    (rec.improvedDescription && String(rec.improvedDescription).trim()) ||
    (rec.improvedDirections && String(rec.improvedDirections).trim());

  if (rec5.length || hasRecText) {
    html.push(buildCard("추천 대표키워드 (5개)", renderChips(rec5)));

    if (rec.improvedDescription) {
      html.push(buildCard("상세설명 개선안", renderPre(rec.improvedDescription)));
    } else {
      html.push(buildCard("상세설명 개선안", `<div class="muted">불러오지 못했습니다.</div>`));
    }

    if (rec.improvedDirections) {
      html.push(buildCard("오시는길 개선안", renderPre(rec.improvedDirections)));
    } else {
      html.push(buildCard("오시는길 개선안", `<div class="muted">불러오지 못했습니다.</div>`));
    }
  } else {
    html.push(
      buildCard(
        "추천 결과",
        `<div class="muted">추천 데이터를 불러오지 못했습니다. (OPENAI 키 미설정/응답 오류 가능)</div>`
      )
    );
  }

  // 유료 통합본
  if (unifiedText && String(unifiedText).trim()) {
    html.push(buildCard("유료 컨설팅 통합본", renderPre(unifiedText)));
  }

  // 경쟁사
  if (competitors.length) {
    const lines = competitors.map((c) => {
      const name = c?.name ? String(c.name) : "";
      const id = c?.placeId ? String(c.placeId) : "";
      const url = c?.url ? String(c.url) : "";
      const label = name && id ? `${name} (${id})` : name || id || "경쟁사";

      if (url) {
        return `${label} - ${url}`;
      }
      return label;
    });

    html.push(buildCard("경쟁사 (best effort)", renderList(lines)));
  } else {
    html.push(buildCard("경쟁사", `<div class="muted">경쟁사 데이터를 가져오지 못했습니다.</div>`));
  }

  // raw debug toggle (optional)
  html.push(`
    <section class="card">
      <details>
        <summary>디버그 원본 JSON 보기</summary>
        <pre>${escapeHtml(JSON.stringify(data, null, 2))}</pre>
      </details>
    </section>
  `);

  setHtml("#result", html.join("\n"));
}

window.addEventListener("DOMContentLoaded", () => {
  const btn = $("#analyzeBtn");
  if (btn) btn.addEventListener("click", analyze);
});
