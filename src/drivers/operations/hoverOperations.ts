import { errors, type Page } from "@playwright/test";
import type { ActionExecutionContext } from "../../types.js";
import { DEFAULT_TIMEOUT, dismissWidget } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  subScreenshot?(label: string): Promise<void>;
}

export interface HoverOperations {
  hoverOnText(text: string): Promise<void>;
  hoverAndClickAction(text: string, label: string, context: ActionExecutionContext): Promise<void>;
  getHoverContent(): Promise<string>;
  clickHoverAction(label: string): Promise<void>;
  dismissHover(): Promise<void>;
}

// This callback executes in the renderer and must not depend on module globals.
export function observeHoverAction(label: string) {
  const visible = (element: HTMLElement) => {
    const style = getComputedStyle(element);
    const bounds = element.getBoundingClientRect();
    return style.visibility !== "hidden" && style.display !== "none" &&
      bounds.width > 0 && bounds.height > 0;
  };
  const expected = label.trim().replace(/\s+/g, " ").toLowerCase();
  let opened = false;
  const read = (): "ready" | "lost" | false => {
    const actions = document.querySelectorAll<HTMLElement>(
      ".monaco-hover-content a, .monaco-hover-content .action-label",
    );
    if (Array.from(actions).some(element =>
      visible(element) &&
      !element.closest('[aria-disabled="true"], .disabled') &&
      element.textContent?.trim().replace(/\s+/g, " ").toLowerCase() === expected,
    )) {
      opened = true;
      return "ready";
    }
    const contents = document.querySelectorAll<HTMLElement>(
      ".monaco-hover-content, .monaco-editor-hover .hover-row",
    );
    if (Array.from(contents).some(visible)) {
      opened = true;
      return false;
    }
    return opened ? "lost" : false;
  };
  const observer = new MutationObserver(() => { read(); });
  observer.observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ["style", "class", "aria-disabled"],
  });
  read();
  return {
    get opened() { return opened; },
    read,
    disconnect() { observer.disconnect(); },
  };
}

export const hoverOperations: HoverOperations = {
  async hoverAndClickAction(
    this: DriverContext, text: string, label: string, context: ActionExecutionContext,
  ): Promise<void> {
    if (!text.trim() || !label.trim() || !Number.isFinite(context.deadline)) {
      throw new Error("hoverAndClickAction requires non-empty text, label, and a finite execution deadline");
    }
    const page = this.getPage();
    const target = page.locator(".monaco-editor .view-lines").getByText(text, { exact: false }).first();
    const escapedLabel = label.trim().split(/\s+/)
      .map(word => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s+");
    const action = page.locator(".monaco-hover-content a, .monaco-hover-content .action-label")
      .filter({ hasText: new RegExp(`^\\s*${escapedLabel}\\s*$`, "i") })
      .filter({ visible: true }).first();
    let phase = "opening";
    let recoveries = 0;
    const remaining = () => {
      const budget = context.deadline - Date.now();
      if (budget <= 0) throw new errors.TimeoutError("Step execution deadline reached");
      return budget;
    };
    try {
      while (true) {
        phase = recoveries ? "recovering" : "opening";
        if (recoveries) {
          await page.locator(".monaco-editor .margin").filter({ visible: true }).first()
            .hover({ timeout: remaining() });
        }
        // Observe before triggering hover so a short-lived popup cannot be missed.
        const monitor = await page.evaluateHandle(observeHoverAction, label);
        try {
          await target.hover({ timeout: remaining() });
          const opening = await page.waitForFunction(
            current => current.opened, monitor, { timeout: remaining() },
          );
          await opening.dispose();
          await this.subScreenshot?.(recoveries ? "hover-restored" : "hover-open");
          phase = "waiting-for-link";
          while (true) {
            const handle = await page.waitForFunction(
              current => current.read(), monitor, { timeout: remaining() },
            );
            const state = await handle.jsonValue();
            await handle.dispose();
            if (state === "lost") break;
            await this.subScreenshot?.("hover-action-ready");
            if (await monitor.evaluate(current => current.read()) !== "ready") continue;
            phase = "clicking";
            await action.click({ timeout: remaining() });
            return;
          }
        } finally {
          if (!page.isClosed()) await monitor.evaluate(current => current.disconnect());
          await monitor.dispose();
        }
        recoveries += 1;
        console.log(`   ↻ Hover disappeared; restoring "${text}" (recovery ${recoveries})`);
        await this.subScreenshot?.("hover-lost");
      }
    } catch (error) {
      if (!(error instanceof errors.TimeoutError)) throw error;
      const hoverText = page.isClosed() ? "(page closed)" :
        (await page.locator(".monaco-hover-content").filter({ visible: true }).allTextContents())
          .join("\n").slice(0, 1024);
      throw new Error(
        `Hover action "${label}" did not complete before the step execution deadline ` +
        `(phase: ${phase}, recoveries: ${recoveries}, hover: ${JSON.stringify(hoverText)})`,
        { cause: error },
      );
    }
  },

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
