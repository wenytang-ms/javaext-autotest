import type { Locator, Page } from "@playwright/test";
import { DEFAULT_TIMEOUT } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  subScreenshot?(label: string): Promise<void>;
}

/**
 * Scope a tree-item search to a single view pane (e.g. "Java Projects").
 * VS Code wraps each view section in a `.pane` element with its title.
 * Looking up the pane by its visible heading text is more robust than
 * relying on view IDs, and works for both built-in and third-party views.
 */
function scopeForView(page: Page, viewName: string): Locator {
  // Match a `.pane` element whose header text equals/contains the view name.
  // VS Code wraps each side-bar view in `.pane` with a `.pane-header` containing
  // the title — same selector used by collapseSidebarSection.
  return page.locator(".pane").filter({
    has: page.locator(".pane-header", { hasText: viewName }),
  });
}

export interface TreeOperations {
  activeSideTab(tabName: string): Promise<void>;
  isSideTabVisible(tabName: string): Promise<boolean>;
  collapseSidebarSection(sectionLabel: string): Promise<void>;
  collapseWorkspaceRoot(): Promise<void>;
  clickTreeItem(name: string): Promise<void>;
  expandTreeItem(name: string): Promise<void>;
  doubleClickTreeItem(name: string): Promise<void>;
  isTreeItemVisible(name: string): Promise<boolean>;
  waitForTreeItem(name: string, timeoutMs?: number, exact?: boolean, inView?: string): Promise<boolean>;
  waitForTreeItemGone(name: string, timeoutMs?: number, exact?: boolean, inView?: string): Promise<boolean>;
  clickTreeItemAction(itemName: string, actionLabel: string): Promise<void>;
  clickViewTitleAction(viewName: string, actionLabel: string): Promise<void>;
  clickEditorTitleAction(actionLabel: string): Promise<void>;
  waitForEditorTab(title: string, timeoutMs?: number): Promise<boolean>;
}

export const treeOperations: TreeOperations = {
  async activeSideTab(this: DriverContext, tabName: string): Promise<void> {
    const page = this.getPage();
    const tab = page.getByRole("tab", { name: tabName }).locator("a");
    await tab.click();
    await page.waitForTimeout(500);
  },

  async isSideTabVisible(this: DriverContext, tabName: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("tab", { name: tabName }).isVisible();
  },

  async collapseSidebarSection(this: DriverContext, sectionLabel: string): Promise<void> {
    const page = this.getPage();
    const header = page.locator('.pane-header[aria-expanded="true"]').filter({ hasText: sectionLabel });
    if (await header.count() > 0) {
      await header.first().click();
      await page.waitForTimeout(500);
    }
  },

  async collapseWorkspaceRoot(this: DriverContext): Promise<void> {
    const page = this.getPage();
    const twistieBox = await page.evaluate(() => {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        ".explorer-folders-view .monaco-list-row[aria-expanded='true'][aria-level='1'], " +
        ".explorer-folders-view [role='treeitem'][aria-expanded='true'][aria-level='1']"
      ));
      const row = candidates.find(candidate => {
        const rect = candidate.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
      const twistie = row?.querySelector<HTMLElement>(".monaco-tl-twistie");
      const rect = twistie?.getBoundingClientRect();
      return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
    });

    if (twistieBox) {
      await page.mouse.move(twistieBox.x + twistieBox.width / 2, twistieBox.y + twistieBox.height / 2);
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(500);
    }
  },

  async clickTreeItem(this: DriverContext, name: string): Promise<void> {
    const page = this.getPage();
    const item = page.getByRole("treeitem", { name }).locator("a").first();
    await item.waitFor({ state: "visible", timeout: 15_000 });
    await item.scrollIntoViewIfNeeded();
    try {
      await item.click({ timeout: 5_000 });
    } catch {
      await page.evaluate((el) => el?.scrollIntoView({ block: "center" }), await item.elementHandle());
      await item.click({ timeout: 5_000 });
    }
    await page.waitForTimeout(500);
  },

  async expandTreeItem(this: DriverContext, name: string): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name, exact: true }).first();
    const item = await exactItem.count() > 0 ? exactItem : page.getByRole("treeitem", { name }).first();
    await item.waitFor({ state: "visible", timeout: 15_000 });
    await item.scrollIntoViewIfNeeded();

    const expanded = await item.getAttribute("aria-expanded").catch(() => null);
    if (expanded === "true") return;

    const twistieBox = await item.evaluate((element) => {
      const row = element.closest<HTMLElement>(".monaco-list-row") ?? element as HTMLElement;
      const rowRect = row.getBoundingClientRect();
      const twistie = row.querySelector<HTMLElement>(".monaco-tl-twistie");
      const twistieRect = twistie?.getBoundingClientRect();
      const indent = row.querySelector<HTMLElement>(".monaco-tl-indent");
      const indentRect = indent?.getBoundingClientRect();
      if (twistieRect && twistieRect.width > 0 && twistieRect.height > 0) {
        return { x: twistieRect.x, y: twistieRect.y, width: twistieRect.width, height: twistieRect.height };
      }
      const fallbackX = (indentRect?.right ?? rowRect.left) + 8;
      return { x: fallbackX - 8, y: rowRect.y, width: 16, height: rowRect.height };
    });
    if (!twistieBox) {
      throw new Error(`Tree item "${name}" does not have an expandable twistie`);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      await page.mouse.move(twistieBox.x + twistieBox.width / 2, twistieBox.y + twistieBox.height / 2);
      await page.mouse.down({ button: "left" });
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(500);
      const currentExpanded = await item.getAttribute("aria-expanded").catch(() => null);
      if (currentExpanded === "true") return;
      await item.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(500);
      const expandedAfterKeyboard = await item.getAttribute("aria-expanded").catch(() => null);
      if (expandedAfterKeyboard === "true") return;
    }

    const finalExpanded = await item.getAttribute("aria-expanded").catch(() => null);
    throw new Error(`Tree item "${name}" did not expand. aria-expanded=${finalExpanded}`);
  },

  async doubleClickTreeItem(this: DriverContext, name: string): Promise<void> {
    const page = this.getPage();
    const item = page.getByRole("treeitem", { name }).locator("a").first();
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.scrollIntoViewIfNeeded();
    await item.dblclick();
    await page.waitForTimeout(500);
  },

  async isTreeItemVisible(this: DriverContext, name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("treeitem", { name }).isVisible();
  },

  async waitForTreeItem(this: DriverContext, name: string, timeoutMs = 15_000, exact = false, inView?: string): Promise<boolean> {
    const page = this.getPage();
    try {
      const scope = inView ? scopeForView(page, inView) : page;
      await scope.getByRole("treeitem", { name, exact }).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  },

  async waitForTreeItemGone(this: DriverContext, name: string, timeoutMs = 15_000, exact = false, inView?: string): Promise<boolean> {
    const page = this.getPage();
    try {
      const scope = inView ? scopeForView(page, inView) : page;
      await scope.getByRole("treeitem", { name, exact }).first().waitFor({
        state: "hidden",
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  },

  async clickTreeItemAction(this: DriverContext, itemName: string, actionLabel: string): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name: itemName, exact: true }).first();
    const target = await exactItem.count() > 0
      ? exactItem
      : page.getByRole("treeitem", { name: itemName }).first();
    await target.waitFor({ state: "visible", timeout: 15_000 });

    let lastActionInfo: unknown;
    for (let attempt = 0; attempt < 5; attempt++) {
      await target.evaluate((element) => {
        const row = element.closest<HTMLElement>(".monaco-list-row");
        row?.scrollIntoView({ block: "center", inline: "nearest" });
      });
      await page.waitForTimeout(300);

      const rowBox = await target.evaluate((element) => {
        const row = element.closest<HTMLElement>(".monaco-list-row");
        const rect = row?.getBoundingClientRect();
        return rect ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height } : undefined;
      });
      if (!rowBox) break;

      await page.mouse.move(rowBox.x + Math.min(rowBox.width / 2, 120), rowBox.y + rowBox.height / 2);
      await page.waitForTimeout(500);

      const actionInfo = await target.evaluate((element, label) => {
        const row = element.closest<HTMLElement>(".monaco-list-row");
        if (!row) return undefined;

        const actions = row.querySelector<HTMLElement>(".actions");
        const buttons = Array.from(row.querySelectorAll<HTMLElement>("a.action-label[role='button']"));
        const button = buttons.find(candidate => candidate.getAttribute("aria-label")?.includes(label))
          ?? buttons[buttons.length - 1];
        const actionItem = button?.closest<HTMLElement>("li.action-item");
        const actionItemRect = actionItem?.getBoundingClientRect();
        const buttonRect = button?.getBoundingClientRect();
        const rowRect = row.getBoundingClientRect();
        const actionsStyle = actions ? window.getComputedStyle(actions) : undefined;

        if (!button || !buttonRect || !actionItem || !actionItemRect) {
          return {
            needsScroll: false,
            row: rowRect.toJSON(),
            actionsDisplay: actionsStyle?.display,
            actionsVisibility: actionsStyle?.visibility,
            buttons: buttons.map(candidate => ({
              ariaLabel: candidate.getAttribute("aria-label"),
              title: candidate.getAttribute("title"),
              rect: candidate.getBoundingClientRect().toJSON()
            }))
          };
        }

        const viewportHeight = window.innerHeight;
        const desiredTop = Math.max(80, Math.min(viewportHeight - 140, viewportHeight / 2));
        const currentTop = buttonRect.top;
        const needsScroll = currentTop < 40 || buttonRect.bottom > viewportHeight - 20;

        if (needsScroll) {
          const scrollers = Array.from(document.querySelectorAll<HTMLElement>(".monaco-scrollable-element"))
            .filter(candidate => candidate.contains(row));
          const scroller = scrollers
            .find(candidate => candidate.scrollHeight > candidate.clientHeight)
            ?? scrollers[scrollers.length - 1];
          if (scroller) {
            scroller.scrollTop += currentTop - desiredTop;
          } else {
            row.scrollIntoView({ block: "center", inline: "nearest" });
          }
        }

        return {
          needsScroll,
          box: { x: actionItemRect.x, y: actionItemRect.y, width: actionItemRect.width, height: actionItemRect.height },
          buttonBox: { x: buttonRect.x, y: buttonRect.y, width: buttonRect.width, height: buttonRect.height },
          row: rowRect.toJSON(),
          actionsDisplay: actionsStyle?.display,
          actionsVisibility: actionsStyle?.visibility,
          viewport: { width: window.innerWidth, height: viewportHeight },
          buttons: buttons.map(candidate => ({
            ariaLabel: candidate.getAttribute("aria-label"),
            title: candidate.getAttribute("title"),
            rect: candidate.getBoundingClientRect().toJSON()
          }))
        };
      }, actionLabel);

      lastActionInfo = actionInfo;
      const box = actionInfo?.box;
      if (!box) break;
      if (actionInfo.needsScroll) {
        await page.waitForTimeout(400);
        continue;
      }

      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      await page.mouse.move(centerX, centerY);
      await page.waitForTimeout(200);
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(100);
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(500);
      return;
    }

    throw new Error(`Inline action "${actionLabel}" on tree item "${itemName}" was not clickable: ${JSON.stringify(lastActionInfo)}`);
  },

  async waitForEditorTab(this: DriverContext, title: string, timeoutMs = 15_000): Promise<boolean> {
    const page = this.getPage();
    try {
      await page.getByRole("tab", { name: title }).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  },

  async clickViewTitleAction(this: DriverContext, viewName: string, actionLabel: string): Promise<void> {
    const page = this.getPage();

    // Locate the pane whose header title matches viewName (case-insensitive,
    // tolerant of the workbench's UPPERCASE text-transform).
    const escapedView = viewName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pane = page.locator(".pane").filter({
      has: page.locator(`.pane-header .title:text-matches("^\\s*${escapedView}\\s*$", "i")`),
    }).first();
    await pane.waitFor({ state: "visible", timeout: 2 * DEFAULT_TIMEOUT });

    // Pane-header action buttons are usually only rendered when the header is
    // hovered or the pane is focused. Hover first to ensure they're in DOM.
    const header = pane.locator(".pane-header").first();
    await header.scrollIntoViewIfNeeded().catch(() => { /* best effort */ });
    await header.hover();
    await page.waitForTimeout(300);
    await this.subScreenshot?.(`view-title-${viewName}-hover`);

    // Try clicking a direct (navigation-group) action button first.
    // Use Playwright's role/name match instead of aria-label attribute interpolation
    // so a label containing quotes does not break the selector.
    const directAction = pane.locator(".pane-header").getByRole("button", {
      name: actionLabel,
      exact: true,
    }).first();
    if (await directAction.count() > 0) {
      try {
        await directAction.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        await this.subScreenshot?.(`view-title-${actionLabel}-clicked`);
        return;
      } catch {
        // Fall through to overflow-menu path.
      }
    }

    // Open the "Views and More Actions..." overflow menu.
    // The toolbar item is rendered with the codicon-toolbar-more icon class;
    // a single selector covers both the role="button" and bare anchor variants.
    const overflow = pane.locator(
      `.pane-header a.codicon-toolbar-more, ` +
      `.pane-header a.action-label[aria-label*="More Actions"]`,
    ).first();
    await overflow.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await overflow.click();
    await page.waitForTimeout(300);
    await this.subScreenshot?.(`view-title-${viewName}-overflow-open`);

    // Click the menu item by label.
    const menu = page.locator(".monaco-menu-container .monaco-menu, .context-view .monaco-menu").first();
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const menuItem = menu.getByRole("menuitem", { name: actionLabel }).first();
    await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    // Hover first so VS Code marks the item as focused before the click —
    // this matches how `contextMenuOnTreeItem` drives context menus and avoids
    // the "click without hover" race that can dismiss the menu without firing.
    await menuItem.hover();
    await page.locator(".monaco-menu-container .action-item.focused").waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT,
    }).catch(() => { /* best effort */ });
    await this.subScreenshot?.(`view-title-${actionLabel}-menuitem-focused`);
    await menuItem.click();
    await page.waitForTimeout(500);
    await this.subScreenshot?.(`view-title-${actionLabel}-clicked`);
  },

  async clickEditorTitleAction(this: DriverContext, actionLabel: string): Promise<void> {
    const page = this.getPage();

    // Editor title-bar actions live in the `.editor-actions` container of the
    // active editor group. Hover the title first so optional actions render.
    const activeGroup = page.locator(".editor-group-container.active").first();
    await activeGroup.waitFor({ state: "visible", timeout: 2 * DEFAULT_TIMEOUT });

    const titleArea = activeGroup.locator(".title").first();
    await titleArea.hover().catch(() => { /* best effort */ });
    await page.waitForTimeout(200);
    await this.subScreenshot?.(`editor-title-hover`);

    // 1) Direct navigation-group action button.
    const directAction = activeGroup.locator(".editor-actions").getByRole("button", {
      name: actionLabel,
      exact: true,
    }).first();
    if (await directAction.count() > 0) {
      try {
        await directAction.click({ timeout: 2000 });
        await page.waitForTimeout(500);
        await this.subScreenshot?.(`editor-title-${actionLabel}-clicked`);
        return;
      } catch {
        // Fall through to overflow menu.
      }
    }

    // 2) Overflow ("More Actions") menu.
    const overflow = activeGroup.locator(
      `.editor-actions a.codicon-toolbar-more, ` +
      `.editor-actions a.action-label[aria-label*="More Actions"]`,
    ).first();
    await overflow.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await overflow.click();
    await page.waitForTimeout(300);
    await this.subScreenshot?.(`editor-title-overflow-open`);

    const menu = page.locator(".monaco-menu-container .monaco-menu, .context-view .monaco-menu").first();
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const menuItem = menu.getByRole("menuitem", { name: actionLabel }).first();
    await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await menuItem.hover();
    await page.locator(".monaco-menu-container .action-item.focused").waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT,
    }).catch(() => { /* best effort */ });
    await this.subScreenshot?.(`editor-title-${actionLabel}-menuitem-focused`);
    await menuItem.click();
    await page.waitForTimeout(500);
    await this.subScreenshot?.(`editor-title-${actionLabel}-clicked`);
  },
};
