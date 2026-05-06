import type { Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS, SELECTORS, dismissWidget, getModifierKey } from "./_shared.js";

/**
 * Maximum time to wait for at least the requested number of errors to be
 * published by the language server. Diagnostics are emitted asynchronously
 * after edits, so an error inserted just before `navigateToError` may not
 * be visible immediately.
 */
const NAVIGATE_TO_ERROR_TIMEOUT_MS = 30_000;

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette(label: string): Promise<void>;
  goToLine(line: number): Promise<void>;
  goToEndOfLine(): Promise<void>;
  triggerCompletion(): Promise<string[]>;
  readCompletionItems(): Promise<string[]>;
}

export interface EditorOperations {
  typeInEditor(text: string): Promise<void>;
  setEditorContent(content: string): Promise<void>;
  typeAndTriggerSnippet(triggerWord: string): Promise<void>;
  getProblemsCount(): Promise<{ errors: number; warnings: number }>;
  navigateToError(index: number): Promise<void>;
  applyCodeAction(label: string): Promise<void>;
  findText(text: string): Promise<void>;
  renameSymbol(newName: string): Promise<void>;
  organizeImports(): Promise<void>;
  triggerCompletion(): Promise<string[]>;
  triggerCompletionAt(position: string): Promise<string[]>;
  isCompletionVisible(): Promise<boolean>;
  readCompletionItems(): Promise<string[]>;
  dismissCompletion(): Promise<void>;
  contextMenuOnEditorTab(tabName: string, menuLabel: string): Promise<void>;
}

export const editorOperations: EditorOperations = {
  async typeInEditor(this: DriverContext, text: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Escape");

    const driverSuccess = await page.evaluate(async (t) => {
      const driver = (window as any).driver;
      if (!driver?.typeInEditor) return false;
      const editContext = document.querySelector(".monaco-editor .native-edit-context");
      const textarea = document.querySelector(".monaco-editor textarea");
      const selector = editContext
        ? ".monaco-editor .native-edit-context"
        : textarea
          ? ".monaco-editor textarea"
          : null;
      if (!selector) return false;
      await driver.typeInEditor(selector, t);
      return true;
    }, text);

    if (!driverSuccess) {
      const editSuccess = await page.evaluate((t) => {
        const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
        if (!editor) return false;
        const selection = editor.getSelection();
        if (!selection) return false;
        const Range = (window as any).monaco.Range;
        editor.executeEdits("autotest", [{
          range: new Range(
            selection.startLineNumber, selection.startColumn,
            selection.endLineNumber, selection.endColumn
          ),
          text: t,
          forceMoveMarkers: true,
        }]);
        return true;
      }, text);

      if (!editSuccess) {
        await page.keyboard.insertText(text);
      }
    }
    await page.waitForTimeout(300);
    await page.keyboard.press("Escape");
  },

  async setEditorContent(this: DriverContext, content: string): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.press("Delete");
    await page.keyboard.type(content, { delay: 10 });
  },

  async typeAndTriggerSnippet(this: DriverContext, triggerWord: string): Promise<void> {
    const page = this.getPage();
    const editor = page.locator(".monaco-editor .view-lines").first();
    await editor.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await editor.click();

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        const modifier = getModifierKey();
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.press("Delete");
        await page.waitForTimeout(500);
        console.log(`   ⏳ Snippet retry ${attempt + 1}/3...`);
      }

      await page.keyboard.type(triggerWord, { delay: 50 });
      await page.waitForTimeout(300);
      await page.keyboard.press(KEYS.TRIGGER_SUGGEST);
      const suggestVisible = await page.locator(SELECTORS.SUGGEST_WIDGET)
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true).catch(() => false);

      if (!suggestVisible) continue;
      await page.waitForTimeout(500);

      const snippetOption = page.locator(`${SELECTORS.MONACO_LIST_ROW} .suggest-icon.codicon-symbol-snippet`).first();
      const hasSnippet = await snippetOption.isVisible().catch(() => false);

      if (hasSnippet) {
        await snippetOption.click();
        await page.locator(SELECTORS.SUGGEST_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      await dismissWidget(page, SELECTORS.SUGGEST_WIDGET);
    }

    console.log("   ⏳ Snippet not found in suggest, using Insert Snippet command...");
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.press("Delete");
    await this.runCommandFromPalette("Snippets: Insert Snippet");
    const snippetPicker = page.locator(SELECTORS.QUICK_INPUT);
    await snippetPicker.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await snippetPicker.fill(triggerWord);
    await page.waitForTimeout(500);
    await page.keyboard.press(KEYS.ENTER);
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async getProblemsCount(this: DriverContext): Promise<{ errors: number; warnings: number }> {
    const page = this.getPage();
    const result = await page.evaluate(() => {
      const footer = document.querySelector("footer");
      if (!footer) return null;

      for (const link of footer.querySelectorAll("a")) {
        const hasErrorIcon = link.querySelector("[class*='codicon-error']");
        const hasWarningIcon = link.querySelector("[class*='codicon-warning']");

        if (hasErrorIcon || hasWarningIcon) {
          const text = link.textContent ?? "";
          const numbers = text.match(/\d+/g);
          if (numbers && numbers.length >= 2) {
            return {
              errors: parseInt(numbers[0], 10),
              warnings: parseInt(numbers[1], 10),
            };
          }
          if (numbers && numbers.length === 1) {
            return {
              errors: hasErrorIcon ? parseInt(numbers[0], 10) : 0,
              warnings: hasWarningIcon ? parseInt(numbers[0], 10) : 0,
            };
          }
        }

        const label = link.getAttribute("aria-label") ?? "";
        if (/no problems/i.test(label)) {
          return { errors: 0, warnings: 0 };
        }
      }
      return null;
    });

    return result ?? { errors: -1, warnings: -1 };
  },

  async navigateToError(this: DriverContext, index: number): Promise<void> {
    const page = this.getPage();
    await this.runCommandFromPalette("View: Focus Problems (Errors, Warnings, Infos)");
    await page.waitForTimeout(500);

    // Poll the Problems panel for at least `index` errors. Diagnostics are
    // published asynchronously by the language server, so we cannot assume
    // they are visible immediately after edits. Falling back to the generic
    // "Go to Next Problem" command would silently navigate to warnings,
    // hiding the timing issue and producing confusing downstream failures.
    const errorRows = page.locator(`.markers-panel ${SELECTORS.MONACO_LIST_ROW} .codicon-error`);
    const deadline = Date.now() + NAVIGATE_TO_ERROR_TIMEOUT_MS;
    let count = await errorRows.count();
    while (count < index && Date.now() < deadline) {
      await page.waitForTimeout(1000);
      count = await errorRows.count();
    }

    if (count < index) {
      throw new Error(
        `navigateToError: only ${count} error(s) appeared in the Problems panel ` +
        `after ${NAVIGATE_TO_ERROR_TIMEOUT_MS / 1000}s, expected at least ${index}. ` +
        `The language server may not have published diagnostics yet — consider ` +
        `adding a longer waitBefore or an explicit waitForLanguageServer step.`
      );
    }

    const targetRow = errorRows.nth(index - 1).locator("..").locator("..");
    await targetRow.click();
    await page.waitForTimeout(500);
    await targetRow.dblclick();
    await page.waitForTimeout(1000);
  },

  async applyCodeAction(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();

    await page.keyboard.press(`${modifier}+1`);
    await page.waitForTimeout(500);

    const lightbulb = page.locator(".lightBulbWidget .codicon");
    if (await lightbulb.isVisible().catch(() => false)) {
      await lightbulb.click();
    } else {
      await page.keyboard.press(`${modifier}+.`);
    }

    const widget = page.locator(".action-widget").first();
    await widget.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);

    const result = await page.evaluate((lbl) => {
      const labels: string[] = [];
      const widgets = document.querySelectorAll(".action-widget");
      for (const w of widgets) {
        const items = w.querySelectorAll("li, [role='option'], .focused-item, .action-item");
        for (const item of items) {
          const text = item.textContent ?? "";
          if (text.trim()) labels.push(text.trim());
          if (text.includes(lbl)) {
            (item as HTMLElement).click();
            return { found: true, labels };
          }
        }
      }
      return { found: false, labels };
    }, label);

    if (result.found) {
      await page.waitForTimeout(1000);
      return;
    }

    await page.keyboard.press(KEYS.ESCAPE);
    const available = result.labels.length > 0 ? result.labels.join(", ") : "none";
    throw new Error(`Code action "${label}" not found. Available actions: ${available}`);
  },

  async findText(this: DriverContext, text: string): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+F`);
    const findInput = page.locator(".find-part .input");
    await findInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await findInput.fill(text);
    await page.waitForTimeout(500);
    await dismissWidget(page, ".find-part");
    await page.waitForTimeout(300);
  },

  async renameSymbol(this: DriverContext, newName: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("F2");
    const renameInput = page.locator(".rename-box .rename-input");
    await renameInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await renameInput.fill(newName);
    await page.waitForTimeout(300);
    await page.keyboard.press(KEYS.ENTER);
    await page.waitForTimeout(1000);
  },

  async organizeImports(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Shift+Alt+O");
    await page.waitForTimeout(1000);
    const quickPick = page.locator(SELECTORS.QUICK_INPUT_WIDGET);
    const hasQuickPick = await quickPick.isVisible().catch(() => false);
    if (hasQuickPick) {
      await page.keyboard.press(KEYS.ENTER);
      await quickPick.waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }
  },

  async triggerCompletion(this: DriverContext): Promise<string[]> {
    const page = this.getPage();
    await page.keyboard.press(KEYS.TRIGGER_SUGGEST);
    await page.locator(SELECTORS.SUGGEST_WIDGET).waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    return this.readCompletionItems();
  },

  async triggerCompletionAt(this: DriverContext, position: string): Promise<string[]> {
    const page = this.getPage();
    const normalized = position.trim();

    if (/^endOfLine$/i.test(normalized)) {
      await this.goToEndOfLine();
      return this.triggerCompletion();
    }

    const explicit = normalized.match(/^line\s+(\d+)(?:\s+column\s+(\d+))?$/i);
    if (explicit) {
      const lineNumber = parseInt(explicit[1], 10);
      const column = explicit[2] ? parseInt(explicit[2], 10) : undefined;
      if (column === undefined) {
        await this.goToLine(lineNumber);
      } else {
        await page.evaluate(({ line, col }) => {
          const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
          const model = editor?.getModel?.();
          if (!editor || !model) return false;
          const maxLine = model.getLineCount();
          const targetLine = Math.max(1, Math.min(line, maxLine));
          const maxColumn = model.getLineMaxColumn(targetLine);
          editor.setPosition({
            lineNumber: targetLine,
            column: Math.max(1, Math.min(col, maxColumn)),
          });
          editor.focus();
          return true;
        }, { line: lineNumber, col: column });
      }
      return this.triggerCompletion();
    }

    if (/^endOfMethod$/i.test(normalized)) {
      const moved = await page.evaluate(() => {
        const editor = (window as any).monaco?.editor?.getEditors?.()?.[0];
        const model = editor?.getModel?.();
        if (!editor || !model) return false;

        const currentLine = editor.getPosition?.()?.lineNumber ?? 1;
        const lineCount = model.getLineCount();
        for (let line = currentLine; line <= lineCount; line++) {
          const text = model.getLineContent(line);
          if (/^\s*}/.test(text) && line > 1) {
            const targetLine = line - 1;
            editor.setPosition({
              lineNumber: targetLine,
              column: model.getLineMaxColumn(targetLine),
            });
            editor.focus();
            return true;
          }
        }
        return false;
      });
      if (!moved) {
        await this.goToEndOfLine();
      }
      return this.triggerCompletion();
    }

    throw new Error(
      `Unsupported completion position "${position}". Supported: endOfLine, endOfMethod, line <n> [column <m>]`
    );
  },

  async isCompletionVisible(this: DriverContext): Promise<boolean> {
    return this.getPage().locator(SELECTORS.SUGGEST_WIDGET).isVisible().catch(() => false);
  },

  async readCompletionItems(this: DriverContext): Promise<string[]> {
    const page = this.getPage();
    return await page.locator(SELECTORS.SUGGEST_WIDGET)
      .locator(`${SELECTORS.MONACO_LIST_ROW} .label-name`)
      .allTextContents().catch(() => [] as string[]);
  },

  async dismissCompletion(this: DriverContext): Promise<void> {
    await dismissWidget(this.getPage(), SELECTORS.SUGGEST_WIDGET);
  },

  async contextMenuOnEditorTab(this: DriverContext, tabName: string, menuLabel: string): Promise<void> {
    const page = this.getPage();
    const tab = page.getByRole("tab", { name: tabName }).first();
    await tab.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await tab.scrollIntoViewIfNeeded().catch(() => { /* best effort */ });
    // Right-click on the tab to open the editor/title/context menu.
    await tab.click({ button: "right" });

    const menu = page.locator(".monaco-menu-container .monaco-menu, .context-view .monaco-menu").first();
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const menuItem = menu.getByRole("menuitem", { name: menuLabel }).first();
    await menuItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    // Hover first so VS Code marks the item as focused before the click —
    // avoids a "click without prior focus" race that can dismiss the menu
    // without firing the action.
    await menuItem.hover();
    await page.locator(".monaco-menu-container .action-item.focused").waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT,
    }).catch(() => { /* best effort */ });
    await menuItem.click();
    await page.waitForTimeout(500);
  },
};
