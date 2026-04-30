import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
  getProblemsCount(): Promise<{ errors: number; warnings: number }>;
  goToLine(line: number): Promise<void>;
  runCommandFromPalette(label: string): Promise<void>;
}

export interface DebugOperations {
  startDebugSession(): Promise<void>;
  stopDebugSession(): Promise<void>;
  setBreakpoint(line: number): Promise<void>;
  waitForBreakpointHit(timeoutMs?: number): Promise<boolean>;
  debugStepOver(): Promise<void>;
  debugStepInto(): Promise<void>;
  debugStepOut(): Promise<void>;
  getDebugVariables(): Promise<Array<{ name: string; value: string }>>;
  getDebugConsoleOutput(): Promise<string>;
  getOutputChannelText(channelName: string): Promise<string>;
}

export const debugOperations: DebugOperations = {
  async startDebugSession(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("F5");

    const toolbar = page.locator(".debug-toolbar");
    const errorDialog = page.locator(".monaco-dialog-box");
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
      if (await toolbar.isVisible().catch(() => false)) {
        return;
      }
      if (await errorDialog.isVisible().catch(() => false)) {
        const message = await errorDialog.locator(".dialog-message-text").textContent().catch(() => "") ?? "";
        await page.keyboard.press("Escape");
        throw new Error(`Debug session failed: ${message || "error dialog appeared"}`);
      }
      const problems = await this.getProblemsCount();
      if (problems.errors > 0) {
        throw new Error(`Debug session failed: ${problems.errors} compilation error(s) in project`);
      }
      await page.waitForTimeout(1000);
    }

    throw new Error("Debug session failed to start: debug toolbar did not appear within 30s");
  },

  async stopDebugSession(this: DriverContext): Promise<void> {
    const page = this.getPage();
    const toolbar = page.locator(".debug-toolbar");
    const isActive = await toolbar.isVisible().catch(() => false);
    if (!isActive) {
      console.log("   ⚠️ No active debug session to stop");
      return;
    }
    await page.keyboard.press("Shift+F5");
    await toolbar.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  },

  async setBreakpoint(this: DriverContext, line: number): Promise<void> {
    await this.goToLine(line);
    await this.runCommandFromPalette("Debug: Toggle Breakpoint");
  },

  async waitForBreakpointHit(this: DriverContext, timeoutMs = 30_000): Promise<boolean> {
    const page = this.getPage();
    try {
      await page.locator(".debug-toolbar .codicon-debug-continue").waitFor({
        state: "visible", timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  },

  async debugStepOver(this: DriverContext): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step over: no active debug session");
    }
    await page.keyboard.press("F10");
    await page.waitForTimeout(500);
  },

  async debugStepInto(this: DriverContext): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step into: no active debug session");
    }
    await page.keyboard.press("F11");
    await page.waitForTimeout(500);
  },

  async debugStepOut(this: DriverContext): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step out: no active debug session");
    }
    await page.keyboard.press("Shift+F11");
    await page.waitForTimeout(500);
  },

  async getDebugVariables(this: DriverContext): Promise<Array<{ name: string; value: string }>> {
    const page = this.getPage();
    await this.runCommandFromPalette("Debug: Focus on Variables View");
    await page.waitForTimeout(500);

    const items = await page.locator(".debug-view-content .monaco-list-row").all();
    const variables: Array<{ name: string; value: string }> = [];
    for (const item of items) {
      const text = await item.textContent().catch(() => "") ?? "";
      const match = text.match(/^(.+?)[\s:=]+(.+)$/);
      if (match) {
        variables.push({ name: match[1].trim(), value: match[2].trim() });
      }
    }
    return variables;
  },

  async getDebugConsoleOutput(this: DriverContext): Promise<string> {
    const page = this.getPage();
    await this.runCommandFromPalette("Debug Console: Focus on Debug Console View");
    await page.waitForTimeout(500);

    const output = await page.locator(".repl .monaco-list-rows").textContent().catch(() => "");
    return output ?? "";
  },

  async getOutputChannelText(this: DriverContext, channelName: string): Promise<string> {
    const page = this.getPage();
    const panel = page.locator(".part.panel").first();
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+j");
      await page.waitForTimeout(300);
    }

    const outputTab = page.locator('.part.panel .composite-bar li.action-item[role="tab"]')
      .filter({ has: page.locator("a.action-label", { hasText: /^Output$/i }) })
      .first();
    try {
      await outputTab.click({ timeout: 3000 });
      await page.waitForTimeout(400);
    } catch {
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+U`);
      await page.waitForTimeout(400);
    }

    const dropdown = page.locator(".part.panel select.monaco-select-box").first();
    if (await dropdown.count() > 0) {
      try {
        await dropdown.selectOption({ label: channelName });
        await page.waitForTimeout(500);
      } catch {
        // Channel not registered yet; leave current selection.
      }
    }

    const lines = page.locator(".part.panel .monaco-editor .view-lines").first();
    const raw = await lines.textContent().catch(() => "");
    return (raw ?? "").replace(/\u00A0/g, " ");
  },
};
