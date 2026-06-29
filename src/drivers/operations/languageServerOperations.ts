import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
}

export interface LanguageServerOperations {
  waitForLanguageServer(timeoutMs?: number): Promise<boolean>;
}

/**
 * Maximum extra time (ms) to wait for the post-Ready "Java: Building …" phase
 * to disappear from the status bar. redhat.java emits status updates in the
 * sequence Activating → Importing → Ready → Building 0%…100% → Ready, so a
 * naïve return-on-Ready can still capture an AFTER screenshot that shows
 * "Java: Building - 0%" — which the LLM verifier then (correctly) interprets
 * as "workspace not settled yet" and downgrades a passing step.
 *
 * This window is a *best-effort* stability hold layered on top of the
 * existing contract: if Build never finishes within the hold (e.g. very
 * large workspace), we still return true because LS Ready was achieved.
 */
const POST_READY_BUILD_SETTLE_MS = 20_000;
/** How long to wait after Ready for a Building status to even appear. */
const POST_READY_BUILD_DETECT_MS = 5_000;

function extractJavaStatus(text: string): string {
  const trimmed = text.trim();
  if (/^Java:/.test(trimmed) || /^☕/.test(trimmed)) return trimmed;
  return "";
}

/**
 * Best-effort wait for redhat.java's post-Ready "Building" phase to clear.
 * Always resolves; never throws and never returns a failure signal — the
 * caller has already decided Ready was achieved.
 */
async function waitForPostReadySettle(
  page: Page,
  readStatus: () => Promise<string>,
  budgetMs: number,
): Promise<void> {
  const start = Date.now();
  const pollInterval = 1000;

  // Phase 1: did "Building" even show up? Poll briefly; if not, we're done.
  const detectDeadline = Math.min(start + POST_READY_BUILD_DETECT_MS, start + budgetMs);
  let buildingSeen = false;
  while (Date.now() < detectDeadline) {
    const status = await readStatus();
    if (/Java:\s*Building/i.test(status)) {
      buildingSeen = true;
      console.log(`   ⏳ post-Ready settle — "${status}"`);
      break;
    }
    await page.waitForTimeout(pollInterval);
  }
  if (!buildingSeen) return;

  // Phase 2: wait until Building disappears or budget runs out.
  let lastReported = "";
  while (Date.now() - start < budgetMs) {
    const status = await readStatus();
    if (!/Java:\s*Building/i.test(status)) {
      const settleElapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`   ✅ build settled (${settleElapsed}s post-Ready)`);
      return;
    }
    if (status !== lastReported) {
      console.log(`   ⏳ post-Ready settle — "${status}"`);
      lastReported = status;
    }
    await page.waitForTimeout(pollInterval);
  }
  console.log(`   ⚠️ build did not settle within ${budgetMs / 1000}s — proceeding anyway`);
}

export const languageServerOperations: LanguageServerOperations = {
  async waitForLanguageServer(this: DriverContext, timeoutMs = 120_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();

    console.log(`   ⏳ Waiting for Language Server (timeout: ${timeoutMs / 1000}s)...`);

    const readStatus = async (): Promise<string> => {
      const statusItems = page.locator("footer a, footer [role='button']");
      const count = await statusItems.count();
      for (let i = 0; i < count; i++) {
        const raw = (await statusItems.nth(i).textContent().catch(() => ""))?.trim() ?? "";
        const match = extractJavaStatus(raw);
        if (match) return match;
      }
      return "";
    };

    // Event-driven readiness: Playwright auto-waits for the status-bar item
    // whose text reports "Java: Ready" (or the 👍 icon), watching DOM mutations
    // instead of fixed-interval polling. Timeout resolves to false to preserve
    // the soft-failure contract that callers/plans rely on (never throws).
    const ready = await page
      .locator("footer a, footer [role='button']")
      .filter({ hasText: /Java:\s*Ready|👍/ })
      .first()
      .waitFor({ state: "visible", timeout: timeoutMs })
      .then(() => true)
      .catch(() => false);

    if (!ready) {
      const lastStatus = await readStatus();
      console.log(`   ⚠️ Language Server not ready after ${timeoutMs / 1000}s (last: "${lastStatus}")`);
      return false;
    }

    const readyElapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`   ✅ Language Server ready (${readyElapsed}s)`);

    // Stability hold: after Ready, the status frequently transitions to
    // "Java: Building - 0%" within a few seconds while the workspace indexes.
    // Wait briefly for Build to either (a) never appear, or (b) appear and then
    // complete, so AFTER-screenshots are taken on a settled status line. The
    // hold is bounded by both POST_READY_BUILD_SETTLE_MS and any remaining
    // caller budget, and never downgrades a successful Ready to a failure.
    const remainingBudget = Math.max(0, timeoutMs - (Date.now() - start));
    const holdBudget = Math.min(POST_READY_BUILD_SETTLE_MS, remainingBudget);
    if (holdBudget > 0) {
      await waitForPostReadySettle(page, readStatus, holdBudget);
    }
    return true;
  },
};
