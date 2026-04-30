import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";

const DEFAULT_TIMEOUT = 5000;

interface DriverContext {
  getPage(): Page;
  screenshot(outputPath?: string): Promise<Buffer>;
  getNotifications(): Promise<string[]>;
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
  waitForTreeItem(name: string, timeoutMs?: number, exact?: boolean): Promise<boolean>;
  waitForTreeItemGone(name: string, timeoutMs?: number, exact?: boolean): Promise<boolean>;
  clickTreeItemAction(itemName: string, actionLabel: string): Promise<void>;
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

  async waitForTreeItem(this: DriverContext, name: string, timeoutMs = 15_000, exact = false): Promise<boolean> {
    const page = this.getPage();
    try {
      await page.getByRole("treeitem", { name, exact }).first().waitFor({
        state: "visible",
        timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  },

  async waitForTreeItemGone(this: DriverContext, name: string, timeoutMs = 15_000, exact = false): Promise<boolean> {
    const page = this.getPage();
    try {
      await page.getByRole("treeitem", { name, exact }).first().waitFor({
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
    const target = page.getByRole("treeitem", { name: itemName, exact: true }).first();
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

      const debugScreenshot = path.join(process.cwd(), "test-results", "maven-lifecycle-inline-action", "screenshots", `${itemName}-${actionLabel}-hover-before-click.png`);
      fs.mkdirSync(path.dirname(debugScreenshot), { recursive: true });
      await this.screenshot(debugScreenshot);

      const centerX = box.x + box.width / 2;
      const centerY = box.y + box.height / 2;
      const hitTarget = await page.evaluate(({ x, y }) => {
        const element = document.elementFromPoint(x, y);
        const actionItem = element?.closest("li.action-item");
        return {
          tagName: element?.tagName,
          className: element?.getAttribute("class"),
          ariaLabel: element?.getAttribute("aria-label"),
          title: element?.getAttribute("title"),
          text: element?.textContent?.trim(),
          actionItemClassName: actionItem?.getAttribute("class")
        };
      }, { x: centerX, y: centerY });
      await target.evaluate((element, label) => {
        const row = element.closest<HTMLElement>(".monaco-list-row");
        const button = Array.from(row?.querySelectorAll<HTMLElement>("a.action-label[role='button']") ?? [])
          .find(candidate => candidate.getAttribute("aria-label")?.includes(label));
        const actionItem = button?.closest<HTMLElement>("li.action-item");
        const events: unknown[] = [];
        (window as unknown as { __treeActionEvents?: unknown[] }).__treeActionEvents = events;
        for (const eventType of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
          actionItem?.addEventListener(eventType, event => {
            const mouseEvent = event as MouseEvent;
            events.push({
              source: "actionItem",
              type: eventType,
              isTrusted: event.isTrusted,
              target: (event.target as HTMLElement | null)?.tagName,
              targetClass: (event.target as HTMLElement | null)?.getAttribute("class"),
              currentTargetClass: (event.currentTarget as HTMLElement | null)?.getAttribute("class"),
              button: mouseEvent.button,
              defaultPrevented: event.defaultPrevented,
            });
          }, true);
          actionItem?.addEventListener(eventType, event => {
            const mouseEvent = event as MouseEvent;
            events.push({
              source: "actionItemAfter",
              type: eventType,
              isTrusted: event.isTrusted,
              target: (event.target as HTMLElement | null)?.tagName,
              targetClass: (event.target as HTMLElement | null)?.getAttribute("class"),
              currentTargetClass: (event.currentTarget as HTMLElement | null)?.getAttribute("class"),
              button: mouseEvent.button,
              defaultPrevented: event.defaultPrevented,
            });
          });
          button?.addEventListener(eventType, event => {
            const mouseEvent = event as MouseEvent;
            events.push({
              source: "actionLabel",
              type: eventType,
              isTrusted: event.isTrusted,
              target: (event.target as HTMLElement | null)?.tagName,
              targetClass: (event.target as HTMLElement | null)?.getAttribute("class"),
              button: mouseEvent.button,
              defaultPrevented: event.defaultPrevented,
            });
          }, true);
          button?.addEventListener(eventType, event => {
            const mouseEvent = event as MouseEvent;
            events.push({
              source: "actionLabelAfter",
              type: eventType,
              isTrusted: event.isTrusted,
              target: (event.target as HTMLElement | null)?.tagName,
              targetClass: (event.target as HTMLElement | null)?.getAttribute("class"),
              button: mouseEvent.button,
              defaultPrevented: event.defaultPrevented,
            });
          });
        }
      }, actionLabel);
      console.log(`   🔘 Tree item "${itemName}" action target: ${JSON.stringify({ actionInfo, hitTarget, debugScreenshot })}`);
      await page.mouse.move(centerX, centerY);
      await page.waitForTimeout(200);
      await page.mouse.down({ button: "left" });
      await page.waitForTimeout(100);
      await page.mouse.up({ button: "left" });
      await page.waitForTimeout(500);
      const clickEvents = await page.evaluate(() => (window as unknown as { __treeActionEvents?: unknown[] }).__treeActionEvents ?? []);
      const notifications = await this.getNotifications();
      console.log(`   🖱️ Tree item "${itemName}" click events: ${JSON.stringify(clickEvents)}`);
      console.log(`   🔔 Notifications after "${itemName}" action: ${JSON.stringify(notifications)}`);
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
};
