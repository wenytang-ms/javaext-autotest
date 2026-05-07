import type { Locator, Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void>;
}

export interface FileExplorerOperations {
  contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void>;
  createNewFileViaExplorer(parentFolder: string, fileName: string): Promise<void>;
}

export const fileExplorerOperations: FileExplorerOperations = {
  async contextMenuOnTreeItem(this: DriverContext, itemName: string, menuLabel: string): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name: itemName, exact: true }).locator("a").first();
    const fuzzyItem = page.getByRole("treeitem", { name: itemName }).locator("a").first();
    const item = await exactItem.count() > 0 ? exactItem : fuzzyItem;
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.scrollIntoViewIfNeeded();

    // Pre-select the target with a left-click so the row owns selection/focus
    // before the context menu opens. Without this, on some platforms
    // (notably Windows) right-click does not consistently select the row,
    // and the resulting menu commands operate on the previously-focused
    // item — producing a green `contextMenu` step but a no-op command.
    try {
      await item.click({ timeout: 5_000 });
      await page.waitForTimeout(150);
    } catch {
      // Selection is best-effort; right-click below also tries to select.
    }

    const escaped = menuLabel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    for (let attempt = 0; attempt < 2; attempt++) {
      await item.click({ button: "right" });

      const menu = page.locator(".monaco-menu-container .monaco-menu");
      await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      // Resolve menu item using exact > exact-with-ellipsis > substring tiers.
      // Without this tiering, Playwright's default substring match silently
      // picks the first DOM-order menuitem whose name *contains* the label
      // (e.g. `Delete` could match `Delete Forever`).
      const matchers: Locator[] = [
        menu.getByRole("menuitem", { name: menuLabel, exact: true }),
        menu.getByRole("menuitem", { name: new RegExp(`^${escaped}\\.{0,3}$`, "i") }),
        menu.getByRole("menuitem", { name: menuLabel }),
      ];
      let menuItem: Locator | undefined;
      for (const candidate of matchers) {
        if (await candidate.count() > 0) {
          menuItem = candidate.first();
          break;
        }
      }
      if (!menuItem) {
        throw new Error(`Context menu item "${menuLabel}" not found on tree item "${itemName}"`);
      }

      await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await menuItem.hover();
      await page.locator(".monaco-menu-container .action-item.focused").waitFor({
        state: "visible",
        timeout: DEFAULT_TIMEOUT,
      }).catch(() => { /* best effort */ });
      await menuItem.click();

      // Verify the menu dismissed — proxy for "the command actually fired".
      // If the menu is still open, the click didn't reach the menu item
      // (e.g. menu repainted, focus stolen). Close it and retry once.
      try {
        await menu.waitFor({ state: "hidden", timeout: 1_500 });
        await page.waitForTimeout(300);
        return;
      } catch {
        if (attempt === 0) {
          await page.keyboard.press(KEYS.ESCAPE).catch(() => { /* best effort */ });
          await page.waitForTimeout(300);
          continue;
        }
        throw new Error(
          `Context menu did not dismiss after clicking "${menuLabel}" on "${itemName}" — ` +
          `the click likely did not reach the menu item.`,
        );
      }
    }
  },

  async createNewFileViaExplorer(this: DriverContext, parentFolder: string, fileName: string): Promise<void> {
    await this.contextMenuOnTreeItem(parentFolder, "New File");

    const page = this.getPage();
    const input = page.locator(".explorer-viewlet .monaco-inputbox input").first();
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(fileName);
    await page.keyboard.press(KEYS.ENTER);
    await page.waitForTimeout(1000);
  },
};

