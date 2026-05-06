import type { Locator, Page } from "@playwright/test";

/**
 * Shared constants and helpers for Driver operation modules.
 *
 * Operation modules should import from here instead of redefining the
 * same selectors / timeouts / modifier-key logic locally.
 */

export const DEFAULT_TIMEOUT = 5000;

export const KEYS = {
  ENTER: "Enter",
  ESCAPE: "Escape",
  COMMAND_PALETTE: "F1",
  TRIGGER_SUGGEST: "Control+Space",
  CODE_ACTION: "Control+.",
} as const;

export const SELECTORS = {
  QUICK_INPUT: ".quick-input-box input",
  QUICK_INPUT_WIDGET: ".quick-input-widget",
  SUGGEST_WIDGET: ".editor-widget.suggest-widget",
  WORKBENCH: ".monaco-workbench",
  MONACO_LIST_ROW: ".monaco-list-row",
} as const;

/** Returns the platform-appropriate keyboard modifier (Meta on macOS, Control elsewhere). */
export function getModifierKey(): string {
  return process.platform === "darwin" ? "Meta" : "Control";
}

/**
 * Press Escape and wait for a widget locator to become hidden.
 * Failure to hide is intentionally swallowed — caller only needs best-effort cleanup.
 */
export async function dismissWidget(
  page: Page,
  widgetSelectorOrLocator: string | Locator,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<void> {
  await page.keyboard.press(KEYS.ESCAPE);
  const locator = typeof widgetSelectorOrLocator === "string"
    ? page.locator(widgetSelectorOrLocator)
    : widgetSelectorOrLocator;
  await locator.waitFor({ state: "hidden", timeout }).catch(() => {});
}
