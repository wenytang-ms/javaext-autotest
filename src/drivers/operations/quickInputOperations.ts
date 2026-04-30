import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;
const ENTER_KEY = "Enter";
const QUICK_INPUT_SELECTOR = ".quick-input-box input";
const QUICK_INPUT_WIDGET_SELECTOR = ".quick-input-widget";

interface DriverContext {
  getPage(): Page;
  resolveWorkspacePlaceholders(value: unknown): unknown;
  runCommandFromPalette(label: string): Promise<void>;
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
    const input = page.locator(QUICK_INPUT_SELECTOR);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill(resolvedText);
    await page.waitForTimeout(500);
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async fillAnyInput(this: DriverContext, text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const quickInput = page.locator(QUICK_INPUT_SELECTOR);
    const inlineInput = page.locator(".monaco-inputbox input:visible").first();

    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await quickInput.isVisible().catch(() => false)) {
        await quickInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(ENTER_KEY);
        await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }
      if (await inlineInput.isVisible().catch(() => false)) {
        await inlineInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(ENTER_KEY);
        await page.waitForTimeout(500);
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("No input field (quick input or inline rename) appeared within 15s");
  },

  async selectPaletteOption(this: DriverContext, optionText: string): Promise<void> {
    const page = this.getPage();
    const exactOption = page.getByRole("option", { name: optionText, exact: true }).locator("a");
    const fuzzyOption = page.getByRole("option", { name: optionText }).locator("a");
    const option = (await exactOption.count()) > 0 ? exactOption : fuzzyOption;
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async selectPaletteOptionByIndex(this: DriverContext, index: number): Promise<void> {
    const page = this.getPage();
    const option = page.getByRole("option").nth(index).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async typeInQuickInput(this: DriverContext, text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const input = page.locator(QUICK_INPUT_SELECTOR);
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
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async dismissQuickInput(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Escape");
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
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
