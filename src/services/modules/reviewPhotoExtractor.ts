import { Page } from "playwright";

/**
 * Review/Photo extractor (robust)
 * - reviews: total visitor review count (best effort)
 * - recent30d: visitor reviews in last 30 days (best effort)
 * - photoCount: robust fallback (network/HTML/DOM/img-count)
 *
 * IMPORTANT:
 * Naver Place frequently changes structure.
 * We prefer:
 * 1) Network / embedded JSON keys
 * 2) HTML regex patterns
 * 3) DOM text scanning
 * 4) img thumbnail counting (minimum estimate)
 */

type ReviewPhotoResult = {
  reviewsTotal: number;
  recent30d: number;
  photoCount: number;
};

function safeInt(v: any, def = 0) {
  const n = Number(String(v).replace(/[^\d]/g, ""));
  return Number.isFinite(n) ? n : def;
}

function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

function isWithinLastDays(date: Date, days: number) {
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  return diff >= 0 && diff <= days * 24 * 60 * 60 * 1000;
}

function parseKoreanReviewDate(text: string): Date | null {
  // common patterns:
  // 2026.02.10
  // 2026-02-10
  // 2.10. (year omitted) -> assume current year
  const t = text.trim();

  // YYYY.MM.DD
  let m = t.match(/(20\d{2})\.(\d{1,2})\.(\d{1,2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // YYYY-MM-DD
  m = t.match(/(20\d{2})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    const y = Number(m[1]);
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  // M.D. (year omitted)
  m = t.match(/(^|\s)(\d{1,2})\.(\d{1,2})\.(\s|$)/);
  if (m) {
    const y = new Date().getFullYear();
    const mo = Number(m[2]) - 1;
    const d = Number(m[3]);
    const dt = new Date(y, mo, d);
    return isNaN(dt.getTime()) ? null : dt;
  }

  return null;
}

function extractAllNumbersNearKeywords(html: string, keywords: string[]) {
  // returns array of numbers near any of the keywords (broad heuristic)
  const nums: number[] = [];
  for (const kw of keywords) {
    const re = new RegExp(`${kw}[^\\d]{0,40}(\\d{1,7})`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      nums.push(safeInt(m[1], 0));
    }
  }
  return nums;
}

function bestCandidate(nums: number[], min = 0, max = 10_000_000) {
  const filtered = nums.filter((n) => Number.isFinite(n) && n >= min && n <= max);
  if (!filtered.length) return 0;
  // choose the maximum as best estimate
  return filtered.sort((a, b) => b - a)[0];
}

async function getPageHTML(page: Page) {
  try {
    return await page.content();
  } catch {
    return "";
  }
}

async function scanDOMTextForPhotoCount(page: Page): Promise<number> {
  try {
    const text = await page.evaluate(() => document.body?.innerText || "");
    if (!text) return 0;

    // patterns:
    // 사진 1,234
    // 사진(123)
    // 업체사진 123
    // 포토 123
    // 이미지 123
    const patterns = [
      /업체\s*사진\s*[\(\[]?\s*([0-9,]{1,10})\s*[\)\]]?/g,
      /사진\s*[\(\[]?\s*([0-9,]{1,10})\s*[\)\]]?/g,
      /포토\s*[\(\[]?\s*([0-9,]{1,10})\s*[\)\]]?/g,
      /이미지\s*[\(\[]?\s*([0-9,]{1,10})\s*[\)\]]?/g,
    ];

    const found: number[] = [];
    for (const re of patterns) {
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const n = safeInt(m[1], 0);
        if (n > 0) found.push(n);
      }
    }
    return bestCandidate(found);
  } catch {
    return 0;
  }
}

async function countPhotoThumbnailsAsMinimum(page: Page): Promise<number> {
  // fallback: count images likely used in photo grid (minimum estimate)
  try {
    const n = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll("img"));
      // try to filter out logos/icons by size/alt/src patterns
      const candidates = imgs.filter((img) => {
        const src = (img.getAttribute("src") || "").toLowerCase();
        if (!src) return false;
        if (src.includes("data:image")) return false;
        if (src.includes("logo")) return false;
        if (src.includes("icon")) return false;
        // Naver CDN / thumbnails often contain "type=" or "w=" etc, but keep broad
        return true;
      });
      return candidates.length;
    });

    // photo page includes many images; we clamp to realistic lower bounds.
    // If only a few images, treat as 0 (not reliable).
    if (!n || n < 6) return 0;
    return n;
  } catch {
    return 0;
  }
}

async function robustPhotoCount(page: Page): Promise<number> {
  const html = await getPageHTML(page);
  if (!html) return 0;

  // 1) Strict-ish known keys (but broader than before)
  // We scan for multiple candidate keys frequently used in embedded JSON.
  const keyCandidates = [
    "photoCount",
    "photoTotalCount",
    "totalPhotoCount",
    "totalCount",
    "imageCount",
    "imagesCount",
    "photoCnt",
    "photo_cnt",
    "photo",
    "photos",
    "photoTotal",
    "totalPhotos",
    "totalImages",
    "mediaCount",
    "mediaTotalCount",
    "contentCount",
  ];

  const keyNums: number[] = [];
  for (const key of keyCandidates) {
    // "photoCount":1234 or "photoCount": "1234"
    const re = new RegExp(`"${key}"\\s*:\\s*"?([0-9,]{1,10})"?`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const n = safeInt(m[1], 0);
      if (n > 0) keyNums.push(n);
    }
  }
  const keyBest = bestCandidate(keyNums);
  if (keyBest > 0) return keyBest;

  // 2) HTML regex near Korean words
  const nearNums = extractAllNumbersNearKeywords(html, ["업체사진", "사진", "포토", "이미지"]);
  const nearBest = bestCandidate(nearNums);
  if (nearBest > 0) return nearBest;

  // 3) DOM text scan (innerText)
  const domBest = await scanDOMTextForPhotoCount(page);
  if (domBest > 0) return domBest;

  // 4) Thumbnail count (minimum estimate)
  const thumb = await countPhotoThumbnailsAsMinimum(page);
  if (thumb > 0) return thumb;

  return 0;
}

async function extractReviewTotalFromHTML(html: string): Promise<number> {
  // patterns:
  // 방문자리뷰 1,927 · 블로그리뷰 393
  // 방문자 리뷰 1,927
  const patterns = [
    /방문\s*자?\s*리뷰\s*([0-9,]{1,10})/g,
    /방문자리뷰\s*([0-9,]{1,10})/g,
    /방문자\s*리뷰\s*([0-9,]{1,10})/g,
  ];
  const found: number[] = [];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(html))) {
      const n = safeInt(m[1], 0);
      if (n > 0) found.push(n);
    }
  }
  return bestCandidate(found);
}

async function extractRecent30dReviews(page: Page, reviewUrl: string): Promise<number> {
  try {
    await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(800);

    const html = await getPageHTML(page);
    if (!html) return 0;

    // Try to parse date strings that appear in review list
    // We'll grab likely date patterns, parse, then count within 30 days.
    const datePatterns = [
      /\b20\d{2}\.\d{1,2}\.\d{1,2}\b/g,
      /\b20\d{2}-\d{1,2}-\d{1,2}\b/g,
      /\b\d{1,2}\.\d{1,2}\.\b/g,
    ];

    const dates: Date[] = [];
    for (const re of datePatterns) {
      const matches = html.match(re) || [];
      for (const s of matches) {
        const dt = parseKoreanReviewDate(s);
        if (dt) dates.push(dt);
      }
    }

    // De-dup dates (stringify by y-m-d)
    const uniq = new Map<string, Date>();
    for (const d of dates) {
      const key = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
      if (!uniq.has(key)) uniq.set(key, d);
    }

    const list = Array.from(uniq.values());
    const count = list.filter((d) => isWithinLastDays(d, 30)).length;

    // Heuristic: This undercounts when multiple reviews share date.
    // But it gives a stable minimum; better than 0.
    return clamp(count, 0, 99999);
  } catch {
    return 0;
  }
}

export async function extractReviewAndPhoto(
  page: Page,
  homeUrl: string,
  photoUrl: string,
  reviewListUrl: string
): Promise<ReviewPhotoResult> {
  let reviewsTotal = 0;
  let recent30d = 0;
  let photoCount = 0;

  // 1) Go home and parse review total from HTML (best-effort)
  try {
    await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
    await page.waitForTimeout(800);
    const homeHtml = await getPageHTML(page);
    if (homeHtml) {
      reviewsTotal = await extractReviewTotalFromHTML(homeHtml);
    }
  } catch {
    // ignore
  }

  // 2) recent 30 days review count (best-effort)
  if (reviewListUrl) {
    recent30d = await extractRecent30dReviews(page, reviewListUrl);
  }

  // 3) photo count (robust)
  if (photoUrl) {
    try {
      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 45000 });
      await page.waitForTimeout(900);
      photoCount = await robustPhotoCount(page);
    } catch {
      photoCount = 0;
    }
  }

  return {
    reviewsTotal: safeInt(reviewsTotal, 0),
    recent30d: safeInt(recent30d, 0),
    photoCount: safeInt(photoCount, 0),
  };
}
