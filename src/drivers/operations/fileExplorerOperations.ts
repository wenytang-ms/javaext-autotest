import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;
const ENTER_KEY = "Enter";

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
    await item.click({ button: "right" });

    const menu = page.locator(".monaco-menu-container .monaco-menu");
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const menuItem = menu.getByRole("menuitem", { name: menuLabel });
    await menuItem.first().waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await menuItem.first().hover();
    await page.locator(".monaco-menu-container .action-item.focused").waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT,
    }).catch(() => {});
    await menuItem.first().click();
    await page.waitForTimeout(500);
  },

  async createNewFileViaExplorer(this: DriverContext, parentFolder: string, fileName: string): Promise<void> {
    await this.contextMenuOnTreeItem(parentFolder, "New File");

    const page = this.getPage();
    const input = page.locator(".explorer-viewlet .monaco-inputbox input").first();
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(fileName);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  },
};
