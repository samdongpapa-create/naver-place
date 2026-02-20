import { Page, Frame } from "playwright";

export class ReviewPhotoExtractor {
  static async extract(
    page: Page,
    _frame: Frame | null,
    placeId: string
  ): Promise<{ reviewCount: number; photoCount: number; recentReviewCount30d?: number; logs: string[] }> {
    const logs: string[] = [];
    logs.push("[리뷰&사진] 추출 시작");

    let reviewCount = 0;
    let photoCount = 0;
    let recentReviewCount30d: number | undefined = undefined;

    // ✅ page 닫힘 방어
    if (page.isClosed()) {
      logs.push("[리뷰&사진] 페이지가 이미 닫혀있음(page.isClosed) → 스킵");
      return { reviewCount: 0, photoCount: 0, recentReviewCount30d: undefined, logs };
    }

    try {
      // ✅ 1) 리뷰는 home에서 안정 파싱
      const homeUrl = `https://m.place.naver.com/hairshop/${placeId}/home`;
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
      logs.push(`[리뷰&사진] 홈 기준 - 리뷰:${reviewCount}`);

      // ✅ 1-1) 최근 30일 리뷰수(가능하면)
      try {
        const reviewUrl = `https://m.place.naver.com/place/${placeId}/review/visitor`;
        logs.push(`[리뷰&사진] 최근리뷰(30일) 계산 시도: ${reviewUrl}`);

        await page.goto(reviewUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(1800);

        // 날짜 텍스트를 DOM에서 긁어서 최근 30일 카운팅
        const recent = await page.evaluate(() => {
          const now = new Date();
          const cutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

          const body = document.body;
          const txt = (body?.innerText || "").replace(/\u200b/g, "");
          const lines = txt.split(/\r?\n/g).map(s => s.trim()).filter(Boolean);

          // 흔한 포맷: "2026.02.13" / "2026.2.3" / "2.13." 등도 섞임 → 최대한 보수적으로 파싱
          const dates: Date[] = [];

          const pushIfValid = (y: number, m: number, d: number) => {
            const dt = new Date(y, m - 1, d);
            if (!isNaN(dt.getTime())) dates.push(dt);
          };

          for (const s of lines) {
            let m = s.match(/(20\d{2})\.\s*(\d{1,2})\.\s*(\d{1,2})/);
            if (m) {
              pushIfValid(parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10));
              continue;
            }
            // "2.13." 같은 케이스(연도 없음) → 올해로 가정
            m = s.match(/^(\d{1,2})\.\s*(\d{1,2})\.?$/);
            if (m) {
              const y = now.getFullYear();
              pushIfValid(y, parseInt(m[1], 10), parseInt(m[2], 10));
              continue;
            }
          }

          const recentCount = dates.filter(d => d >= cutoff && d <= now).length;
          return { parsedDates: dates.length, recentCount };
        });

        logs.push(`[리뷰&사진] 날짜 파싱 개수: ${recent.parsedDates}, 최근30일 카운트: ${recent.recentCount}`);
        recentReviewCount30d = recent.recentCount;
        logs.push(`[리뷰&사진] 최근 30일 리뷰 수 확정: ${recentReviewCount30d}`);
      } catch (e: any) {
        logs.push(`[리뷰&사진] 최근 30일 리뷰 수 계산 실패: ${e?.message || String(e)}`);
      }

      // ✅ 2) 사진 탭: photo로 이동 + 네트워크에서 totalCount 후보 파싱 (현실적으로 가장 잘 잡힘)
      const photoUrl = `https://m.place.naver.com/hairshop/${placeId}/photo`;
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      // 네트워크 응답에서 후보 숫자 잡기
      const candidates: number[] = [];
      const onResp = async (resp: any) => {
        try {
          const url: string = resp.url();
          if (!url.includes("/photo")) return;

          const ct = (resp.headers()?.["content-type"] || "").toLowerCase();
          if (!ct.includes("application/json") && !ct.includes("text/plain")) return;

          const txt = await resp.text().catch(() => "");
          if (!txt) return;

          // totalCount / totalcount / count 후보
          const ms = txt.matchAll(/"totalCount"\s*:\s*([0-9]+)/g);
          for (const m of ms) {
            const n = parseInt(m[1], 10);
            if (!isNaN(n) && n > 0 && n < 5000000) {
              candidates.push(n);
              logs.push(`[NET] photoCount 후보 +${n} (re:totalCount) @ ${url}`);
            }
          }
        } catch {}
      };

      page.on("response", onResp);

      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });
      await page.waitForTimeout(1800);

      page.off("response", onResp);

      if (candidates.length) {
        photoCount = Math.max(...candidates);
        logs.push(`[리뷰&사진] 네트워크 photoCount 후보(best): ${photoCount}`);
      }

      // 보조: 페이지 bodyText를 한번 확인(디버그)
      try {
        const tlen = await page.evaluate(() => (document.body?.innerText || "").length);
        logs.push(`[리뷰&사진] photo bodyText length: ${tlen}`);
      } catch {}

      // 오탐 방지(너 케이스처럼 8851 같은 값 튀면 의심)
      // "실제 업체사진 2장"인데 8851 잡히는 건 전체/리뷰/사용자사진 합계 같은 걸 잘못 줍는 경우가 많음
      // 우선 안전 장치: 리뷰수보다 과도하게 큰 값이면 컷(가볍게)
      if (photoCount > 0 && reviewCount > 0 && photoCount > reviewCount * 5) {
        logs.push(`[리뷰&사진] photoCount=${photoCount}가 리뷰수 대비 과도(>${reviewCount * 5}) → 오탐으로 0 처리`);
        photoCount = 0;
      }

      logs.push(`[리뷰&사진] 최종 결과 - 리뷰: ${reviewCount}, 업체사진: ${photoCount}, 최근30일: ${recentReviewCount30d ?? 0}`);
      return { reviewCount, photoCount, recentReviewCount30d, logs };
    } catch (e: any) {
      logs.push(`[리뷰&사진] 오류: ${e?.message || String(e)}`);
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, recentReviewCount30d, logs };
    }
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
