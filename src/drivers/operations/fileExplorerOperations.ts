import type { Locator, Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void>;
  contextMenuOnTreeItemSubmenu(itemName: string, submenuLabel: string, leafLabel: string): Promise<void>;
  subScreenshot?(label: string): Promise<void>;
}

export interface FileExplorerOperations {
  contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void>;
  contextMenuOnTreeItemSubmenu(itemName: string, submenuLabel: string, leafLabel: string): Promise<void>;
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

    // Selection-click on the target row already runs above (line 30). At
    // this point the row is selected/highlighted, so the pre-right-click
    // frame shows "what the user is about to right-click" before the menu
    // appears.
    await this.subScreenshot?.(`tree-${itemName}-pre-rightclick`);

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
      await this.subScreenshot?.(`context-menu-${menuLabel}-pre-click`);
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

  /**
   * Right-click a tree item, hover a submenu trigger to open the nested menu,
   * then click a leaf menu item inside the nested menu.
   *
   * Use this for two-level context menus contributed via VS Code's `submenus`
   * (e.g. the "Maven" / "Gradle" sub-menus that host `java.project.update`).
   * The flat single-level `contextMenuOnTreeItem` cannot reach them because
   * the leaf is hidden until the parent submenu item is hovered/opened.
   */
  async contextMenuOnTreeItemSubmenu(
    this: DriverContext,
    itemName: string,
    submenuLabel: string,
    leafLabel: string,
  ): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name: itemName, exact: true }).locator("a").first();
    const fuzzyItem = page.getByRole("treeitem", { name: itemName }).locator("a").first();
    const item = await exactItem.count() > 0 ? exactItem : fuzzyItem;
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.scrollIntoViewIfNeeded();

    try {
      await item.click({ timeout: 5_000 });
      await page.waitForTimeout(150);
    } catch {
      // Selection is best-effort; right-click below also tries to select.
    }

    await this.subScreenshot?.(`tree-${itemName}-pre-rightclick`);

    const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const submenuEscaped = escapeRegex(submenuLabel);
    const leafEscaped = escapeRegex(leafLabel);

    const findMenuItem = async (menu: ReturnType<Page["locator"]>, label: string, escaped: string): Promise<Locator | undefined> => {
      const matchers: Locator[] = [
        menu.getByRole("menuitem", { name: label, exact: true }),
        menu.getByRole("menuitem", { name: new RegExp(`^${escaped}\\.{0,3}$`, "i") }),
        menu.getByRole("menuitem", { name: label }),
      ];
      for (const candidate of matchers) {
        if (await candidate.count() > 0) {
          return candidate.first();
        }
      }
      return undefined;
    };

    for (let attempt = 0; attempt < 2; attempt++) {
      await item.click({ button: "right" });

      const rootMenu = page.locator(".monaco-menu-container .monaco-menu").first();
      await rootMenu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      const submenuTrigger = await findMenuItem(rootMenu, submenuLabel, submenuEscaped);
      if (!submenuTrigger) {
        throw new Error(`Submenu "${submenuLabel}" not found on tree item "${itemName}"`);
      }

      await submenuTrigger.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await submenuTrigger.hover();
      // Submenus expand on hover; wait briefly for the nested menu to mount.
      await page.waitForTimeout(250);
      await this.subScreenshot?.(`context-submenu-${submenuLabel}-pre-hover-leaf`);

      // After hover, a second .monaco-menu element is mounted for the nested
      // menu. Selecting `.last()` reliably picks the newly-opened submenu —
      // the root menu remains in the DOM but is no longer the deepest one.
      const nestedMenu = page.locator(".monaco-menu-container .monaco-menu").last();
      await nestedMenu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });

      const leaf = await findMenuItem(nestedMenu, leafLabel, leafEscaped);
      if (!leaf) {
        // Submenu opened but leaf missing — escape and retry once.
        await page.keyboard.press(KEYS.ESCAPE).catch(() => { /* best effort */ });
        if (attempt === 0) {
          await page.waitForTimeout(300);
          continue;
        }
        throw new Error(
          `Submenu "${submenuLabel}" opened but leaf "${leafLabel}" not found on tree item "${itemName}"`,
        );
      }

      await leaf.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await leaf.hover();
      await page.locator(".monaco-menu-container .action-item.focused").waitFor({
        state: "visible",
        timeout: DEFAULT_TIMEOUT,
      }).catch(() => { /* best effort */ });
      await this.subScreenshot?.(`context-submenu-${leafLabel}-pre-click`);
      await leaf.click();

      try {
        await rootMenu.waitFor({ state: "hidden", timeout: 1_500 });
        await page.waitForTimeout(300);
        return;
      } catch {
        if (attempt === 0) {
          await page.keyboard.press(KEYS.ESCAPE).catch(() => { /* best effort */ });
          await page.waitForTimeout(300);
          continue;
        }
        throw new Error(
          `Submenu did not dismiss after clicking "${leafLabel}" under "${submenuLabel}" on "${itemName}" — ` +
          `the click likely did not reach the leaf menu item.`,
        );
      }
    }
  },
};

