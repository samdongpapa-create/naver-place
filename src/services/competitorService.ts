import { fetchWithUA } from "../utils/urlHelper";

type CompetitorItem = {
  placeId: string;
  name?: string;
  url?: string;
};

function uniq<T>(arr: T[]) {
  return Array.from(new Set(arr));
}

function extractPlaceIdsFromHTML(html: string): string[] {
  const ids: string[] = [];

  // 1) JSON style: "placeId":"1234567890"
  {
    const re = /"placeId"\s*:\s*"(\d{5,12})"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[1]);
  }

  // 2) URL style: /place/123456 or /hairshop/123456/home etc
  {
    const re = /\/(?:place|hairshop|restaurant|cafe|hotel|accommodation|hospital|clinic|academy|beauty|shopping|culture|service)\/(\d{5,12})(?:\/|["'?])/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[1]);
  }

  // 3) m.place style: m.place.naver.com/.../123456
  {
    const re = /m\.place\.naver\.com\/[a-zA-Z]+\/(\d{5,12})/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) ids.push(m[1]);
  }

  return uniq(ids);
}

function extractAnchorsFromHTML(html: string): CompetitorItem[] {
  // best effort: find anchor tags linking to place pages
  // Note: HTML is huge; keep simple regex
  const items: CompetitorItem[] = [];
  const re = /<a[^>]+href="([^"]+)"[^>]*>(.*?)<\/a>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = m[1];
    const text = (m[2] || "").replace(/<[^>]*>/g, "").trim();
    const idMatch =
      href.match(/\/(?:place|hairshop|restaurant|cafe|hotel|accommodation|hospital|clinic|academy|beauty)\/(\d{5,12})/) ||
      href.match(/m\.place\.naver\.com\/[a-zA-Z]+\/(\d{5,12})/);
    if (idMatch) {
      items.push({
        placeId: idMatch[1],
        name: text || undefined,
        url: href.startsWith("http") ? href : `https://m.place.naver.com${href}`,
      });
    }
  }
  return items;
}

export class CompetitorService {
  /**
   * Query Naver mobile place search page (or blog-like search) and attempt to extract top competitor placeIds.
   * This is fragile by nature; we do multiple extraction strategies.
   */
  static async findTopPlaceIds(query: string, max = 5): Promise<string[]> {
    if (!query || query.trim().length < 2) return [];

    // Use Naver place search on mobile. This may change; keep broad.
    const url = `https://m.search.naver.com/search.naver?where=m&sm=mtp_hty.top&query=${encodeURIComponent(
      query
    )}`;

    try {
      const { text: html } = await fetchWithUA(url);
      if (!html) return [];

      // 1) Try anchor extraction
      const anchors = extractAnchorsFromHTML(html);
      const fromAnchors = anchors.map((a) => a.placeId).filter(Boolean);

      // 2) Fallback: raw HTML regex scanning
      const fromHTML = extractPlaceIdsFromHTML(html);

      // merge, keep order preference anchors first
      const merged = uniq([...fromAnchors, ...fromHTML]).slice(0, max);
      return merged;
    } catch {
      return [];
    }
  }

  static async getCompetitors(query: string, max = 5): Promise<CompetitorItem[]> {
    const ids = await this.findTopPlaceIds(query, max);
    return ids.map((id) => ({
      placeId: id,
      url: `https://m.place.naver.com/place/${id}/home`,
    }));
  }
}
