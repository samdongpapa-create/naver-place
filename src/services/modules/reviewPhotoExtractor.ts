import { Page, Frame } from "playwright";

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string
  ): Promise<{ reviewCount: number; photoCount: number; recentReviewCount30d: number; logs: string[] }> {
    const logs: string[] = [];
    logs.push("[리뷰&사진] 추출 시작");

    let reviewCount = 0;
    let photoCount = 0;
    let recentReviewCount30d = 0;

    try {
      // ✅ slug 자동 보정: /place/{id}/home 로 들어가면 hairshop/cafe/...로 리다이렉트됨
      const homeUrl = `https://m.place.naver.com/place/${placeId}/home`;
      logs.push(`[리뷰&사진] 홈 이동(리뷰 기준): ${homeUrl}`);

      await page.goto(homeUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      const finalUrl = page.url();
      const slug = this.extractCategorySlug(finalUrl);
      if (slug) logs.push(`[리뷰&사진] redirect slug 보정: ${slug}`);

      const homeHtml = await page.content();

      reviewCount = this.extractMaxNumber(homeHtml, [
        /"visitorReviewCount"[\s":]+([0-9,]+)/gi,
        /"reviewCount"[\s":]+([0-9,]+)/gi,
        /방문자리뷰\s*([0-9,]+)/gi,
        /리뷰\s*([0-9,]+)/gi
      ]);

      logs.push(`[리뷰&사진] 리뷰 최댓값: ${reviewCount}`);
      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}`);

      // ✅ 최근 30일 리뷰 수 (visitor review 페이지에서 날짜 파싱)
      try {
        const reviewUrl = `https://m.place.naver.com/place/${placeId}/review/visitor`;
        logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 시도: ${reviewUrl}`);

        await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1600);

        const innerText = await page.evaluate(() => {
          const d = (globalThis as any).document as any;
          const raw = d?.body?.innerText ? String(d.body.innerText) : "";
          return raw;
        });

        const parsed = this.countRecentDaysFromText(innerText, 30);
        recentReviewCount30d = parsed.count;
        logs.push(`[리뷰&사진] 날짜 파싱 개수: ${parsed.totalDates}, 최근30일 카운트: ${recentReviewCount30d}`);
        logs.push(`[리뷰&사진] 최근 30일 리뷰 수 확정: ${recentReviewCount30d}`);
      } catch (e: any) {
        logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 실패: ${e?.message || String(e)}`);
      }

      // ✅ 사진 수 추출: photo 탭 이동
      try {
        const photoUrl = slug
          ? `https://m.place.naver.com/${slug}/${placeId}/photo`
          : `https://m.place.naver.com/place/${placeId}/photo`;

        logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);
        await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1600);

        const photoHtml = await page.content();

        // 1) key 기반 파싱(후보 확장)
        const keyBased = this.extractMaxNumber(photoHtml, [
          /"photoCount"[\s":]+([0-9,]+)/gi,
          /"businessPhotoCount"[\s":]+([0-9,]+)/gi,
          /"storePhotoCount"[\s":]+([0-9,]+)/gi,
          /"totalPhotoCount"[\s":]+([0-9,]+)/gi,
          /"photoTotalCount"[\s":]+([0-9,]+)/gi,
          /"totalImages"[\s":]+([0-9,]+)/gi,
          /"imageCount"[\s":]+([0-9,]+)/gi,
          /"mediaTotalCount"[\s":]+([0-9,]+)/gi,
          /"mediaCount"[\s":]+([0-9,]+)/gi
        ]);

        logs.push(`[PHOTO] key-based count: ${keyBased}`);

        // 2) DOM 텍스트 기반 파싱
        let domParsed = 0;
        try {
          const domText = await page.evaluate(() => {
            const d = (globalThis as any).document as any;
            return d?.body?.innerText ? String(d.body.innerText) : "";
          });

          domParsed = this.parseCountFromText(domText);
          logs.push(`[PHOTO] dom-text parsed count: ${domParsed}`);
        } catch (e: any) {
          logs.push(`[PHOTO] dom-text parse error: ${e?.message || String(e)}`);
        }

        // 3) 마지막 보루: img 썸네일 개수(최소 추정치)
        let imgEstimate = 0;
        try {
          imgEstimate = await page.evaluate(() => {
            const d = (globalThis as any).document as any;
            const nodeList = d?.querySelectorAll ? d.querySelectorAll("img") : [];
            const imgs = Array.from(nodeList || []);
            const candidates = imgs.filter((img: any) => {
              const src = String(img?.getAttribute?.("src") || img?.src || "").toLowerCase();
              if (!src) return false;
              if (src.startsWith("data:")) return false;
              if (src.includes("logo") || src.includes("icon")) return false;
              return true;
            });
            return candidates.length;
          });

          if (imgEstimate < 6) imgEstimate = 0;
          logs.push(`[PHOTO] img-thumb estimate: ${imgEstimate}`);
        } catch (e: any) {
          logs.push(`[PHOTO] img-thumb estimate error: ${e?.message || String(e)}`);
        }

        // 최종 결정(우선순위: key > dom > imgEstimate)
        photoCount = keyBased || domParsed || imgEstimate;

        // ✅ 오탐 컷
        if (photoCount > 2000) {
          logs.push(`[리뷰&사진] photoCount=${photoCount} 과대(>2000) → 오탐으로 0 처리`);
          photoCount = 0;
        }
      } catch (e: any) {
        logs.push(`[리뷰&사진] 사진 추출 실패: ${e?.message || String(e)}`);
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}, 최근30일: ${recentReviewCount30d}`);
      return { reviewCount, photoCount, recentReviewCount30d, logs };
    } catch (e: any) {
      logs.push(`[리뷰&사진] 오류: ${e?.message || String(e)}`);
      return {
        reviewCount: reviewCount || 0,
        photoCount: photoCount || 0,
        recentReviewCount30d: recentReviewCount30d || 0,
        logs
      };
    }
  }

  private static extractCategorySlug(url: string): string {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      if (parts.length >= 2 && parts[1] && /^\d+$/.test(parts[1])) return parts[0];
      return "";
    } catch {
      return "";
    }
  }

  private static parseCountFromText(text?: string | null): number {
    if (!text) return 0;
    const t = String(text);

    const m =
      t.match(/업체\s*사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/업체사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/사진[^0-9]{0,10}\(([0-9][0-9,]{0,})\)/) ||
      t.match(/사진[^0-9]{0,10}([0-9][0-9,]{0,})/) ||
      t.match(/\(([0-9][0-9,]{0,})\)/);

    if (!m?.[1]) return 0;
    const n = parseInt(m[1].replace(/,/g, ""), 10);
    return Number.isNaN(n) ? 0 : n;
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

  private static countRecentDaysFromText(text: string, days: number) {
    const now = new Date();
    const limit = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

    const patterns = [
      /\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\b/g,
      /\b(\d{1,2})[.\-\/](\d{1,2})\b/g,
      /\b(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\b/g
    ];

    const dates: Date[] = [];

    for (const p of [patterns[0], patterns[2]]) {
      let m;
      while ((m = p.exec(text)) !== null) {
        const y = parseInt(m[1], 10);
        const mo = parseInt(m[2], 10);
        const d = parseInt(m[3], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
          const dt = new Date(y, mo - 1, d);
          if (!Number.isNaN(dt.getTime())) dates.push(dt);
        }
      }
    }

    {
      const p = patterns[1];
      let m;
      while ((m = p.exec(text)) !== null) {
        const mo = parseInt(m[1], 10);
        const d = parseInt(m[2], 10);
        if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
          const dt = new Date(now.getFullYear(), mo - 1, d);
          if (!Number.isNaN(dt.getTime())) dates.push(dt);
        }
      }
    }

    const recent = dates.filter(d => d >= limit && d <= now).length;
    return { totalDates: dates.length, count: recent };
  }
}
