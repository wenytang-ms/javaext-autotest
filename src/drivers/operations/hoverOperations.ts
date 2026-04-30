import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;

interface DriverContext {
  getPage(): Page;
}

export interface HoverOperations {
  hoverOnText(text: string): Promise<void>;
  getHoverContent(): Promise<string>;
  clickHoverAction(label: string): Promise<void>;
  dismissHover(): Promise<void>;
}

export const hoverOperations: HoverOperations = {
  async hoverOnText(this: DriverContext, text: string): Promise<void> {
    const page = this.getPage();
    const target = page.locator(".monaco-editor .view-lines").getByText(text, { exact: false }).first();
    await target.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await target.hover();

    const hoverWidget = page.locator(".monaco-hover");
    const visible = await hoverWidget.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT })
      .then(() => true).catch(() => false);
    if (!visible) {
      throw new Error(`Hover popup did not appear for "${text}"`);
    }
  },

  async getHoverContent(this: DriverContext): Promise<string> {
    const page = this.getPage();
    return await page.locator(".monaco-hover-content").textContent().catch(() => "") ?? "";
  },

  async clickHoverAction(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    const action = page.locator(".monaco-hover-content a, .monaco-hover-content .action-label")
      .filter({ hasText: label }).first();
    await action.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await action.click();
    await page.waitForTimeout(500);
  },

  async dismissHover(this: DriverContext): Promise<void> {
    await this.getPage().keyboard.press("Escape");
    await this.getPage().locator(".monaco-hover").waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },
};
