import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
}

export interface LanguageServerOperations {
  waitForLanguageServer(timeoutMs?: number): Promise<boolean>;
}

export const languageServerOperations: LanguageServerOperations = {
  async waitForLanguageServer(this: DriverContext, timeoutMs = 120_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();
    const pollInterval = 2000;

    console.log(`   ⏳ Waiting for Language Server (timeout: ${timeoutMs / 1000}s)...`);

    let lastStatus = "";
    while (Date.now() - start < timeoutMs) {
      const statusItems = page.locator("footer a, footer [role='button']");
      const count = await statusItems.count();
      let currentStatus = "";

      for (let i = 0; i < count; i++) {
        const text = (await statusItems.nth(i).textContent().catch(() => ""))?.trim() ?? "";
        if (/^Java:/.test(text) || /^☕/.test(text)) {
          currentStatus = text;
          break;
        }
      }

      if (currentStatus && currentStatus !== lastStatus) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`   ⏳ ${elapsed}s — "${currentStatus}"`);
        lastStatus = currentStatus;
      }

      if (/Java:\s*Ready/i.test(currentStatus) || currentStatus.includes("👍")) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`   ✅ Language Server ready (${elapsed}s)`);
        return true;
      }

      await page.waitForTimeout(pollInterval);
    }

    console.log(`   ⚠️ Language Server not ready after ${timeoutMs / 1000}s (last: "${lastStatus}")`);
    return false;
  },
};
