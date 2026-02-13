import type { Page, Frame } from 'playwright';

type Context = Page | Frame;

export class UiExpander {
  static async expandAll(page: Page, frame?: Frame | null): Promise<string[]> {
    const logs: string[] = [];
    try {
      logs.push('[UI] 더보기/정보 더보기 펼치기 시작');

      // page에서 먼저 시도
      const pageLogs = await this.expandInContext(page);
      logs.push(...pageLogs.map(l => `[UI][page] ${l}`));

      // frame이 있으면 frame에서도 시도
      if (frame) {
        const frameLogs = await this.expandInContext(frame);
        logs.push(...frameLogs.map(l => `[UI][frame] ${l}`));
      }

      logs.push('[UI] 더보기/정보 더보기 펼치기 종료');
      return logs;
    } catch (e: any) {
      logs.push(`[UI] 오류: ${e?.message || String(e)}`);
      return logs;
    }
  }

  private static async expandInContext(ctx: Context): Promise<string[]> {
    const logs: string[] = [];

    // “더보기” 류 버튼들이 여러 번 나오므로 여러 라운드로 눌러준다
    for (let round = 1; round <= 6; round++) {
      const clicked = await this.clickOnce(ctx);
      logs.push(`round ${round}: clicked=${clicked}`);
      if (!clicked) break;
      // 클릭 후 렌더링 대기
      await ctx.waitForTimeout(700);
    }

    return logs;
  }

  private static async clickOnce(ctx: Context): Promise<boolean> {
    // 텍스트 기반으로 가장 안전하게 찾기
    const textCandidates = [
      '정보 더보기',
      '더보기',
      '펼치기',
      '상세정보',
      '소개 더보기',
      '영업시간 더보기'
    ];

    // 1) 텍스트 버튼 찾기
    for (const t of textCandidates) {
      const loc = ctx.locator('button, a, div[role="button"]', { hasText: t }).first();
      if (await loc.count().catch(() => 0)) {
        try {
          await loc.scrollIntoViewIfNeeded().catch(() => {});
          await loc.click({ timeout: 1500 }).catch(() => {});
          return true;
        } catch {}
      }
    }

    // 2) aria-label / title에 더보기 들어간 케이스
    const ariaLoc = ctx
      .locator('button[aria-label*="더보기"], a[aria-label*="더보기"], div[role="button"][aria-label*="더보기"]')
      .first();

    if (await ariaLoc.count().catch(() => 0)) {
      try {
        await ariaLoc.scrollIntoViewIfNeeded().catch(() => {});
        await ariaLoc.click({ timeout: 1500 }).catch(() => {});
        return true;
      } catch {}
    }

    return false;
  }
}
