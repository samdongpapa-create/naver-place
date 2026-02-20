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

      if (recentReviewCount30d === undefined) {
        logs.push("[리뷰&사진] 최근 30일 리뷰 수 추출 실패/스킵(중립 처리 예정)");
      }

      // =========================
      // 3) 사진 수: photo 탭 (✅ 네트워크 응답 캐치)
      // =========================
      const photoUrl = this.buildUrl("photo", placeId, categorySlug);
      logs.push(`[리뷰&사진] 사진탭 이동: ${photoUrl}`);

      // ✅ 네트워크로 photoCount 후보 수집
      const net = this.createPhotoNetworkCollector(placeId, logs);
      page.on("response", net.onResponse);

      await page.goto(photoUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // 렌더/요청 더 기다리기
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(2200);

      // lazy load 유도
      await this.scrollNudge(page);
      await page.waitForTimeout(1200);

      // photo 페이지 redirect되면 slug 보정
      if (!categorySlug) {
        const redirectedSlug = this.detectSlugFromUrl(page.url());
        if (redirectedSlug) {
          categorySlug = redirectedSlug;
          logs.push(`[리뷰&사진] (photo) redirect slug 보정: ${categorySlug}`);
        }
      }

      // ✅ 네트워크에서 잡은 값 우선 적용
      const netPhoto = net.getBest();
      logs.push(`[리뷰&사진] 네트워크 photoCount 후보(best): ${netPhoto || 0}`);
      if (netPhoto > 0) photoCount = netPhoto;

      // ---- 아래는 “네트워크 실패 대비” DOM/HTML 보조 ----
      const bodyTextLen = await page
        .evaluate(() => {
          const d = (globalThis as any).document;
          const t = (d?.body?.innerText || "").trim();
          return t.length;
        })
        .catch(() => 0);
      logs.push(`[리뷰&사진] photo bodyText length: ${bodyTextLen}`);

      const tabLabels = ["업체사진", "매장사진", "사진", "방문자사진", "리뷰사진"];

      // 탭 텍스트 파싱
      for (const label of tabLabels) {
        const txt = await this.getTabText(page, label);
        if (txt) logs.push(`[리뷰&사진] 탭 텍스트 후보(${label}): ${txt}`);
        const n = this.parseCountFromAnyText(txt, label);
        if (n > photoCount) {
          photoCount = n;
          logs.push(`[리뷰&사진] 탭 텍스트(${label})에서 photoCount 갱신: ${photoCount}`);
        }
      }

      // 탭 클릭 시도
      for (const label of ["업체사진", "매장사진", "사진"]) {
        const clicked = await this.clickTab(page, label);
        logs.push(`[리뷰&사진] 탭 클릭(${label}): ${clicked ? "성공" : "실패/없음/이미선택"}`);
        if (clicked) {
          await page.waitForLoadState("networkidle").catch(() => {});
          await page.waitForTimeout(1200);
          await this.scrollNudge(page);
          await page.waitForTimeout(800);

          // 클릭 후 네트워크에서 새로 잡힌 후보 반영
          const netAfter = net.getBest();
          if (netAfter > photoCount) {
            photoCount = netAfter;
            logs.push(`[리뷰&사진] (클릭후) 네트워크 photoCount 갱신: ${photoCount}`);
          }

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

      // 탭 영역 loose-number max
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

      // HTML 키 기반
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

      // ✅ 리스너 제거(중요)
      page.off("response", net.onResponse);

      // 오탐 컷
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
      // 안전하게 리스너 제거 시도
      try {
        // no-op
      } catch {}
      return { reviewCount: reviewCount || 0, photoCount: photoCount || 0, recentReviewCount30d, logs };
    }
  }

  // =========================
  // ✅ 네트워크에서 photoCount 잡는 수집기
  // =========================
  private static createPhotoNetworkCollector(placeId: string, logs: string[]) {
    const candidates: number[] = [];

    const pushCandidate = (n: any, why: string, url: string) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return;
      if (num <= 0 || num > 5000000) return;
      candidates.push(num);
      // 로그는 너무 커지면 안되니 상위 몇개만
      if (candidates.length <= 8) logs.push(`[NET] photoCount 후보 +${num} (${why}) @ ${url.slice(0, 140)}`);
    };

    const scanJson = (obj: any, url: string) => {
      // 흔한 키 우선
      const keyHits = [
        "businessPhotoCount",
        "placePhotoCount",
        "photoCount",
        "totalCount",
        "total",
        "count"
      ];

      for (const k of keyHits) {
        if (obj && typeof obj === "object" && k in obj) {
          pushCandidate((obj as any)[k], `key:${k}`, url);
        }
      }

      // 깊이 탐색(너무 깊으면 비용 큼 → depth 제한)
      const walk = (v: any, depth: number) => {
        if (depth > 4) return;
        if (!v) return;

        if (typeof v === "number") return;
        if (typeof v === "string") return;

        if (Array.isArray(v)) {
          for (const it of v.slice(0, 50)) walk(it, depth + 1);
          return;
        }

        if (typeof v === "object") {
          const entries = Object.entries(v).slice(0, 80);
          for (const [k, val] of entries) {
            if (
              k === "businessPhotoCount" ||
              k === "placePhotoCount" ||
              k === "photoCount" ||
              k === "totalCount" ||
              k === "total"
            ) {
              pushCandidate(val as any, `deepKey:${k}`, url);
            }
            walk(val, depth + 1);
          }
        }
      };

      walk(obj, 0);
    };

    const scanText = (text: string, url: string) => {
      // json 텍스트에서 키-값 regex
      const patterns: Array<[RegExp, string]> = [
        [/"businessPhotoCount"\s*:\s*([0-9]{1,7})/g, "re:businessPhotoCount"],
        [/"placePhotoCount"\s*:\s*([0-9]{1,7})/g, "re:placePhotoCount"],
        [/"photoCount"\s*:\s*([0-9]{1,7})/g, "re:photoCount"],
        [/"totalCount"\s*:\s*([0-9]{1,7})/g, "re:totalCount"],
        [/"total"\s*:\s*([0-9]{1,7})/g, "re:total"]
      ];

      for (const [re, why] of patterns) {
        const it = text.matchAll(re);
        for (const m of it) {
          if (m?.[1]) pushCandidate(parseInt(m[1], 10), why, url);
        }
      }
    };

    const onResponse = async (res: Response) => {
      try {
        const url = res.url();

        // 너무 광범위하면 비용/시간 증가 → 조건 걸기
        // 1) placeId 포함 또는 2) photo 관련 단어 포함
        const u = url.toLowerCase();
        const seemsRelated =
          u.includes(String(placeId)) ||
          u.includes("photo") ||
          u.includes("image") ||
          u.includes("media");

        if (!seemsRelated) return;

        const headers = res.headers();
        const ct = String(headers["content-type"] || "").toLowerCase();

        // json 또는 text만
        if (!ct.includes("json") && !ct.includes("text")) return;

        // 상태코드
        const status = res.status();
        if (status < 200 || status >= 400) return;

        // json 우선
        if (ct.includes("json")) {
          const data = await res.json().catch(() => null);
          if (data) scanJson(data, url);
          return;
        }

        // text fallback
        const text = await res.text().catch(() => "");
        if (text && text.length > 0) scanText(text, url);
      } catch {
        // ignore
      }
    };

    const getBest = () => {
      if (!candidates.length) return 0;
      // “사진 수”는 보통 꽤 큰 값. max가 그럴싸함.
      return Math.max(...candidates);
    };

    return { onResponse, getBest };
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
