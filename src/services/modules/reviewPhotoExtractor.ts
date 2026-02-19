import { Page, Frame } from "playwright";

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

      if (recentReviewCount30d === undefined) {
        logs.push("[리뷰&사진] 최근 30일 리뷰 수 추출 실패/스킵(중립 처리 예정)");
      }

      // =========================
      // 3) 사진 수: photo 탭에서 추출 (강화)
      // =========================
      const photoUrl = this.buildUrl("photo", placeId, categorySlug);
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2200);

      await this.scrollNudge(page);
      await page.waitForTimeout(1200);

      if (!categorySlug) {
        const redirectedSlug = this.detectSlugFromUrl(page.url());
        if (redirectedSlug) {
          categorySlug = redirectedSlug;
          logs.push(`[리뷰&사진] (photo) redirect slug 보정: ${categorySlug}`);
        }
      }

      const bodyTextLen = await page
        .evaluate(() => {
          const d = (globalThis as any).document;
          const t = (d?.body?.innerText || "").trim();
          return t.length;
        })
        .catch(() => 0);
      logs.push(`[리뷰&사진] photo bodyText length: ${bodyTextLen}`);

      const tabLabels = ["업체사진", "매장사진", "사진", "방문자사진", "리뷰사진"];

      for (const label of tabLabels) {
        const txt = await this.getTabText(page, label);
        if (txt) logs.push(`[리뷰&사진] 탭 텍스트 후보(${label}): ${txt}`);
        const n = this.parseCountFromAnyText(txt, label);
        if (n > photoCount) {
          photoCount = n;
          logs.push(`[리뷰&사진] 탭 텍스트(${label})에서 photoCount 갱신: ${photoCount}`);
        }
      }

      for (const label of ["업체사진", "매장사진", "사진"]) {
        const clicked = await this.clickTab(page, label);
        logs.push(`[리뷰&사진] 탭 클릭(${label}): ${clicked ? "성공" : "실패/없음/이미선택"}`);
        if (clicked) {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(1200);
          await this.scrollNudge(page);
          await page.waitForTimeout(800);

          const txtAfter = await this.getTabText(page, label);
          if (txtAfter) logs.push(`[리뷰&사진] 탭 텍스트(클릭후 ${label}): ${txtAfter}`);

          const n2 = this.parseCountFromAnyText(txtAfter, label);
          if (n2 > photoCount) {
            photoCount = n2;
            logs.push(`[리뷰&사진] 클릭후(${label}) photoCount 갱신: ${photoCount}`);
          }
          break;
        }
      }

      if (photoCount === 0) {
        const tabAreaText = await page
          .evaluate(() => {
            const d = (globalThis as any).document;
            const el =
              d?.querySelector?.('[role="tablist"]') ||
              d?.querySelector?.("nav") ||
              d?.querySelector?.("header") ||
              d?.body;
            const t = (el?.textContent || "").replace(/\s+/g, " ").trim();
            return t.slice(0, 2000);
          })
          .catch(() => "");

        logs.push(`[리뷰&사진] 탭영역 text(일부): ${tabAreaText ? tabAreaText : "(없음)"}`);

        const guess = this.extractMaxNumberFromLooseText(tabAreaText);
        if (guess > 0) {
          photoCount = guess;
          logs.push(`[리뷰&사진] 탭영역 loose-number max로 photoCount 추정: ${photoCount}`);
        }
      }

      if (photoCount === 0) {
        const domLine = await page
          .evaluate(() => {
            const d = (globalThis as any).document;
            const raw = String(d?.body?.innerText || "");
            const lines = raw
              .split(/\r?\n|•|·/g)
              .map((s: string) => (s || "").replace(/\s+/g, " ").trim())
              .filter(Boolean);

            const hit =
              lines.find((s: string) => /업체\s*사진|업체사진/.test(s) && s.length <= 200) ||
              lines.find((s: string) => /매장\s*사진|매장사진/.test(s) && s.length <= 200) ||
              lines.find((s: string) => /방문자\s*사진|방문자사진/.test(s) && s.length <= 200) ||
              lines.find((s: string) => /^사진\s*[0-9,]+/.test(s) && s.length <= 200);

            return hit || "";
          })
          .catch(() => "");

        logs.push(`[리뷰&사진] DOM 라인 후보: ${domLine ? domLine : "(없음)"}`);

        const domParsed = this.extractMaxNumberFromLooseText(domLine);
        if (domParsed > 0) {
          photoCount = domParsed;
          logs.push(`[리뷰&사진] DOM 라인에서 photoCount 파싱 성공: ${photoCount}`);
        }
      }

      if (photoCount === 0) {
        const photoHtml = await page.content();

        const htmlParsed = this.extractMaxNumber(photoHtml, [
          /"photoCount"[\s":]+([0-9,]+)/gi,
          /"businessPhotoCount"[\s":]+([0-9,]+)/gi,
          /"placePhotoCount"[\s":]+([0-9,]+)/gi,
          /업체사진\s*([0-9,]+)/gi,
          /매장사진\s*([0-9,]+)/gi,
          /방문자사진\s*([0-9,]+)/gi
        ]);

        if (htmlParsed > 0) {
          photoCount = htmlParsed;
          logs.push(`[리뷰&사진] HTML 키 기반 photoCount 파싱 성공: ${photoCount}`);
        } else {
          logs.push("[리뷰&사진] HTML 키 기반 photoCount 파싱 실패");
        }
      }

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

  // -------------------------
  // URL helpers
  // -------------------------
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

  // -------------------------
  // Photo helpers
  // -------------------------
  private static async scrollNudge(page: Page) {
    try {
      await page.evaluate(() => {
        const w = (globalThis as any).window;
        w?.scrollTo?.(0, 600);
      });
      await page.waitForTimeout(250);
      await page.evaluate(() => {
        const w = (globalThis as any).window;
        w?.scrollTo?.(0, 0);
      });
    } catch {}
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

  private static parseCountFromAnyText(text?: string | null, label?: string): number {
    if (!text) return 0;
    const t = String(text);

    if (label) {
      const m =
        t.match(new RegExp(`${label}[^0-9]{0,12}([0-9][0-9,]{0,})`)) ||
        t.match(/\(([0-9][0-9,]{0,})\)/);
      if (m?.[1]) {
        const n = parseInt(m[1].replace(/,/g, ""), 10);
        return Number.isNaN(n) ? 0 : n;
      }
    }

    return this.extractMaxNumberFromLooseText(t);
  }

  private static extractMaxNumberFromLooseText(text?: string | null): number {
    if (!text) return 0;
    const nums: number[] = [];
    const matches = String(text).matchAll(/([0-9][0-9,]{0,})/g);
    for (const m of matches) {
      const raw = m?.[1];
      if (!raw) continue;
      const n = parseInt(raw.replace(/,/g, ""), 10);
      if (!Number.isNaN(n) && n > 0 && n < 5000000) nums.push(n);
    }
    if (!nums.length) return 0;
    return Math.max(...nums);
  }

  // -------------------------
  // Review recent helpers
  // -------------------------
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

  // -------------------------
  // HTML key-based max number
  // -------------------------
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
