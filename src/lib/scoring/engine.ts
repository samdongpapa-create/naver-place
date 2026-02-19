import { CONFIG } from "./config";
import { Grade, PlaceScoringInput, ScoringOutput, ScoreResult100 } from "./types";

const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n));

function grade100(score: number): Grade {
  if (score >= 95) return "S";
  if (score >= 85) return "A";
  if (score >= 70) return "B";
  if (score >= 55) return "C";
  if (score >= 40) return "D";
  return "F";
}

function lenRatio(text: string | undefined, minLen: number, goodLen: number) {
  const len = (text ?? "").trim().length;
  if (len <= 0) return { ratio: 0, len, note: "내용이 비어있습니다." };
  if (len < minLen) return { ratio: clamp(len / minLen, 0, 1) * 0.7, len, note: `글자수 부족(${len}자)` };
  if (len >= goodLen) return { ratio: 1, len, note: `글자수 양호(${len}자)` };
  const t = (len - minLen) / (goodLen - minLen);
  return { ratio: 0.7 + t * 0.3, len, note: `글자수 보통(${len}자)` };
}

function containsKeywordBoost(text: string | undefined, keywords: string[], maxBoost: number) {
  const body = (text ?? "").toLowerCase();
  if (!body || keywords.length === 0) return { boost: 0, note: "키워드 매칭 평가 불가" };
  const hits = keywords.filter(k => k && body.includes(k.toLowerCase()));
  const ratio = hits.length / Math.max(1, Math.min(5, keywords.length));
  const boost = Math.round(clamp(ratio * maxBoost, 0, maxBoost));
  if (hits.length === 0) return { boost, note: "대표키워드가 본문에 거의 포함되지 않습니다." };
  return { boost, note: `본문에 포함된 대표키워드: ${hits.slice(0, 3).join(", ")}${hits.length > 3 ? "…" : ""}` };
}

function structureRatio(text: string | undefined) {
  const t = (text ?? "").trim();
  if (!t) return { ratio: 0, note: "구성 평가 불가(빈 내용)" };
  const lines = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
  const avgLen = t.length / Math.max(1, lines.length);

  let ratio = 0.7;
  if (lines.length >= 3) ratio += 0.2; // 문단 존재
  if (avgLen < 25) ratio -= 0.15; // 너무 단문
  ratio = clamp(ratio, 0.4, 1);
  return { ratio, note: lines.length >= 3 ? "문단/구성이 있습니다." : "문단이 거의 없습니다(가독성 개선 여지)." };
}

function signalRatio(text: string | undefined, signals: string[]) {
  const body = (text ?? "");
  if (!body.trim()) return { ratio: 0, note: "핵심 안내 요소가 없습니다." };
  const hits = signals.filter(s => body.includes(s));
  const ratio = clamp(hits.length / Math.min(8, signals.length), 0, 1);
  if (hits.length === 0) return { ratio, note: "역/출구/도보/주차 등 핵심 정보가 부족합니다." };
  return { ratio, note: `포함된 안내 요소: ${hits.slice(0, 6).join(", ")}${hits.length > 6 ? "…" : ""}` };
}

function keywordScore100(keywords: string[] | undefined, targetCount: number, stopWords: string[]): ScoreResult100 {
  const issues: string[] = [];
  const list = (keywords ?? []).map(s => s.trim()).filter(Boolean);

  if (list.length === 0) return { score: 0, grade: grade100(0), issues: ["대표키워드가 설정되지 않았습니다."] };

  // 1) 개수(최대 5) : 0~70
  const countRatio = clamp(list.length / targetCount, 0, 1);
  let score = Math.round(40 + countRatio * 30);
  issues.push(`키워드 개수: ${list.length}/${targetCount}`);

  // 2) 중복 감점
  const uniq = new Set(list.map(s => s.toLowerCase()));
  if (uniq.size < list.length) {
    score -= 10;
    issues.push("중복 키워드가 있습니다.");
  }

  // 3) 너무 일반적인 단어 감점(정확히 stopWords에 포함된 것만)
  const stopHit = list.filter(k => stopWords.includes(k));
  if (stopHit.length > 0) {
    score -= 12;
    issues.push(`너무 일반적인 키워드: ${stopHit.slice(0, 3).join(", ")}${stopHit.length > 3 ? "…" : ""}`);
  }

  score = clamp(score, 0, 100);
  return { score, grade: grade100(score), issues };
}

function logCountScore100(count: number | undefined, target: number, label: string): { score: number; issue: string } {
  const c = Math.max(0, count ?? 0);
  if (c <= 0) return { score: 0, issue: `${label} 데이터가 없습니다.` };
  // 로그스케일로 완만하게
  const ratio = clamp(Math.log10(c + 1) / Math.log10(target + 1), 0, 1);
  const score = Math.round(ratio * 100);
  return { score, issue: `${label}: 현재 ${c} / 목표 ${target}` };
}

function recentScore100(recent30d: number | undefined, total: number | undefined) {
  const r = Math.max(0, recent30d ?? 0);
  const t = Math.max(0, total ?? 0);

  // 최근성 데이터 없으면 중립 60점
  if (recent30d === undefined) return { score: 60, issue: "최근리뷰 데이터 없음(중립 처리)" };
  if (t <= 0) return { score: 0, issue: "총 리뷰가 없어 최근성 평가 불가" };

  // 비율 기반
  const ratio = clamp(r / t, 0, 1);
  // 0%면 20점, 10%면 50점, 30%면 80점, 50%면 95점
  let score = 20;
  if (ratio >= 0.5) score = 95;
  else if (ratio >= 0.3) score = 80;
  else if (ratio >= 0.1) score = 50;
  else score = 30;

  return { score, issue: `최근 30일 리뷰 비율 ${(ratio * 100).toFixed(1)}%` };
}

function priceScore100(input: PlaceScoringInput, allowInquiryRatio: number, strict: boolean): ScoreResult100 {
  const issues: string[] = [];

  const menuCount = input.menuCount ?? 0;
  const menus = Array.isArray(input.menus) ? input.menus : [];

  // 메뉴 데이터 자체가 없으면 “중립” 처리(크롤링 못한 케이스 대응)
  if (input.menuCount === undefined && menus.length === 0) {
    const score = 60;
    issues.push("가격/메뉴 데이터를 수집하지 못했습니다(중립 처리).");
    return { score, grade: grade100(score), issues };
  }

  if (menuCount <= 0 && menus.length === 0) {
    return { score: 0, grade: grade100(0), issues: ["가격/메뉴가 없거나 노출되지 않습니다."] };
  }

  // 1) 메뉴 수 점수(기본)
  const countBase =
    menuCount >= 30 ? 100 :
    menuCount >= 20 ? 92 :
    menuCount >= 10 ? 80 :
    menuCount >= 5 ? 60 :
    40;

  let score = countBase;
  issues.push(`총 메뉴 수: ${menuCount || menus.length}개`);

  // 2) 가격표기 품질(목록 있을 때만)
  if (menus.length > 0) {
    const total = menus.length;

    const hasNumericPrice = (p: string) => /[0-9][0-9,]*\s*원/.test(p || "");
    const isInquiry = (p: string) => /문의|별도|상담|협의|변동/.test(p || "");

    const priced = menus.filter(m => hasNumericPrice(m.price)).length;
    const inquiry = menus.filter(m => isInquiry(m.price)).length;

    const pricedRatio = priced / total;
    const inquiryRatio = inquiry / total;

    issues.push(`정가표기 ${priced}개 / 문의·변동 ${inquiry}개 (문의비율 ${Math.round(inquiryRatio * 100)}%)`);

    // 식당/카페: 정가표기 기준 엄격
    const needPriced = strict ? 0.6 : 0.35;
    if (pricedRatio < needPriced) {
      score -= strict ? 25 : 12;
      issues.push(`정가 표기 비율이 낮습니다 (${Math.round(pricedRatio * 100)}%).`);
    }

    // 업종별 문의 허용 기준
    if (inquiryRatio > allowInquiryRatio) {
      score -= strict ? 25 : 15;
      issues.push("‘문의/변동’ 비율이 높습니다(가격 신뢰도 하락).");
    }
  } else {
    issues.push("메뉴 상세 목록이 없어 메뉴 수 중심으로만 평가했습니다.");
  }

  score = clamp(score, 0, 100);
  return { score, grade: grade100(score), issues };
}

export function scorePlace(input: PlaceScoringInput): ScoringOutput {
  const cfg = CONFIG[input.industry];
  const kwList = (input.keywords ?? []).map(s => s.trim()).filter(Boolean);

  // description (세부 분배: 글자수 60 + 구성 25 + 키워드 가산 max)
  const descIssues: string[] = [];
  const descLen = lenRatio(input.description, cfg.description.minLen, cfg.description.goodLen);
  const descStruct = structureRatio(input.description);
  const descBoost = containsKeywordBoost(input.description, kwList, cfg.description.keywordBoostMax);

  let descScore = Math.round(descLen.ratio * 60 + descStruct.ratio * 25);
  descScore += descBoost.boost;
  descScore = clamp(descScore, 0, 100);

  descIssues.push(descLen.note, descStruct.note, descBoost.note);

  const description: ScoreResult100 = { score: descScore, grade: grade100(descScore), issues: descIssues.filter(Boolean) };

  // directions (세부 분배: 글자수 55 + 신호 45 + 키워드 소폭 가산 5)
  const dirIssues: string[] = [];
  const dirLen = lenRatio(input.directions, cfg.directions.minLen, cfg.directions.goodLen);
  const dirSig = signalRatio(input.directions, cfg.directions.signals);
  const dirBoost = containsKeywordBoost(input.directions, kwList, 5);

  let dirScore = Math.round(dirLen.ratio * 55 + dirSig.ratio * 45);
  dirScore += dirBoost.boost;
  dirScore = clamp(dirScore, 0, 100);

  dirIssues.push(dirLen.note, dirSig.note, dirBoost.note);

  const directions: ScoreResult100 = { score: dirScore, grade: grade100(dirScore), issues: dirIssues.filter(Boolean) };

  // keywords
  const keywords = keywordScore100(kwList, cfg.keywords.targetCount, cfg.keywords.stopWords);

  // reviews (총량 + 최근성)
  const revIssues: string[] = [];
  const total = logCountScore100(input.reviewCount, cfg.reviews.targetCount, "방문자리뷰");
  const recent = recentScore100(input.recentReviewCount30d, input.reviewCount);

  // total 70 + recent 30(가중치 적용)
  const reviewsScore = clamp(
    Math.round(total.score * (1 - cfg.reviews.recentWeight) + recent.score * cfg.reviews.recentWeight),
    0,
    100
  );

  revIssues.push(total.issue, recent.issue);

  const reviews: ScoreResult100 = { score: reviewsScore, grade: grade100(reviewsScore), issues: revIssues };

  // photos
  const photoIssues: string[] = [];
  const ph = logCountScore100(input.photoCount, cfg.photos.targetCount, "사진");
  photoIssues.push(ph.issue);
  const photos: ScoreResult100 = { score: ph.score, grade: grade100(ph.score), issues: photoIssues };

  // price
  const price = priceScore100(input, cfg.price.allowInquiryRatio, cfg.price.strictPriceLabel);

  const scores = { description, directions, keywords, reviews, photos, price };

  // 총점: 업종별 가중치 합산
  const w = cfg.weights;
  const totalScore = Math.round(
    (scores.description.score * w.description +
      scores.directions.score * w.directions +
      scores.keywords.score * w.keywords +
      scores.reviews.score * w.reviews +
      scores.photos.score * w.photos +
      scores.price.score * w.price) / 100
  );

  const totalGrade = grade100(totalScore);

  return { scores, totalScore, totalGrade };
}
