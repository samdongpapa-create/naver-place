// src/services/naverMapAllSearch.ts
type AllSearchPlaceItem = {
  id?: string;
  name?: string;
};

type AllSearchResponse = {
  result?: {
    place?: {
      list?: AllSearchPlaceItem[];
    };
  };
};

function pickRandomUA() {
  // 너무 복잡하게 안 가고, "정상 브라우저" 느낌만 주는 최소 UA
  const pool = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
  ];
  return pool[Math.floor(Math.random() * pool.length)];
}

function buildReferer(query: string) {
  // 글에서 언급된 referer 패턴을 그대로 사용 (검색 페이지에서 온 것처럼)
  const q = encodeURIComponent(query);
  return `https://map.naver.com/p/search/${q}?c=15.00,0,0,0,dh`;
}

export async function findTopPlaceIdsViaAllSearch(query: string, topN = 5): Promise<string[]> {
  const url = new URL("https://map.naver.com/p/api/search/allSearch");

  // ✅ searchCoord가 아예 없으면 결과가 흔들릴 수 있어서 "서울 시청" 근처로 기본값.
  // 필요하면 ENV로 바꿔도 됨.
  const searchCoord = process.env.NAVER_MAP_SEARCH_COORD ?? "126.9780;37.5665"; // lng;lat
  const boundary = process.env.NAVER_MAP_BOUNDARY ?? ""; // 비워도 동작하는 케이스 많음

  url.searchParams.set("query", query);
  url.searchParams.set("type", "all");
  url.searchParams.set("searchCoord", searchCoord);
  url.searchParams.set("boundary", boundary);
  url.searchParams.set("page", "1");

  const ua = pickRandomUA();
  const referer = buildReferer(query);

  const res = await fetch(url.toString(), {
    method: "GET",
    headers: {
      "accept": "application/json, text/plain, */*",
      "accept-language": "ko-KR,ko;q=0.9,en-US;q=0.6,en;q=0.4",
      "user-agent": ua,
      "referer": referer,
    },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`[allSearch] HTTP ${res.status} ${res.statusText} body=${text.slice(0, 300)}`);
  }

  const data = (await res.json()) as AllSearchResponse;

  const list = data?.result?.place?.list ?? [];
  const ids = list
    .map((x) => (x?.id ? String(x.id) : ""))
    .filter(Boolean);

  // 중복 제거 + topN
  return Array.from(new Set(ids)).slice(0, topN);
}
