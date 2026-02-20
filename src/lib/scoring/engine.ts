import { CONFIG } from "./config";
import { Grade, PlaceScoringInput, ScoringOutput, ScoreResult100, Industry } from "./types";

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
  if (lines.length >= 3) ratio += 0.2;
  if (avgLen < 25) ratio -= 0.15;
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

/* ---------------------------
   ✅ 키워드 점수 확장 (세부 breakdown 제공)
   - count(0~50)
   - dedupe(0~10)
   - stopwordPenalty(0~-10)
   - locality(0~15) : 주소/역명 기반 지역커버
   - intent(0~15)   : 추천/후기/가격/예약 등 검색 의도
   - industryFit(0~20) : 업종 핵심 단어 포함
---------------------------- */
function keywordScore100Expanded(
  input: PlaceScoringInput,
  targetCount: number,
  stopWords: string[]
): ScoreResult100 {
  const issues: string[] = [];
  const raw = (input.keywords ?? []).map(s => String(s).trim()).filter(Boolean);

  if (raw.length === 0) {
    return {
      score: 0,
      grade: grade100(0),
      issues: ["대표키워드가 설정되지 않았습니다."],
      breakdown: { count: 0, dedupe: 0, stopwordPenalty: 0, locality: 0, intent: 0, industryFit: 0 },
      meta: { targetCount }
    };
  }

  const lower = raw.map(s => s.toLowerCase());
  const uniq = Array.from(new Set(lower));
  const dupCount = raw.length - uniq.length;

  // 1) count: 0~50
  const countRatio = clamp(raw.length / targetCount, 0, 1);
  const countScore = Math.round(countRatio * 50);

  // 2) dedupe: 0~10 (중복 없으면 10, 중복 있으면 비례 감점)
  const dedupeScore = dupCount <= 0 ? 10 : Math.max(0, 10 - Math.min(10, dupCount * 5));

  // 3) stopword penalty: 0 ~ -10
  const stopHit = raw.filter(k => stopWords.includes(k));
  const stopwordPenalty = stopHit.length <= 0 ? 0 : -Math.min(10, stopHit.length * 5);

  // 4) locality: 0~15 (주소/역명/핵심 지명 커버)
  const localityTokens = extractLocalityTokens(input.name, input.address);
  const localityHits = localityTokens.filter(tok => lower.some(k => k.includes(tok.toLowerCase())));
  const localityRatio = localityTokens.length ? clamp(localityHits.length / Math.min(3, localityTokens.length), 0, 1) : 0;
  const localityScore = Math.round(localityRatio * 15);

  // 5) intent: 0~15 (검색 의도)
  const intentTokens = ["추천", "후기", "리뷰", "가격", "예약", "잘하는", "근처", "best", "베스트"];
  const intentHits = intentTokens.filter(tok => lower.some(k => k.includes(tok.toLowerCase())));
  const intentRatio = clamp(intentHits.length / 3, 0, 1);
  const intentScore = Math.round(intentRatio * 15);

  // 6) industryFit: 0~20 (업종 핵심)
  const fitTokens = industryFitTokens(input.industry);
  const fitHits = fitTokens.filter(tok => lower.some(k => k.includes(tok.toLowerCase())));
  const fitRatio = clamp(fitHits.length / 3, 0, 1);
  const industryFitScore = Math.round(fitRatio * 20);

  // 합산
  let score =
    countScore +
    dedupeScore +
    localityScore +
    intentScore +
    industryFitScore +
    stopwordPenalty;

  score = clamp(score, 0, 100);

  // issues 구성
  issues.push(`키워드 개수: ${raw.length}/${targetCount} (count ${countScore}/50)`);
  issues.push(dupCount > 0 ? `중복 키워드 ${dupCount}개 → dedupe ${dedupeScore}/10` : `중복 없음 → dedupe ${dedupeScore}/10`);

  if (stopHit.length > 0) {
    issues.push(`너무 일반적인 키워드 감점: ${stopHit.slice(0, 3).join(", ")}${stopHit.length > 3 ? "…" : ""} (${stopwordPenalty}점)`);
  } else {
    issues.push(`일반 단어 감점 없음 (0점)`);
  }

  if (localityTokens.length > 0) {
    issues.push(
      localityHits.length > 0
        ? `지역 커버: ${localityHits.slice(0, 3).join(", ")} (locality ${localityScore}/15)`
        : `지역 키워드가 부족합니다(역/동/구 등) (locality ${localityScore}/15)`
    );
  } else {
    issues.push(`주소 기반 지역 토큰 추출 실패 (locality ${localityScore}/15)`);
  }

  issues.push(
    intentHits.length > 0
      ? `검색 의도 포함: ${intentHits.slice(0, 3).join(", ")} (intent ${intentScore}/15)`
      : `추천/후기/가격/예약 등 검색 의도 키워드가 부족합니다 (intent ${intentScore}/15)`
  );

  issues.push(
    fitHits.length > 0
      ? `업종 적합도: ${fitHits.slice(0, 3).join(", ")} (industryFit ${industryFitScore}/20)`
      : `업종 핵심 키워드가 부족합니다 (industryFit ${industryFitScore}/20)`
  );

  return {
    score,
    grade: grade100(score),
    issues,
    breakdown: {
      count: countScore,
      dedupe: dedupeScore,
      stopwordPenalty,
      locality: localityScore,
      intent: intentScore,
      industryFit: industryFitScore
    },
    meta: {
      targetCount,
      localityTokens: localityTokens.slice(0, 6),
      localityHits: localityHits.slice(0, 6),
      intentHits: intentHits.slice(0, 6),
      fitHits: fitHits.slice(0, 6)
    }
  };
}

function extractLocalityTokens(name?: string, address?: string): string[] {
  const tokens: string[] = [];
  const nm = (name ?? "").trim();
  const ad = (address ?? "").trim();

  // 주소에서 시/구/동/로/길 추출 (너무 길면 컷)
  if (ad) {
    const parts = ad.split(/\s+/).map(s => s.trim()).filter(Boolean);

    // 예: "서울 종로구 새문안로 15-1 2층"
    // -> 종로구, 새문안로 같은 것
    for (const p of parts) {
      if (/^(서울|부산|대구|인천|광주|대전|울산|세종)/.test(p)) continue;
      if (/(구|군|시|동|로|길|읍|면)$/.test(p) && p.length <= 10) tokens.push(p);
    }
  }

  // 이름에서 "OO역" 추출
  if (nm) {
    const m = nm.match(/([가-힣]{2,8})역/);
    if (m?.[1]) {
      tokens.push(`${m[1]}역`);
      tokens.push(m[1]);
    }
  }

  // 중복 제거 + 상위 몇개만
  const uniq = Array.from(new Set(tokens.map(t => t.trim()).filter(Boolean)));
  return uniq.slice(0, 6);
}

function industryFitTokens(industry: Industry): string[] {
  if (industry === "hairshop") {
    return ["미용실", "헤어", "커트", "컷", "펌", "염색", "클리닉", "매직", "볼륨", "다운펌", "레이어드", "단발"];
  }
  if (industry === "cafe") {
    return ["카페", "커피", "라떼", "디저트", "베이커리", "브런치", "케이크", "아메리카노", "테이크아웃"];
  }
  return ["맛집", "식당", "점심", "저녁", "가성비", "정식", "코스", "예약", "포장", "배달"];
}

function logCountScore100(count: number | undefined, target: number, label: string): { score: number; issue: string } {
  const c = Math.max(0, count ?? 0);
  if (c <= 0) return { score: 0, issue: `${label} 데이터가 없습니다.` };

  // 로그스케일로 완만하게
  const ratio = clamp(Math.log10(c + 1) / Math.log10(target + 1), 0, 1);
  const score = Math.round(ratio * 100);

  // ✅ 목표값은 내부 계산만 하고, UI 혼란 방지를 위해 issue 문구에서 제거
  return { score, issue: `${label}: 현재 ${c}` };
}

function recentScore100(recent30d: number | undefined, total: number | undefined) {
  const r = Math.max(0, recent30d ?? 0);
  const t = Math.max(0, total ?? 0);

  if (recent30d === undefined) return { score: 60, issue: "최근리뷰 데이터 없음(중립 처리)" };
  if (t <= 0) return { score: 0, issue: "총 리뷰가 없어 최근성 평가 불가" };

  const ratio = clamp(r / t, 0, 1);

  let score = 20;
  if (ratio >= 0.5) score = 95;
  else if (ratio >= 0.3) score = 80;
  else if (ratio >= 0.1) score = 50;
  else score = 30;

  return { score, issue: `최근 30일 리뷰 비율 ${(ratio * 100).toFixed(1)}% (최근 ${r}개)` };
}

function priceScore100(input: PlaceScoringInput, allowInquiryRatio: number, strict: boolean): ScoreResult100 {
  const issues: string[] = [];

  const menuCount = input.menuCount ?? 0;
  const menus = Array.isArray(input.menus) ? input.menus : [];

  if (input.menuCount === undefined && menus.length === 0) {
    const score = 60;
    issues.push("가격/메뉴 데이터를 수집하지 못했습니다(중립 처리).");
    return { score, grade: grade100(score), issues };
  }

  if (menuCount <= 0 && menus.length === 0) {
    return { score: 0, grade: grade100(0), issues: ["가격/메뉴가 없거나 노출되지 않습니다."] };
  }

  const countBase =
    menuCount >= 30 ? 100 :
    menuCount >= 20 ? 92 :
    menuCount >= 10 ? 80 :
    menuCount >= 5 ? 60 :
    40;

  let score = countBase;
  issues.push(`총 메뉴 수: ${menuCount || menus.length}개`);

  if (menus.length > 0) {
    const total = menus.length;

    const hasNumericPrice = (p: string) => /[0-9][0-9,]*\s*원/.test(p || "");
    const isInquiry = (p: string) => /문의|별도|상담|협의|변동/.test(p || "");

    const priced = menus.filter(m => hasNumericPrice(m.price)).length;
    const inquiry = menus.filter(m => isInquiry(m.price)).length;

    const pricedRatio = priced / total;
    const inquiryRatio = inquiry / total;

    issues.push(`정가표기 ${priced}개 / 문의·변동 ${inquiry}개 (문의비율 ${Math.round(inquiryRatio * 100)}%)`);

    const needPriced = strict ? 0.6 : 0.35;
    if (pricedRatio < needPriced) {
      score -= strict ? 25 : 12;
      issues.push(`정가 표기 비율이 낮습니다 (${Math.round(pricedRatio * 100)}%).`);
    }

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

  // description (글자수 60 + 구성 25 + 키워드 가산 max)
  const descIssues: string[] = [];
  const descLen = lenRatio(input.description, cfg.description.minLen, cfg.description.goodLen);
  const descStruct = structureRatio(input.description);
  const descBoost = containsKeywordBoost(input.description, kwList, cfg.description.keywordBoostMax);

  let descScore = Math.round(descLen.ratio * 60 + descStruct.ratio * 25);
  descScore += descBoost.boost;
  descScore = clamp(descScore, 0, 100);

  descIssues.push(descLen.note, descStruct.note, descBoost.note);

  const description: ScoreResult100 = { score: descScore, grade: grade100(descScore), issues: descIssues.filter(Boolean) };

  // directions (글자수 55 + 신호 45 + 키워드 소폭 가산 5)
  const dirIssues: string[] = [];
  const dirLen = lenRatio(input.directions, cfg.directions.minLen, cfg.directions.goodLen);
  const dirSig = signalRatio(input.directions, cfg.directions.signals);
  const dirBoost = containsKeywordBoost(input.directions, kwList, 5);

  let dirScore = Math.round(dirLen.ratio * 55 + dirSig.ratio * 45);
  dirScore += dirBoost.boost;
  dirScore = clamp(dirScore, 0, 100);

  dirIssues.push(dirLen.note, dirSig.note, dirBoost.note);

  const directions: ScoreResult100 = { score: dirScore, grade: grade100(dirScore), issues: dirIssues.filter(Boolean) };

  // ✅ keywords (확장판)
  const keywords = keywordScore100Expanded(input, cfg.keywords.targetCount, cfg.keywords.stopWords);

  // reviews (총량 + 최근성)
  const revIssues: string[] = [];
  const total = logCountScore100(input.reviewCount, cfg.reviews.targetCount, "방문자리뷰");
  const recent = recentScore100(input.recentReviewCount30d, input.reviewCount);

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
