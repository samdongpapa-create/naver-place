// src/services/competitorService.ts
// ✅ 아래는 "findTopPlaceIds()의 결과가 지도 TOP5에 더 가까워지도록" 후보를 재랭킹/필터링 하는 패치

type CandidateSignal = {
  placeId: string;
  name: string;
  address: string;
  keywords: string[];
  url?: string;
  score: number;
  reason: string[];
};

function norm(s: string) {
  return String(s || "").replace(/\s+/g, "").trim();
}

function extractLocalityFromQuery(q: string) {
  const qq = String(q || "").trim();
  // "서대문역 미용실" -> "서대문역"
  const m = qq.match(/([가-힣]{2,12}역)/);
  return m?.[1] || "";
}

function extractDistrictHints(q: string) {
  // 필요하면 확장 가능(간단 힌트)
  const out: string[] = [];
  const qq = String(q || "");
  if (qq.includes("서대문")) out.push("서대문");
  if (qq.includes("종로")) out.push("종로");
  if (qq.includes("광화문")) out.push("광화문");
  if (qq.includes("시청")) out.push("시청");
  return out;
}

function hasAny(text: string, words: string[]) {
  const t = String(text || "");
  return words.some((w) => w && t.includes(w));
}

// ✅ "멀리 있는 생활권"을 강하게 감점 (너가 싫어하는 명동/홍제 같은 애들 제거용)
const FAR_HINTS = [
  "명동",
  "홍제",
  "홍은",
  "종각",
  "스타필드",
  "애비뉴",
  "그랑서울", // 광화문/종로권이지만 "서대문역" 검색 TOP에선 보통 뒤로 밀림
  "아현",
  "이대",
  "충정로" // 충정로는 애매. 필요하면 빼도 됨
];

function computeMapLikeScore(params: {
  locality: string;        // "서대문역"
  districtHints: string[]; // ["서대문", ...]
  query: string;
  name: string;
  address: string;
  keywords: string[];
}) {
  const { locality, districtHints, name, address, keywords } = params;

  const n = norm(name);
  const a = norm(address);
  const kwText = norm((keywords || []).join(" "));

  const reason: string[] = [];
  let score = 0;

  const loc = norm(locality); // "서대문역"

  // 1) 이름에 "서대문역"이 있으면 거의 지도 상위권
  if (loc && n.includes(loc)) {
    score += 120;
    reason.push("name_has_locality");
  }

  // 2) 키워드에 "서대문역미용실" 같은 지역결합이 있으면 강점
  if (loc && kwText.includes(loc)) {
    score += 70;
    reason.push("kw_has_locality");
  }

  // 3) 주소에 "서대문/종로/새문안로/충정로" 등 근접 힌트가 있으면 가점
  const addrGoodHints = ["서대문", "새문안로", "충정로", "종로", "경희궁", "독립문"];
  if (hasAny(a, addrGoodHints.map(norm))) {
    score += 45;
    reason.push("addr_near_hint");
  }

  // 4) query에 포함된 구/권역 힌트가 address/kw에 있으면 가점
  for (const h of districtHints || []) {
    const hh = norm(h);
    if (!hh) continue;
    if (a.includes(hh) || kwText.includes(hh)) {
      score += 20;
      reason.push(`hint_match:${h}`);
    }
  }

  // 5) 멀리 힌트 있으면 감점 (명동/홍제 등)
  for (const fh of FAR_HINTS) {
    const f = norm(fh);
    if (!f) continue;
    if (n.includes(f) || a.includes(f) || kwText.includes(f)) {
      score -= 70;
      reason.push(`far_hint:${fh}`);
    }
  }

  // 6) “역”이 다른 역으로 강하게 잡히면 감점 (서대문역 검색인데 홍제역 같은거)
  const otherStation = (name + " " + (keywords || []).join(" ")).match(/([가-힣]{2,12}역)/g) || [];
  if (loc) {
    const other = otherStation
      .map((x) => norm(x))
      .filter((x) => x && x !== loc);
    if (other.length) {
      score -= 25;
      reason.push(`other_station:${other.slice(0, 2).join(",")}`);
    }
  }

  return { score, reason };
}

/**
 * ✅ 핵심: 후보 id들을 "가볍게 probe"해서 지도TOP5처럼 재정렬
 * - name/address/keywords만 추출하면 됨 (리뷰/사진 X)
 */
async function probeCandidateSignal(
  svc: any, // this
  placeId: string,
  industry: any
): Promise<{ name: string; address: string; keywords: string[]; url?: string }> {
  // 너 서비스에 이미 존재하는 로직을 최대한 재사용:
  // - resolvePlaceUrl(placeId, industry) 같은게 있으면 그걸 사용
  // - fetch html 후 title/주소/키워드 정규식 추출 (너 로그에서 이미 하고 있음)

  const url = await svc.resolvePlaceUrlById(placeId, industry); // ✅ 너 파일에 맞게 함수명만 맞춰줘
  const html = await svc.fetchHtml(url);                        // ✅ 너 파일에 맞게 함수명만 맞춰줘

  const name =
    (html.match(/<title>\s*([^<]+)\s*<\/title>/i)?.[1] || "")
      .replace(/\s*:\s*네이버.*$/i, "")
      .trim();

  // address는 네가 modularCrawler에서 쓰는 regex 패턴이 있을거라 그걸 재사용 권장
  const address =
    html.match(/"address"\s*:\s*"([^"]+)"/)?.[1]?.trim() ||
    html.match(/"roadAddress"\s*:\s*"([^"]+)"/)?.[1]?.trim() ||
    "";

  // keywords도 너가 이미 쓰는 패턴(문자열 배열) 재사용
  // 예: ["서대문역미용실","광화문미용실",...]
  let keywords: string[] = [];
  const km = html.match(/"keywordList"\s*:\s*(\[[^\]]*\])/);
  if (km?.[1]) {
    try {
      keywords = JSON.parse(km[1]).filter((x: any) => typeof x === "string");
    } catch {}
  }

  // fallback: 네가 이미 잡아내던 "키워드 배열 패턴" 정규식이 있으면 거기도 추가
  if (!keywords.length) {
    const km2 = html.match(/"keywords"\s*:\s*(\[[^\]]*\])/);
    if (km2?.[1]) {
      try {
        keywords = JSON.parse(km2[1]).filter((x: any) => typeof x === "string");
      } catch {}
    }
  }

  return { name, address, keywords, url };
}

/**
 * ✅ 여기만 교체하면 됨: findTopPlaceIds()
 * - 기존: id candidates 그대로 slice(0,limit)
 * - 변경: probe -> score -> sort -> top 반환
 */
export class CompetitorService {
  // ... existing fields/ctor ...

  async findTopPlaceIds(query: string, excludePlaceId?: string, limit = 5): Promise<string[]> {
    const q = String(query || "").trim();
    if (!q) return [];

    // ✅ 1) (기존 로직) searchHTML에서 후보 id 추출
    const idCandidates: string[] = await this.findPlaceIdsFromSearchHtml(q); // ✅ 너 기존 함수명에 맞춰
    const ids = (idCandidates || []).filter(Boolean);

    if (!ids.length) {
      console.log("[COMP][findTopPlaceIds] no candidates for query:", q);
      return [];
    }

    // exclude 제거
    const filtered = ids.filter((id) => String(id) !== String(excludePlaceId || ""));

    // ✅ 2) 지도TOP5 느낌을 위해 "상위 후보만 probe" (너무 많이 probe하면 느려짐)
    const probeN = Math.min(12, filtered.length); // 10~12 추천
    const toProbe = filtered.slice(0, probeN);

    const locality = extractLocalityFromQuery(q);        // "서대문역"
    const districtHints = extractDistrictHints(q);       // 쿼리 기반 힌트

    const signals: CandidateSignal[] = [];
    for (let i = 0; i < toProbe.length; i++) {
      const id = toProbe[i];
      try {
        const p = await probeCandidateSignal(this, id, "hairshop"); // ✅ industry는 호출부에서 넘기면 더 좋음
        const { score, reason } = computeMapLikeScore({
          locality,
          districtHints,
          query: q,
          name: p.name,
          address: p.address,
          keywords: p.keywords
        });

        signals.push({
          placeId: id,
          name: p.name,
          address: p.address,
          keywords: p.keywords,
          url: p.url,
          score,
          reason
        });
      } catch (e: any) {
        // probe 실패는 그냥 스킵
      }
    }

    // ✅ 3) 점수 기반 정렬
    signals.sort((a, b) => b.score - a.score);

    // ✅ 4) 너무 엉뚱한 애들 컷 (threshold)
    // - locality가 있을 때는 더 타이트하게
    const threshold = locality ? 40 : 20;
    const picked = signals.filter((s) => s.score >= threshold).slice(0, limit);

    // ✅ 5) 부족하면(컷이 너무 세면) fallback: 점수순으로 그냥 채움
    const finalIds =
      picked.length >= limit
        ? picked.map((x) => x.placeId)
        : signals.slice(0, limit).map((x) => x.placeId);

    console.log(
      "[COMP][findTopPlaceIds] reranked:",
      finalIds.map((id) => {
        const s = signals.find((x) => x.placeId === id);
        return `${id}:${s?.score ?? "?"}:${s?.name ?? ""}`;
      })
    );

    return finalIds;
  }

  // =========================
  // ✅ 아래 두 개는 "너 기존 코드"에 이미 있을 확률이 높음.
  // - 이름만 맞춰서 연결해줘.
  // =========================

  async findPlaceIdsFromSearchHtml(query: string): Promise<string[]> {
    // 기존 searchHTML 파싱 로직 사용
    // return [...]
    throw new Error("not-implemented");
  }

  async resolvePlaceUrlById(placeId: string, industry: any): Promise<string> {
    // 기존 resolve 로직 사용
    // ex) https://m.place.naver.com/hairshop/{id}/home
    throw new Error("not-implemented");
  }

  async fetchHtml(url: string): Promise<string> {
    // 기존 fetch 로직 사용
    throw new Error("not-implemented");
  }

  // close()는 이미 너가 try/catch로 감싸고 있으니 없어도 됨
}
