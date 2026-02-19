import { Page, Frame } from "playwright";

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string,
    categorySlug?: string // 예: hairshop / cafe / restaurant ...
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
      let homeUrl = this.buildUrl("home", placeId, categorySlug);
      logs.push(`[리뷰&사진] 홈 이동(리뷰 기준): ${homeUrl}`);

      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      // ✅ redirect 후 slug 보정 (원본이 /place/...여도 실제는 /hairshop/...로 바뀜)
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
      // 2) 최근 30일 리뷰 수: 방문자리뷰 페이지에서 날짜 파싱
      // =========================
      const reviewUrls = this.buildVisitorReviewUrls(placeId, categorySlug);

      for (const u of reviewUrls) {
        try {
          logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 시도: ${u}`);

          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(1500);

          // ✅ redirect 후 slug 재보정(리뷰 페이지에서도 한번 더)
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

          // 날짜가 어느 정도 파싱돼야 “진짜로 성공”이라고 판단
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

      if (recentReviewCount30d === undefined) {
        logs.push("[리뷰&사진] 최근 30일 리뷰 수 추출 실패/스킵(중립 처리 예정)");
      }

      // =========================
      // 3) 업체사진 수: photo 탭에서 추출
      // =========================
      const photoUrl = this.buildUrl("photo", placeId, categorySlug);
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      // ✅ photo 페이지 redirect 되면 slug 보정
      if (!categorySlug) {
        const redirectedSlug = this.detectSlugFromUrl(page.url());
        if (redirectedSlug) {
          categorySlug = redirectedSlug;
          logs.push(`[리뷰&사진] (photo) redirect slug 보정: ${categorySlug}`);
        }
      }

      // 3-1) 탭 텍스트에서 파싱(가장 좋음)
      const tabTextBefore = await this.getTabText(page, "업체사진");
      logs.push(`[리뷰&사진] 업체사진 탭 텍스트(전): ${tabTextBefore ? tabTextBefore : "(없음)"}`);

      let parsed = this.parseCountFromText(tabTextBefore);
      if (parsed > 0) {
        photoCount = parsed;
        logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(전): ${photoCount}`);
      }

      // 3-2) 탭 클릭(선택 상태 아니면)
      const clicked = await this.clickTab(page, "업체사진");
      logs.push(`[리뷰&사진] 업체사진 탭 클릭: ${clicked ? "성공" : "실패/이미선택"}`);
      await page.waitForTimeout(1000);

      const tabTextAfter = await this.getTabText(page, "업체사진");
      logs.push(`[리뷰&사진] 업체사진 탭 텍스트(후): ${tabTextAfter ? tabTextAfter : "(없음)"}`);

      parsed = this.parseCountFromText(tabTextAfter);
      if (parsed > photoCount) {
        photoCount = parsed;
        logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(후): ${photoCount}`);
      }

      // 3-3) DOM 전체에서 “업체사진” 라인 보조 파싱
      if (photoCount === 0) {
        const domLine = await page.evaluate(() => {
          const d: any = (globalThis as any).document;
          if (!d || !d.body) return "";
          const raw = String(d.body.innerText || "");
          const lines = raw.split(/\r?\n|•|·/g).map(s => (s || "").replace(/\s+/g, " ").trim());
          const hit = lines.find(s => /업체\s*사진|업체사진/.test(s) && s.length <= 160);
          return hit || "";
        });

        logs.push(`[리뷰&사진] DOM에서 업체사진 라인: ${domLine ? domLine : "(없음)"}`);

        const domParsed = this.parseCountFromText(domLine);
        if (domParsed > 0) {
          photoCount = domParsed;
          logs.push(`[리뷰&사진] DOM 업체사진 라인에서 count 파싱 성공: ${photoCount}`);
        }
      }

      // 3-4) 마지막 보조: HTML에서 photoCount 관련 키를 찾기
      if (photoCount === 0) {
        const photoHtml = await page.content();
        const htmlParsed = this.extractMaxNumber(photoHtml, [
          /"photoCount"[\s":]+([0-9,]+)/gi,
          /"businessPhotoCount"[\s":]+([0-9,]+)/gi,
          /업체사진\s*([0-9,]+)/gi,
          /사진\s*([0-9,]+)/gi
        ]);

        if (htmlParsed > 0) {
          photoCount = htmlParsed;
          logs.push(`[리뷰&사진] HTML 키 기반 photoCount 파싱 성공: ${photoCount}`);
        } else {
          logs.push("[리뷰&사진] HTML 키 기반 photoCount 파싱 실패");
        }
      }

      // =========================
      // 오탐 컷
      // =========================
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] photoCount=${photoCount} 오탐 가능 → 0 처리`);
        photoCount = 0;
      }
      if (photoCount === 5 && reviewCount >= 200) {
        logs.push("[리뷰&사진] 사진=5 & 리뷰가 많음 → 탭 숫자 오탐으로 판단, 0 처리");
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
  // URL helpers
  // =========================
  private static buildUrl(tab: "home" | "photo", placeId: string, slug?: string) {
    // slug가 있으면 slug 기반 경로 우선, 없으면 /place 경로(redirect 기대)
    if (slug) return `https://m.place.naver.com/${slug}/${placeId}/${tab}`;
    return `https://m.place.naver.com/place/${placeId}/${tab}`;
  }

  private static buildVisitorReviewUrls(placeId: string, slug?: string): string[] {
    const urls: string[] = [];
    urls.push(`https://m.place.naver.com/place/${placeId}/review/visitor`);
    if (slug) urls.push(`https://m.place.naver.com/${slug}/${placeId}/review/visitor`);

    // 예외 대비 후보
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
  // Photo tab helpers
  // =========================
  private static parseCountFromText(text?: string | null): number {
    if (!text) return 0;
    const t = String(text);

    const m =
      t.match(/업체\s*사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/업체사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/\(([0-9][0-9,]{0,})\)/);

    if (!m?.[1]) return 0;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isNaN(n) ? 0 : n;
  }

  private static async getTabText(page: Page, tabLabel: string): Promise<string> {
    const candidates = [
      page.locator("a,button,div[role='tab']", { hasText: tabLabel }).first(),
      page.locator(`text=${tabLabel}`).first()
    ];

    for (const loc of candidates) {
      try {
        const cnt = await loc.count().catch(() => 0);
        if (cnt > 0) {
          const txt = await loc.textContent().catch(() => "");
          if (txt && txt.trim()) return txt.trim();
        }
      } catch {}
    }
    return "";
  }

  private static async clickTab(page: Page, tabLabel: string): Promise<boolean> {
    const loc = page.locator("a,button,div[role='tab']", { hasText: tabLabel }).first();
    try {
      const cnt = await loc.count().catch(() => 0);
      if (cnt > 0) {
        await loc.scrollIntoViewIfNeeded().catch(() => {});
        await loc.click({ timeout: 1500 }).catch(() => {});
        return true;
      }
    } catch {}
    return false;
  }

  // =========================
  // Review recent helpers
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

    // "2026.02.19"
    const m1 = html.matchAll(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g);
    for (const m of m1) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const dt = this.safeDate(y, mo, d);
      if (dt) out.push(dt);
    }

    // "2026-02-19"
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
  // Generic number parser
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
