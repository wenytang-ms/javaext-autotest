import type { Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS, SELECTORS } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  resolveWorkspacePlaceholders(value: unknown): unknown;
  runCommandFromPalette(label: string): Promise<void>;
  subScreenshot?(label: string): Promise<void>;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export interface QuickInputOperations {
  dismissAllNotifications(): Promise<void>;
  fillQuickInput(text: string): Promise<void>;
  fillAnyInput(text: string): Promise<void>;
  selectPaletteOption(optionText: string): Promise<void>;
  selectPaletteOptionByIndex(index: number): Promise<void>;
  typeInQuickInput(text: string): Promise<void>;
  getQuickInputValidationMessage(): Promise<string>;
  confirmQuickInput(): Promise<void>;
  dismissQuickInput(): Promise<void>;
  getNotifications(): Promise<string[]>;
  getStatusBarText(): Promise<string>;
}

export const quickInputOperations: QuickInputOperations = {
  async dismissAllNotifications(this: DriverContext): Promise<void> {
    try {
      await this.runCommandFromPalette("Notifications: Clear All Notifications");
    } catch {
      // Notification cleanup is best-effort.
    }
  },

  async fillQuickInput(this: DriverContext, text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const input = page.locator(SELECTORS.QUICK_INPUT);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill(resolvedText);
    await page.waitForTimeout(500);
    await page.keyboard.press(KEYS.ENTER);
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async fillAnyInput(this: DriverContext, text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const quickInput = page.locator(SELECTORS.QUICK_INPUT);
    const inlineInput = page.locator(".monaco-inputbox input:visible").first();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await quickInput.isVisible().catch(() => false)) {
        await quickInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(KEYS.ENTER);
        await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }
      if (await inlineInput.isVisible().catch(() => false)) {
        await inlineInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(KEYS.ENTER);
        await page.waitForTimeout(500);
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("No input field (quick input or inline rename) appeared within 15s");
  },

  async selectPaletteOption(this: DriverContext, optionText: string): Promise<void> {
    const page = this.getPage();
    // Resolution order (each falls back to the next if zero matches):
    //   1. exact accessible-name match — works for plain text labels.
    //   2. exact `.label-name` text match — disambiguates options whose
    //      accessible name picks up text from a codicon class (for example
    //      "Annotation" uses `$(symbol-interface)`, so `getByRole("option",
    //      { name: "Interface" })` matches both Interface AND Annotation).
    //      Matching on the visible label-name text avoids that.
    //   3. fuzzy accessible-name match — original behavior.
    const exactOption = page.getByRole("option", { name: optionText, exact: true }).locator("a");
    if (await exactOption.count() > 0) {
      await exactOption.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await exactOption.hover().catch(() => { /* best effort */ });
      await this.subScreenshot?.(`palette-${optionText}-pre-click`);
      await exactOption.click();
      await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
      return;
    }
    const labelNameMatch = page.locator("a.label-name", { hasText: new RegExp(`^${escapeRegex(optionText)}$`) });
    if (await labelNameMatch.count() > 0) {
      await labelNameMatch.first().waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await labelNameMatch.first().hover().catch(() => { /* best effort */ });
      await this.subScreenshot?.(`palette-${optionText}-pre-click`);
      await labelNameMatch.first().click();
      await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
      return;
    }
    const fuzzyOption = page.getByRole("option", { name: optionText }).locator("a").first();
    await fuzzyOption.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await fuzzyOption.hover().catch(() => { /* best effort */ });
    await this.subScreenshot?.(`palette-${optionText}-pre-click`);
    await fuzzyOption.click();
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async selectPaletteOptionByIndex(this: DriverContext, index: number): Promise<void> {
    const page = this.getPage();
    const option = page.getByRole("option").nth(index).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async typeInQuickInput(this: DriverContext, text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const input = page.locator(SELECTORS.QUICK_INPUT);
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(resolvedText);
    await page.waitForTimeout(500);
  },

  async getQuickInputValidationMessage(this: DriverContext): Promise<string> {
    const page = this.getPage();
    const msg = page.locator(".quick-input-widget .quick-input-message");
    const visible = await msg.isVisible().catch(() => false);
    if (!visible) return "";
    return await msg.textContent() ?? "";
  },

  async confirmQuickInput(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(KEYS.ENTER);
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async dismissQuickInput(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Escape");
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async getNotifications(this: DriverContext): Promise<string[]> {
    const page = this.getPage();
    return await page.locator(".notifications-toasts .notification-toast").allTextContents();
  },

  async getStatusBarText(this: DriverContext): Promise<string> {
    const page = this.getPage();
    return await page.locator(".statusbar").textContent() ?? "";
  },
};

