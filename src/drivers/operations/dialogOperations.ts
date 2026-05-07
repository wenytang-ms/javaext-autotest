import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
  clickDialogButton(label: string): Promise<void>;
}

/**
 * Wait for a confirmation dialog and click a recognized confirm button.
 * Throws if the dialog never appears or no button matches.
 */
async function clickConfirmButton(page: Page, timeoutMs: number): Promise<void> {
  const dialog = page.locator(".monaco-dialog-box");
  await dialog.waitFor({ state: "visible", timeout: timeoutMs });

  const confirmLabels = ["OK", "Delete", "Move to Recycle Bin", "Move to Trash", "Yes", "Continue"];
  for (const label of confirmLabels) {
    const btn = dialog.getByRole("button", { name: label });
    if (await btn.count() > 0) {
      await btn.first().click();
      return;
    }
  }

  const firstBtn = dialog.locator(".dialog-buttons button").first();
  if (await firstBtn.count() > 0) {
    await firstBtn.click();
    return;
  }

  throw new Error("Confirmation dialog appeared but no clickable button was found");
}

export interface DialogOperations {
  isDialogVisible(): Promise<boolean>;
  getDialogMessage(): Promise<string>;
  clickDialogButton(label: string): Promise<void>;
  waitForDialog(timeoutMs?: number): Promise<void>;
  tryClickDialogButton(label: string, timeoutMs?: number): Promise<void>;
  confirmDialog(timeoutMs?: number): Promise<void>;
  expectConfirmDialog(timeoutMs?: number): Promise<void>;
  tryClickButton(label: string, timeoutMs?: number): Promise<void>;
}

export const dialogOperations: DialogOperations = {
  async isDialogVisible(this: DriverContext): Promise<boolean> {
    const page = this.getPage();
    return await page.locator(".monaco-dialog-box").isVisible().catch(() => false);
  },

  async getDialogMessage(this: DriverContext): Promise<string> {
    const page = this.getPage();
    return await page.locator(".monaco-dialog-box .dialog-message-text").textContent().catch(() => "") ?? "";
  },

  async clickDialogButton(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    const dialog = page.locator(".monaco-dialog-box");
    await dialog.waitFor({ state: "visible", timeout: 10_000 });

    const roleButton = dialog.getByRole("button", { name: new RegExp(label, "i") });
    if (await roleButton.count() > 0) {
      await roleButton.first().click();
      return;
    }

    const buttons = dialog.locator(".dialog-buttons button");
    const count = await buttons.count();
    for (let i = 0; i < count; i++) {
      const text = await buttons.nth(i).textContent() ?? "";
      if (text.toLowerCase().includes(label.toLowerCase())) {
        await buttons.nth(i).click();
        return;
      }
    }

    throw new Error(`Dialog button "${label}" not found`);
  },

  async waitForDialog(this: DriverContext, timeoutMs: number = 10_000): Promise<void> {
    const page = this.getPage();
    await page.locator(".monaco-dialog-box").waitFor({ state: "visible", timeout: timeoutMs });
  },

  async tryClickDialogButton(this: DriverContext, label: string, timeoutMs = 5_000): Promise<void> {
    try {
      const page = this.getPage();
      const dialog = page.locator(".monaco-dialog-box");
      await dialog.waitFor({ state: "visible", timeout: timeoutMs });
      await this.clickDialogButton(label);
    } catch {
      // Optional dialogs are action-dependent; absence is a successful no-op.
    }
  },

  async confirmDialog(this: DriverContext, timeoutMs = 5_000): Promise<void> {
    try {
      await clickConfirmButton(this.getPage(), timeoutMs);
    } catch {
      // Optional dialogs are action-dependent; absence is a successful no-op.
    }
  },

  /**
   * Strict variant of `confirmDialog`: throws if no confirmation dialog
   * appears within `timeoutMs`, or if no recognizable confirm button is found.
   * Use this for steps that *must* surface a confirmation dialog (e.g. delete
   * with `explorer.confirmDelete=true`); it pins the failure to the actual
   * problem instead of silently passing and surfacing a misleading downstream
   * symptom (e.g. "tree item didn't disappear") many seconds later.
   */
  async expectConfirmDialog(this: DriverContext, timeoutMs = 5_000): Promise<void> {
    await clickConfirmButton(this.getPage(), timeoutMs);
  },

  async tryClickButton(this: DriverContext, label: string, timeoutMs = 3_000): Promise<void> {
    try {
      const page = this.getPage();
      const btn = page.getByRole("button", { name: label });
      if (await btn.isVisible({ timeout: timeoutMs }).catch(() => false)) {
        await btn.first().click();
        await page.waitForTimeout(500);
      }
    } catch {
      // Optional workbench buttons are action-dependent; absence is a successful no-op.
    }
  },
};
