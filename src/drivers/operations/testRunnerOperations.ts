import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette(label: string): Promise<void>;
  openTestExplorer(): Promise<void>;
}

export interface TestRunnerOperations {
  openTestExplorer(): Promise<void>;
  runAllTests(): Promise<void>;
  runTestsWithProfile(profileName: string): Promise<void>;
  waitForTestComplete(timeoutMs?: number): Promise<boolean>;
  getTestResults(): Promise<{ passed: number; failed: number; total: number }>;
  clickCodeLens(label: string): Promise<void>;
  waitForTestDiscovery(testItemName: string, timeoutMs?: number): Promise<boolean>;
}

export const testRunnerOperations: TestRunnerOperations = {
  async openTestExplorer(this: DriverContext): Promise<void> {
    await this.runCommandFromPalette("Testing: Focus on Test Explorer View");
  },

  async runAllTests(this: DriverContext): Promise<void> {
    await this.runCommandFromPalette("Test: Run All Tests");
  },

  async runTestsWithProfile(this: DriverContext, profileName: string): Promise<void> {
    const page = this.getPage();
    await this.openTestExplorer();
    await page.waitForTimeout(1000);

    const splitDropdown = page.locator(".testing-explorer-header .monaco-dropdown-with-primary .dropdown-action-container");
    if (await splitDropdown.isVisible().catch(() => false)) {
      await splitDropdown.click();
      await page.waitForTimeout(500);
      const menuItem = page.getByText(profileName, { exact: false }).first();
      await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await menuItem.click();
      return;
    }

    const dropdownBtn = page.locator(".pane-header.testing .monaco-dropdown-button, .testing-explorer-header .monaco-dropdown-button").first();
    if (await dropdownBtn.isVisible().catch(() => false)) {
      await dropdownBtn.click();
      await page.waitForTimeout(500);
      const menuItem = page.getByText(profileName, { exact: false }).first();
      await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await menuItem.click();
      return;
    }

    const moreActions = page.locator(".testing-explorer-header .codicon-toolbar-more, .pane-header.testing .codicon-toolbar-more").first();
    if (await moreActions.isVisible().catch(() => false)) {
      await moreActions.click();
      await page.waitForTimeout(500);
      const menuItem = page.getByText(profileName, { exact: false }).first();
      if (await menuItem.isVisible().catch(() => false)) {
        await menuItem.click();
        return;
      }
      await page.keyboard.press("Escape");
    }

    const treeItem = page.getByRole("treeitem", { name: /appHasAGreeting|AppTest|kradle/i }).first();
    if (await treeItem.isVisible().catch(() => false)) {
      await treeItem.click({ button: "right" });
      await page.waitForTimeout(500);
      const profileOption = page.getByText(profileName, { exact: false }).first();
      if (await profileOption.isVisible().catch(() => false)) {
        await profileOption.click();
        return;
      }
      const runOption = page.locator(".context-view .action-label").filter({ hasText: /run/i }).first();
      if (await runOption.isVisible().catch(() => false)) {
        await runOption.hover();
        await page.waitForTimeout(300);
        const subOption = page.getByText(profileName, { exact: false }).first();
        if (await subOption.isVisible().catch(() => false)) {
          await subOption.click();
          return;
        }
      }
      await page.keyboard.press("Escape");
    }

    const runBtn = page.locator('[aria-label*="Run" i][aria-label*="Test" i]').first();
    if (await runBtn.isVisible().catch(() => false)) {
      await runBtn.click({ button: "right" });
      await page.waitForTimeout(500);
      const profileOption = page.getByText(profileName, { exact: false }).first();
      if (await profileOption.isVisible().catch(() => false)) {
        await profileOption.click();
        return;
      }
      await page.keyboard.press("Escape");
    }

    throw new Error(`Could not find Run Tests dropdown or profile "${profileName}" in Test Explorer`);
  },

  async waitForTestComplete(this: DriverContext, timeoutMs = 60_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      const spinning = await page.locator(".testing-progress-icon .codicon-loading").isVisible().catch(() => false);
      if (!spinning && Date.now() - start > 3000) {
        return true;
      }
      await page.waitForTimeout(2000);
    }
    return false;
  },

  async getTestResults(this: DriverContext): Promise<{ passed: number; failed: number; total: number }> {
    const page = this.getPage();
    await this.openTestExplorer();
    await page.waitForTimeout(500);

    const passedCount = await page.locator(".test-explorer .codicon-testing-passed-icon").count().catch(() => 0);
    const failedCount = await page.locator(".test-explorer .codicon-testing-failed-icon").count().catch(() => 0);

    return {
      passed: passedCount,
      failed: failedCount,
      total: passedCount + failedCount,
    };
  },

  async clickCodeLens(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    const codeLens = page.locator(".codelens-decoration a").filter({ hasText: label }).first();
    await codeLens.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await codeLens.click();
    await page.waitForTimeout(1000);
  },

  async waitForTestDiscovery(this: DriverContext, testItemName: string, timeoutMs = 300_000): Promise<boolean> {
    const page = this.getPage();
    const pollInterval = 5000;
    const deadline = Date.now() + timeoutMs;

    await this.openTestExplorer();
    await page.waitForTimeout(1000);

    console.log(`   ⏳ Waiting for test item "${testItemName}" to appear in Test Explorer sidebar (timeout: ${timeoutMs / 1000}s)...`);

    const sidebarSelector = ".split-view-view .tree-explorer-viewlet-tree-view";

    while (Date.now() < deadline) {
      const sidebar = page.locator(sidebarSelector).first();
      const sidebarVisible = await sidebar.isVisible().catch(() => false);

      if (sidebarVisible) {
        const item = sidebar.getByRole("treeitem", { name: new RegExp(testItemName, "i") }).first();
        const visible = await item.isVisible().catch(() => false);
        if (visible) {
          console.log(`   ✅ Test item "${testItemName}" found in Test Explorer sidebar!`);
          return true;
        }

        const allTreeItems = sidebar.getByRole("treeitem");
        const count = await allTreeItems.count().catch(() => 0);
        for (let i = 0; i < count; i++) {
          const ti = allTreeItems.nth(i);
          const expanded = await ti.getAttribute("aria-expanded").catch(() => null);
          if (expanded === "false") {
            const label = await ti.textContent().catch(() => "");
            console.log(`   ⏳ Expanding collapsed node: "${label?.substring(0, 40)}..."`);
            await ti.locator("a").first().click().catch(() => {});
            await page.waitForTimeout(2000);
            break;
          }
        }
      } else {
        console.log("   ⏳ Test Explorer sidebar not yet visible, re-opening...");
        await this.openTestExplorer();
      }

      const elapsed = Math.round((Date.now() - (deadline - timeoutMs)) / 1000);
      if (elapsed % 30 === 0) {
        console.log(`   ⏳ Still waiting... (${elapsed}s elapsed)`);
      }
      await page.waitForTimeout(pollInterval);
    }

    console.log(`   ❌ Test item "${testItemName}" did not appear within ${timeoutMs / 1000}s`);
    return false;
  },
};
