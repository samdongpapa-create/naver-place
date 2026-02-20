import { Page, Frame, Response } from "playwright";

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string,
    categorySlug?: string
  ): Promise<{ reviewCount: number; photoCount: number; recentReviewCount30d?: number; logs: string[] }> {
    const logs: string[] = [];
    logs.push("[리뷰&사진] 추출 시작");

    let reviewCount = 0;
    let photoCount = 0;
    let recentReviewCount30d: number | undefined = undefined;

    try {
      // =========================
      // 1) 리뷰 총량: home에서 추출
      // =========================
      const homeUrl = this.buildUrl("home", placeId, categorySlug);
      logs.push(`[리뷰&사진] 홈 이동(리뷰 기준): ${homeUrl}`);

      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      if (!categorySlug) {
        const redirectedSlug = this.detectSlugFromUrl(page.url());
        if (redirectedSlug) {
          categorySlug = redirectedSlug;
          logs.push(`[리뷰&사진] redirect slug 보정: ${categorySlug}`);
        }
      }

      const homeHtml = await page.content();

      reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi,
        /리뷰\s*([0-9,]+)/gi
      ]);

      logs.push(`[리뷰&사진] 리뷰 최댓값: ${reviewCount}`);
      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}`);

      // =========================
      // 2) 최근 30일 리뷰 수
      // =========================
      const reviewUrls = this.buildVisitorReviewUrls(placeId, categorySlug);

      for (const u of reviewUrls) {
        try {
          logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 시도: ${u}`);

          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(1500);

          if (!categorySlug) {
            const redirectedSlug = this.detectSlugFromUrl(page.url());
            if (redirectedSlug) {
              categorySlug = redirectedSlug;
              logs.push(`[리뷰&사진] (review) redirect slug 보정: ${categorySlug}`);
            }
          }

          const reviewHtml = await page.content();
          const parsedDates = this.countParsedDates(reviewHtml);
          const cnt30 = this.countRecentReviewsFromHtml(reviewHtml, 30);

          logs.push(`[리뷰&사진] 날짜 파싱 개수: ${parsedDates}, 최근30일 카운트: ${cnt30}`);

          if (parsedDates >= 3) {
            recentReviewCount30d = cnt30;
            logs.push(`[리뷰&사진] 최근 30일 리뷰 수 확정: ${recentReviewCount30d}`);
            break;
          }
        } catch (e: any) {
          logs.push(`[리뷰&사진] 최근리뷰 URL 실패: ${u} (${e?.message || String(e)})`);
          continue;
        }
      }

      // =========================
      // 3) 사진 수: photo 탭 (✅ totalCount 오탐 제거 + 업체사진 DOM 카운트)
      // =========================
      const photoUrl = this.buildUrl("photo", placeId, categorySlug);
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      // ✅ 네트워크로 "사진 관련 키"만 수집
      const net = this.createPhotoNetworkCollector(placeId, logs);
      page.on("response", net.onResponse);

      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2200);

      // lazy load 유도
      await this.scrollNudge(page);
      await page.waitForTimeout(1200);

      // redirect slug 보정
      if (!categorySlug) {
        const redirectedSlug = this.detectSlugFromUrl(page.url());
        if (redirectedSlug) {
          categorySlug = redirectedSlug;
          logs.push(`[리뷰&사진] (photo) redirect slug 보정: ${categorySlug}`);
        }
      }

      // ✅ 1차: 네트워크에서 photoCount(best)
      const netPhoto = net.getBest();
      logs.push(`[리뷰&사진] 네트워크 photoCount(best, strict keys only): ${netPhoto || 0}`);
      if (netPhoto > 0) photoCount = netPhoto;

      // ✅ 2차: “업체사진” 필터/칩/탭 클릭 시도 후, 썸네일 개수 카운트
      // (업체 등록 사진이 적으면 여기서 정확히 맞는 경우가 많음)
      const businessClicked = await this.clickBusinessPhotoChip(page, logs);
      if (businessClicked) {
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(1200);
        await this.scrollNudge(page);
        await page.waitForTimeout(600);

        // 클릭 후 네트워크 재평가
        const netAfter = net.getBest();
        logs.push(`[리뷰&사진] (업체사진 선택 후) 네트워크 best: ${netAfter || 0}`);
        if (netAfter > 0) photoCount = netAfter;

        // DOM 썸네일 카운트 (업체사진 화면에서만)
        const domCount = await this.countPhotoThumbnails(page);
        logs.push(`[리뷰&사진] (업체사진 선택 후) DOM 썸네일 카운트: ${domCount}`);
        if (domCount > 0 && domCount < 500) {
          // DOM이 훨씬 신뢰할 수 있음(2개 같은 케이스)
          photoCount = domCount;
          logs.push(`[리뷰&사진] photoCount를 DOM 썸네일로 확정: ${photoCount}`);
        }
      } else {
        logs.push("[리뷰&사진] 업체사진 필터/칩을 찾지 못함 → DOM 카운트 스킵");
      }

      // ✅ 리스너 제거
      page.off("response", net.onResponse);

      // 오탐 컷(너무 큰 값은 “업체사진”이 아닐 확률이 높음)
      // 업종 공통으로 업체 등록 사진이 수천장은 거의 없음
      if (photoCount > 3000) {
        logs.push(`[리뷰&사진] photoCount=${photoCount} 비정상적으로 큼 → 오탐 처리(0)`);
        photoCount = 0;
      }

      logs.push(
        `[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}, 최근30일: ${recentReviewCount30d ?? "N/A"}`
      );

      return { reviewCount, photoCount, recentReviewCount30d, logs };
    } catch (e: any) {
      logs.push(`[리뷰&사진] 오류: ${e?.message || String(e)}`);
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, recentReviewCount30d, logs };
    }
  }

  // =========================
  // ✅ 네트워크에서 “사진 관련 키”만 후보로 수집 (totalCount 금지)
  // =========================
  private static createPhotoNetworkCollector(placeId: string, logs: string[]) {
    const candidates: number[] = [];

    const pushCandidate = (n: any, why: string, url: string) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return;
      if (num <= 0 || num > 5000000) return;
      candidates.push(num);
      if (candidates.length <= 10) logs.push(`[NET] photoKey 후보 +${num} (${why}) @ ${url.slice(0, 140)}`);
    };

    const allowedKeys = new Set([
      "businessPhotoCount",
      "placePhotoCount",
      "photoCount",
      "businessPhotoTotalCount",
      "placePhotoTotalCount"
    ]);

    const scanJson = (obj: any, url: string) => {
      if (!obj || typeof obj !== "object") return;

      // shallow
      for (const k of Object.keys(obj)) {
        if (allowedKeys.has(k)) pushCandidate((obj as any)[k], `key:${k}`, url);
      }

      // deep (depth 제한)
      const walk = (v: any, depth: number) => {
        if (depth > 5) return;
        if (!v) return;

        if (Array.isArray(v)) {
          for (const it of v.slice(0, 80)) walk(it, depth + 1);
          return;
        }

        if (typeof v === "object") {
          for (const [k, val] of Object.entries(v).slice(0, 120)) {
            if (allowedKeys.has(k)) pushCandidate(val as any, `deepKey:${k}`, url);
            walk(val, depth + 1);
          }
        }
      };

      walk(obj, 0);
    };

    const scanText = (text: string, url: string) => {
      // ✅ totalCount/total/count 금지. 오직 photo 관련 키만 regex로 잡는다.
      const patterns: Array<[RegExp, string]> = [
        [/"businessPhotoCount"\s*:\s*([0-9]{1,7})/g, "re:businessPhotoCount"],
        [/"placePhotoCount"\s*:\s*([0-9]{1,7})/g, "re:placePhotoCount"],
        [/"photoCount"\s*:\s*([0-9]{1,7})/g, "re:photoCount"],
        [/"businessPhotoTotalCount"\s*:\s*([0-9]{1,7})/g, "re:businessPhotoTotalCount"],
        [/"placePhotoTotalCount"\s*:\s*([0-9]{1,7})/g, "re:placePhotoTotalCount"]
      ];

      for (const [re, why] of patterns) {
        for (const m of text.matchAll(re)) {
          if (m?.[1]) pushCandidate(parseInt(m[1], 10), why, url);
        }
      }
    };

    const onResponse = async (res: Response) => {
      try {
        const url = res.url();
        const u = url.toLowerCase();

        // 너무 무관한 응답 제외 (placeId 또는 photo 관련만)
        if (!u.includes(String(placeId)) && !u.includes("photo") && !u.includes("image") && !u.includes("media")) return;

        const ct = String(res.headers()["content-type"] || "").toLowerCase();
        const status = res.status();
        if (status < 200 || status >= 400) return;

        if (ct.includes("json")) {
          const data = await res.json().catch(() => null);
          if (data) scanJson(data, url);
          return;
        }

        if (ct.includes("text")) {
          const text = await res.text().catch(() => "");
          if (text) scanText(text, url);
        }
      } catch {
        // ignore
      }
    };

    const getBest = () => {
      if (!candidates.length) return 0;
      // 사진 관련 키로만 들어오니 max가 대체로 안전
      return Math.max(...candidates);
    };

    return { onResponse, getBest };
  }

  // =========================
  // ✅ 업체사진 필터/칩 클릭(탭이 아니라 “칩/버튼”일 수 있음)
  // =========================
  private static async clickBusinessPhotoChip(page: Page, logs: string[]): Promise<boolean> {
    const labels = ["업체사진", "매장사진", "플레이스사진", "가게사진"];
    const locators = [
      // chips / buttons
      (label: string) => page.locator("button, a, div[role='button'], span", { hasText: label }).first(),
      // tabs
      (label: string) => page.locator("a,button,div[role='tab']", { hasText: label }).first()
    ];

    for (const label of labels) {
      for (const mk of locators) {
        try {
          const loc = mk(label);
          const cnt = await loc.count().catch(() => 0);
          if (cnt > 0) {
            await loc.scrollIntoViewIfNeeded().catch(() => {});
            await loc.click({ timeout: 1500 }).catch(() => {});
            logs.push(`[리뷰&사진] 업체사진 필터 클릭 시도(${label}): OK`);
            return true;
          }
        } catch {}
      }
    }
    return false;
  }

  // =========================
  // ✅ DOM 썸네일 카운트 (중복 제거)
  // =========================
  private static async countPhotoThumbnails(page: Page): Promise<number> {
    try {
      const urls: string[] = await page
        .evaluate(() => {
          const d = (globalThis as any).document;
          if (!d) return [];
          const imgs = Array.from(d.querySelectorAll("img")) as any[];
          const srcs = imgs
            .map((img) => String(img?.getAttribute?.("src") || img?.src || ""))
            .filter((s) => s && s.length > 10)
            // 아이콘/스프라이트 제외
            .filter((s) => !s.includes("data:image") && !/sprite|icon/i.test(s));
          // 중복 제거
          return Array.from(new Set(srcs)).slice(0, 2000);
        })
        .catch(() => []);

      return urls.length;
    } catch {
      return 0;
    }
  }

  // =========================
  // URL helpers
  // =========================
  private static buildUrl(tab: "home" | "photo", placeId: string, slug?: string) {
    if (slug) return `https://m.place.naver.com/${slug}/${placeId}/${tab}`;
    return `https://m.place.naver.com/place/${placeId}/${tab}`;
  }

  private static buildVisitorReviewUrls(placeId: string, slug?: string): string[] {
    const urls: string[] = [];
    urls.push(`https://m.place.naver.com/place/${placeId}/review/visitor`);
    if (slug) urls.push(`https://m.place.naver.com/${slug}/${placeId}/review/visitor`);
    urls.push(`https://m.place.naver.com/place/${placeId}/review`);
    if (slug) urls.push(`https://m.place.naver.com/${slug}/${placeId}/review`);
    return urls;
  }

  private static detectSlugFromUrl(url: string): string | undefined {
    try {
      const u = new URL(url);
      const first = u.pathname.split("/").filter(Boolean)[0];
      if (!first || first === "place") return undefined;
      if (!/^[a-z0-9_]+$/i.test(first)) return undefined;
      return first;
    } catch {
      return undefined;
    }
  }

  // =========================
  // Page helpers
  // =========================
  private static async scrollNudge(page: Page) {
    try {
      await page.evaluate(() => {
        const w = (globalThis as any).window;
        w?.scrollTo?.(0, 900);
      });
      await page.waitForTimeout(300);
      await page.evaluate(() => {
        const w = (globalThis as any).window;
        w?.scrollTo?.(0, 0);
      });
    } catch {}
  }

  // =========================
  // Recent review helpers
  // =========================
  private static countParsedDates(html: string): number {
    return this.extractDates(html).length;
  }

  private static countRecentReviewsFromHtml(html: string, days: number): number {
    const dates = this.extractDates(html);
    if (dates.length === 0) return 0;

    const now = new Date();
    const threshold = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    let cnt = 0;
    for (const d of dates) {
      if (d >= threshold && d <= now) cnt++;
    }
    return cnt;
  }

  private static extractDates(html: string): Date[] {
    const out: Date[] = [];

    const m1 = html.matchAll(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g);
    for (const m of m1) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const dt = this.safeDate(y, mo, d);
      if (dt) out.push(dt);
    }

    const m2 = html.matchAll(/(\d{4})-(\d{2})-(\d{2})/g);
    for (const m of m2) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const dt = this.safeDate(y, mo, d);
      if (dt) out.push(dt);
    }

    return out.slice(0, 300);
  }

  private static safeDate(y: number, mo: number, d: number): Date | null {
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

  // =========================
  // HTML key-based max number
  // =========================
  private static extractMaxNumber(html: string, regexList: RegExp[]): number {
    const nums: number[] = [];

    for (const r of regexList) {
      const matches = html.matchAll(r);
      for (const m of matches) {
        const raw = m?.[1];
        if (!raw) continue;
        const n = parseInt(String(raw).replace(/,/g, ""), 10);
        if (!Number.isNaN(n) && n > 0 && n < 5000000) nums.push(n);
      }
    }

    if (!nums.length) return 0;
    return Math.max(...nums);
  }
}
