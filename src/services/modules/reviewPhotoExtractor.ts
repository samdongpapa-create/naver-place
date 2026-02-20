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

      // ✅ 사진 수 추출: photo 탭 이동 후 안정적으로 key 기반 파싱
      try {
        const photoUrl = slug
          ? `https://m.place.naver.com/${slug}/${placeId}/photo`
          : `https://m.place.naver.com/place/${placeId}/photo`;

        logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);
        await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1600);

        const photoHtml = await page.content();

        // ✅ “진짜 photoCount 키”만 엄격하게 (리뷰 수/totalCount 오탐 방지)
        // 네이버가 쓰는 키가 여러번 바뀌어서 후보 여러개를 두되, photo 관련 키만 허용
        photoCount = this.extractMaxNumber(photoHtml, [
          /"photoCount"[\s":]+([0-9,]+)/gi,
          /"businessPhotoCount"[\s":]+([0-9,]+)/gi,
          /"storePhotoCount"[\s":]+([0-9,]+)/gi,
          /"totalPhotoCount"[\s":]+([0-9,]+)/gi
        ]);

        logs.push(`[리뷰&사진] 네트워크 photoCount(best, strict keys only): ${photoCount}`);

        // ✅ DOM 텍스트 보조 파싱 (탭/칩이 있을 때만)
        if (!photoCount || photoCount <= 0) {
          const domLine = await page.evaluate(() => {
            const d = (globalThis as any).document as any;
            const raw = d?.body?.innerText ? String(d.body.innerText) : "";
            const lines = raw
              .split(/\r?\n|•|·/g)
              .map((s: string) => (s || "").replace(/\s+/g, " ").trim())
              .filter((s: string) => s.length > 0);

            const hit =
              lines.find((s: string) => /업체\s*사진|업체사진/.test(s) && s.length <= 120) ||
              lines.find((s: string) => /사진/.test(s) && /\([0-9,]+\)/.test(s) && s.length <= 80) ||
              "";

            return hit || "";
          });

          const parsed = this.parseCountFromText(domLine);
          if (parsed > 0) {
            photoCount = parsed;
            logs.push(`[리뷰&사진] DOM 라인에서 photoCount 파싱: ${photoCount} (line="${domLine}")`);
          } else {
            logs.push("[리뷰&사진] 업체사진 필터/칩을 찾지 못함 → DOM 카운트 스킵");
          }
        }

        // ✅ 오탐 컷(너 케이스처럼 2장인데 8000 이런 값 방지)
        // - 지나치게 큰 값(2000 초과)은 거의 100% 오탐(전체 이미지/리뷰/게시물 등)
        // - 매우 작은 값(1~4)은 실제일 수 있으니 유지
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
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, recentReviewCount30d: recentReviewCount30d || 0, logs };
    }
  }

  private static extractCategorySlug(url: string): string {
    try {
      const u = new URL(url);
      const parts = u.pathname.split("/").filter(Boolean);
      // /hairshop/{id}/home 형태
      if (parts.length >= 2 && parts[1] && /^\d+$/.test(parts[1])) {
        return parts[0]; // hairshop/cafe/restaurant 등
      }
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

    // 텍스트에서 날짜 패턴 최대한 많이 수집
    // 예) 2026.02.13 / 2026-02-13 / 02.13 / 2.13 / 2026년 2월 13일
    const patterns = [
      /\b(20\d{2})[.\-\/](\d{1,2})[.\-\/](\d{1,2})\b/g,         // 2026.02.13
      /\b(\d{1,2})[.\-\/](\d{1,2})\b/g,                         // 02.13
      /\b(20\d{2})\s*년\s*(\d{1,2})\s*월\s*(\d{1,2})\s*일\b/g    // 2026년 2월 13일
    ];

    const dates: Date[] = [];

    // 1) 연도 포함 패턴
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

    // 2) 월/일만 있는 패턴은 “올해”로 가정 (오탐 방지 위해 올해만)
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
