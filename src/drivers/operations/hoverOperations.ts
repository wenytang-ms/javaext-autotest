import type { Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, dismissWidget } from "./_shared.js";

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

    const hoverWidget = page.locator(".monaco-editor-hover, .monaco-hover")
      .filter({ has: page.locator(".hover-row, .monaco-hover-content") }).first();
    // The hover popup renders only after the mouse dwells over the token, and
    // a single hover() may not register the dwell. Retry the hover until the
    // popup DOM node becomes visible. With `editor.hover.sticky: true` it stays
    // mounted once shown, so visibility is the only signal we need — no fixed
    // sleep is required to keep it up for the after-step screenshot.
    for (let attempt = 0; attempt < 4; attempt++) {
      await target.hover();
      const visible = await hoverWidget.waitFor({ state: "visible", timeout: 4000 })
        .then(() => true).catch(() => false);
      if (visible) {
        return;
      }
    }
    throw new Error(`Hover popup did not appear for "${text}"`);
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
    await dismissWidget(this.getPage(), ".monaco-hover");
  },
};
