import { Page, Frame } from "playwright";

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string,
    categorySlug?: string // ✅ hairshop/cafe/restaurant 등
  ): Promise<{ reviewCount: number; photoCount: number; recentReviewCount30d?: number; logs: string[] }> {
    const logs: string[] = [];
    logs.push("[리뷰&사진] 추출 시작");

    let reviewCount = 0;
    let photoCount = 0;
    let recentReviewCount30d: number | undefined = undefined;

    const homeUrl = this.buildUrl("home", placeId, categorySlug);
    const photoUrl = this.buildUrl("photo", placeId, categorySlug);

    try {
      // ✅ 1) 홈에서 리뷰 총량 추출
      logs.push(`[리뷰&사진] 홈 이동(리뷰 기준): ${homeUrl}`);
      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      const homeHtml = await page.content();

      reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi,
        /리뷰\s*([0-9,]+)/gi
      ]);

      logs.push(`[리뷰&사진] 리뷰 최댓값: ${reviewCount}`);

      // ✅ 1-1) (가능하면) 방문자리뷰 페이지에서 최근 30일 리뷰 수 계산
      // - slug/redirect 구조가 종종 바뀌어서 여러 후보 URL을 순서대로 시도
      const reviewUrls = this.buildVisitorReviewUrls(placeId, categorySlug);
      for (const u of reviewUrls) {
        try {
          logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 시도: ${u}`);
          await page.goto(u, { waitUntil: "domcontentloaded", timeout: 60000 });
          await page.waitForTimeout(1500);

          const reviewHtml = await page.content();
          const cnt = this.countRecentReviewsFromHtml(reviewHtml, 30);

          // 0도 유효할 수 있지만, 파싱 실패 0과 구분이 어려워서
          // “날짜가 1개라도 파싱된 경우”에만 확정 반영
          const parsedDates = this.countParsedDates(reviewHtml);
          logs.push(`[리뷰&사진] 날짜 파싱 개수: ${parsedDates}, 최근30일 카운트: ${cnt}`);

          if (parsedDates >= 3) {
            recentReviewCount30d = cnt;
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

      // ✅ 2) 사진 탭에서 업체사진 count 추출
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);
      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      const tabTextBefore = await this.getTabText(page, "업체사진");
      logs.push(`[리뷰&사진] 업체사진 탭 텍스트(전): ${tabTextBefore ? tabTextBefore : "(없음)"}`);

      let parsed = this.parseCountFromText(tabTextBefore);
      if (parsed > 0) {
        photoCount = parsed;
        logs.push(`[리뷰&사진] 업체사진 탭에서 count 파싱 성공(전): ${photoCount}`);
      }

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

      if (photoCount === 0) {
        const domLine = await page.evaluate(() => {
          const d: any = (globalThis as any).document;
          if (!d || !d.body) return "";
          const raw = String(d.body.innerText || "");
          const lines = raw.split(/\r?\n|•|·/g).map(s => (s || "").replace(/\s+/g, " ").trim());
          const hit = lines.find(s => /업체\s*사진|업체사진/.test(s) && s.length <= 120);
          return hit || "";
        });

        logs.push(`[리뷰&사진] DOM에서 업체사진 라인: ${domLine ? domLine : "(없음)"}`);

        const domParsed = this.parseCountFromText(domLine);
        if (domParsed > 0) {
          photoCount = domParsed;
          logs.push(`[리뷰&사진] DOM 업체사진 라인에서 count 파싱 성공: ${photoCount}`);
        }
      }

      // 오탐 컷
      if (photoCount > 0 && photoCount < 5) {
        logs.push(`[리뷰&사진] photoCount=${photoCount} 오탐 가능 → 0 처리`);
        photoCount = 0;
      }
      if (photoCount === 5 && reviewCount >= 200) {
        logs.push("[리뷰&사진] 사진=5 & 리뷰가 많음 → 탭 숫자 오탐으로 판단, 0 처리");
        photoCount = 0;
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}, 최근30일: ${recentReviewCount30d ?? "N/A"}`);
      return { reviewCount, photoCount, recentReviewCount30d, logs };
    } catch (e: any) {
      logs.push(`[리뷰&사진] 오류: ${e?.message || String(e)}`);
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, recentReviewCount30d, logs };
    }
  }

  private static buildUrl(tab: "home" | "photo", placeId: string, slug?: string) {
    // slug가 있으면 그걸 우선 사용, 아니면 /place/{id}/{tab} 사용(리디렉트 기대)
    if (slug) return `https://m.place.naver.com/${slug}/${placeId}/${tab}`;
    return `https://m.place.naver.com/place/${placeId}/${tab}`;
  }

  private static buildVisitorReviewUrls(placeId: string, slug?: string): string[] {
    const urls: string[] = [];

    // 1) 가장 일반적인 /place 경로
    urls.push(`https://m.place.naver.com/place/${placeId}/review/visitor`);

    // 2) 업종 slug 경로(있으면)
    if (slug) urls.push(`https://m.place.naver.com/${slug}/${placeId}/review/visitor`);

    // 3) 예전/대체 형태 대비 (있을 때만)
    urls.push(`https://m.place.naver.com/place/${placeId}/review`);
    if (slug) urls.push(`https://m.place.naver.com/${slug}/${placeId}/review`);

    return urls;
  }

  private static countParsedDates(html: string): number {
    const dates = this.extractDates(html);
    return dates.length;
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

    // 패턴1: "2026.02.19" 같은 표시
    const m1 = html.matchAll(/(\d{4})\.\s*(\d{1,2})\.\s*(\d{1,2})/g);
    for (const m of m1) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const dt = this.safeDate(y, mo, d);
      if (dt) out.push(dt);
    }

    // 패턴2: "2026-02-19" 같은 ISO
    const m2 = html.matchAll(/(\d{4})-(\d{2})-(\d{2})/g);
    for (const m of m2) {
      const y = parseInt(m[1], 10);
      const mo = parseInt(m[2], 10);
      const d = parseInt(m[3], 10);
      const dt = this.safeDate(y, mo, d);
      if (dt) out.push(dt);
    }

    // 너무 많으면(중복/노이즈) 상위만
    return out.slice(0, 300);
  }

  private static safeDate(y: number, mo: number, d: number): Date | null {
    if (!y || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
    const dt = new Date(y, mo - 1, d);
    if (Number.isNaN(dt.getTime())) return null;
    return dt;
  }

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
