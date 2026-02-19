import { PlaceAuditInput, ScoreBreakdown, Grade } from "./types";
import { SCORING_BY_INDUSTRY } from "./config";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function gradeFromScore(score: number): Grade {
  if (score >= 90) return "S";
  if (score >= 80) return "A";
  if (score >= 70) return "B";
  if (score >= 60) return "C";
  return "D";
}

function lenScore(text: string | undefined, minLen: number, goodLen: number): { ratio: number; note?: string } {
  const len = (text ?? "").trim().length;
  if (len <= 0) return { ratio: 0, note: "내용이 비어있음" };
  if (len < minLen) return { ratio: clamp(len / minLen, 0, 1) * 0.7, note: `글자수 부족(${len}자)` };
  if (len >= goodLen) return { ratio: 1, note: `글자수 양호(${len}자)` };
  // min~good 사이: 0.7~1.0 선형
  const t = (len - minLen) / (goodLen - minLen);
  return { ratio: 0.7 + t * 0.3, note: `글자수 보통(${len}자)` };
}

function keywordContainScore(text: string | undefined, keywords: string[], maxBoost: number): { boost: number; notes: string[] } {
  const notes: string[] = [];
  const body = (text ?? "").toLowerCase();
  if (!body || keywords.length === 0) return { boost: 0, notes };
  const hits = keywords.filter(k => k && body.includes(k.toLowerCase()));
  const ratio = hits.length / Math.max(1, keywords.length);
  const boost = clamp(ratio * maxBoost, 0, maxBoost);
  if (hits.length > 0) notes.push(`키워드 포함: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? "…" : ""}`);
  else notes.push("핵심 키워드가 본문에 거의 없음");
  return { boost, notes };
}

function simpleStructureScore(text: string | undefined): { ratio: number; notes: string[] } {
  const notes: string[] = [];
  const t = (text ?? "").trim();
  if (!t) return { ratio: 0, notes: ["구성 점수: 내용 없음"] };

  // 아주 단순 규칙: 줄바꿈/문단 있으면 가산, 너무 짧은 문장만 있으면 감점
  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length >= 3) notes.push("문단/구성 있음");
  const avgLen = t.length / Math.max(1, lines.length);
  let ratio = 0.7;
  if (lines.length >= 3) ratio += 0.2;
  if (avgLen < 25) { ratio -= 0.15; notes.push("문단 대비 내용이 너무 단문 위주"); }
  ratio = clamp(ratio, 0.4, 1);
  return { ratio, notes };
}

function signalScore(text: string | undefined, signals: string[]): { ratio: number; notes: string[] } {
  const notes: string[] = [];
  const body = (text ?? "");
  if (!body.trim()) return { ratio: 0, notes: ["핵심 안내 요소 없음"] };
  const hits = signals.filter(s => body.includes(s));
  const ratio = clamp(hits.length / Math.min(signals.length, 8), 0, 1); // 너무 과대평가 방지
  if (hits.length > 0) notes.push(`안내 요소 포함: ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? "…" : ""}`);
  else notes.push("역/출구/도보/주차 등 핵심 안내 요소 부족");
  return { ratio, notes };
}

function keywordsScore(keywords: string[] | undefined, targetCount: number, stopWords: string[]): { ratio: number; notes: string[] } {
  const notes: string[] = [];
  const list = (keywords ?? []).map(s => s.trim()).filter(Boolean);
  if (list.length === 0) return { ratio: 0, notes: ["대표키워드가 비어있음"] };

  // 개수 점수(0~0.7)
  const countRatio = clamp(list.length / targetCount, 0, 1);
  let ratio = 0.4 + countRatio * 0.3;
  notes.push(`키워드 개수: ${list.length}/${targetCount}`);

  // 중복/불용어 감점
  const uniq = new Set(list.map(s => s.toLowerCase()));
  const dupPenalty = list.length - uniq.size;
  if (dupPenalty > 0) { ratio -= 0.1; notes.push("중복 키워드 존재"); }

  const stopHit = list.filter(k => stopWords.includes(k));
  if (stopHit.length > 0) { ratio -= 0.12; notes.push(`너무 일반적인 키워드: ${stopHit.slice(0, 3).join(", ")}${stopHit.length > 3 ? "…" : ""}`); }

  ratio = clamp(ratio, 0, 1);
  return { ratio, notes };
}

function logCountRatio(count: number | undefined, target: number): { ratio: number; note: string } {
  const c = Math.max(0, count ?? 0);
  if (c <= 0) return { ratio: 0, note: "데이터 없음" };
  // 로그 스케일: target 근처면 1, 아주 적으면 낮게
  const ratio = clamp(Math.log10(c + 1) / Math.log10(target + 1), 0, 1);
  return { ratio, note: `현재 ${c} / 목표 ${target}` };
}

function recentRatio(recent30d: number | undefined, total: number | undefined): { ratio: number; note: string } {
  const r = Math.max(0, recent30d ?? 0);
  const t = Math.max(0, total ?? 0);
  if (!recent30d || !total || t === 0) return { ratio: 0.5, note: "최근성 데이터 없음(중립 처리)" };
  const ratio = clamp(r / t, 0, 1);
  return { ratio, note: `최근 30일 리뷰 비율 ${(ratio * 100).toFixed(1)}%` };
}

function menuScore(
  items: PlaceAuditInput["menuItems"],
  allowInquiryRatio: number,
  strictPriceLabel: boolean
): { ratio: number; notes: string[] } {
  const notes: string[] = [];
  const list = (items ?? []).filter(Boolean);
  if (list.length === 0) return { ratio: 0.6, notes: ["메뉴/가격 데이터 없음(중립 처리)"] };

  const texts = list.map(i => (i.priceText ?? "").trim());
  const inquiryLike = texts.filter(t => !t || /문의|변동|상담|시세/i.test(t)).length;
  const numericLike = texts.filter(t => /[0-9]/.test(t) && /(원|₩)/.test(t)).length;

  const inquiryRatio = inquiryLike / Math.max(1, texts.length);
  const numericRatio = numericLike / Math.max(1, texts.length);

  notes.push(`가격표기: 정가 ${numericLike}개 / 문의·변동 ${inquiryLike}개 (문의비율 ${(inquiryRatio * 100).toFixed(0)}%)`);

  let ratio = 0.7;

  // "문의" 허용 비율보다 높으면 감점(식당은 더 엄격)
  if (inquiryRatio > allowInquiryRatio) {
    const over = inquiryRatio - allowInquiryRatio;
    ratio -= clamp(over * (strictPriceLabel ? 1.2 : 0.8), 0, 0.5);
    notes.push("문의/변동 비율이 높아 가격 신뢰도 하락");
  } else {
    ratio += 0.15;
  }

  // 정가표기가 너무 적으면 감점(식당은 강하게)
  if (numericRatio < (strictPriceLabel ? 0.6 : 0.35)) {
    ratio -= strictPriceLabel ? 0.25 : 0.12;
    notes.push("정가 표기가 부족함");
  } else {
    ratio += 0.1;
  }

  ratio = clamp(ratio, 0, 1);
  return { ratio, notes };
}

export function scorePlace(input: PlaceAuditInput): ScoreBreakdown {
  const cfg = SCORING_BY_INDUSTRY[input.industry];
  const parts: ScoreBreakdown["parts"] = {};
  const globalNotes: string[] = [];

  // 1) Description
  {
    const max = cfg.weights.description;
    const len = lenScore(input.description, cfg.description.minLen, cfg.description.goodLen);
    const struct = simpleStructureScore(input.description);
    const kw = keywordContainScore(input.description, input.keywords ?? [], cfg.description.keywordBoost);

    // ratio(0~1): 길이 60% + 구성 25% + 키워드 15% (키워드는 boost로 처리)
    const ratio = clamp(len.ratio * 0.6 + struct.ratio * 0.25 + 0.15, 0, 1);
    const score = clamp(Math.round(max * ratio + kw.boost), 0, max);

    const notes = [
      len.note ?? "",
      ...struct.notes,
      ...kw.notes
    ].filter(Boolean);

    parts.description = { score, max, notes };
  }

  // 2) Directions
  {
    const max = cfg.weights.directions;
    const len = lenScore(input.directions, cfg.directions.minLen, cfg.directions.goodLen);
    const sig = signalScore(input.directions, cfg.directions.requireSignals);
    const kw = keywordContainScore(input.directions, input.keywords ?? [], 3);

    // 길이 55% + 신호 45% + 키워드(소폭 가산)
    const ratio = clamp(len.ratio * 0.55 + sig.ratio * 0.45, 0, 1);
    const score = clamp(Math.round(max * ratio + kw.boost), 0, max);

    const notes = [
      len.note ?? "",
      ...sig.notes,
      ...kw.notes
    ].filter(Boolean);

    parts.directions = { score, max, notes };
  }

  // 3) Keywords
  {
    const max = cfg.weights.keywords;
    const ks = keywordsScore(input.keywords, cfg.keywords.targetCount, cfg.keywords.stopWords);
    const score = clamp(Math.round(max * ks.ratio), 0, max);
    parts.keywords = { score, max, notes: ks.notes };
  }

  // 4) Reviews
  {
    const max = cfg.weights.reviews;
    const total = logCountRatio(input.reviewCount, cfg.reviews.targetCount);
    const recent = recentRatio(input.recentReviewCount30d, input.reviewCount);
    const blog = logCountRatio(input.blogReviewCount, Math.round(cfg.reviews.targetCount * 0.25));

    // 총량 60% + 최근성 30% + 블로그 10%
    const ratio = clamp(
      total.ratio * 0.6 +
      (recent.ratio * cfg.reviews.recentWeight) +
      blog.ratio * 0.1,
      0,
      1
    );

    const score = clamp(Math.round(max * ratio), 0, max);
    parts.reviews = {
      score,
      max,
      notes: [
        `방문자리뷰: ${total.note}`,
        `최근성: ${recent.note}`,
        `블로그리뷰: ${blog.note}`,
      ]
    };
  }

  // 5) Photos
  {
    const max = cfg.weights.photos;
    const pr = logCountRatio(input.photoCount, cfg.photos.targetCount);
    const score = clamp(Math.round(max * pr.ratio), 0, max);
    parts.photos = { score, max, notes: [`사진: ${pr.note}`] };
  }

  // 6) Menu/Price (optional)
  {
    const max = cfg.weights.menu;
    const ms = menuScore(input.menuItems, cfg.menu.allowInquiryRatio, cfg.menu.strictPriceLabel);
    const score = clamp(Math.round(max * ms.ratio), 0, max);
    parts.menu = { score, max, notes: ms.notes };
  }

  const total = Object.values(parts).reduce((sum, p) => sum + p.score, 0);
  const grade = gradeFromScore(total);

  // 전체 메타 코멘트(간단)
  if ((input.description ?? "").trim().length === 0) globalNotes.push("상세설명은 노출/전환에 핵심이라 반드시 채우는 게 유리");
  if ((input.directions ?? "").trim().length === 0) globalNotes.push("오시는길은 전환(방문) 관련 신호로 빈칸이면 손해");
  if ((input.keywords ?? []).length === 0) globalNotes.push("대표키워드 미설정은 검색 유입 손실 가능");

  return { total, grade, parts, notes: globalNotes };
}
