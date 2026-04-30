import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;
const ENTER_KEY = "Enter";
const TRIGGER_SUGGEST_KEY = "Control+Space";
const NEXT_MARKER_COMMAND = "Go to Next Problem (Error, Warning, Info)";
const QUICK_INPUT_SELECTOR = ".quick-input-box input";
const QUICK_INPUT_WIDGET_SELECTOR = ".quick-input-widget";
const SUGGEST_WIDGET_SELECTOR = ".editor-widget.suggest-widget";

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette(label: string): Promise<void>;
  goToLine(line: number): Promise<void>;
  goToEndOfLine(): Promise<void>;
  selectAllInEditor(): Promise<void>;
  triggerCompletion(): Promise<string[]>;
  readCompletionItems(): Promise<string[]>;
}

export interface JavaOperations {
  typeInEditor(text: string): Promise<void>;
  selectAllInEditor(): Promise<void>;
  setEditorContent(content: string): Promise<void>;
  typeAndTriggerSnippet(triggerWord: string): Promise<void>;
  waitForLanguageServer(timeoutMs?: number): Promise<boolean>;
  getProblemsCount(): Promise<{ errors: number; warnings: number }>;
  navigateToNextError(): Promise<void>;
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
}

export const javaOperations: JavaOperations = {
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

  async selectAllInEditor(this: DriverContext): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`);
  },

  async setEditorContent(this: DriverContext, content: string): Promise<void> {
    await this.selectAllInEditor();
    const page = this.getPage();
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
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.press("Delete");
        await page.waitForTimeout(500);
        console.log(`   ⏳ Snippet retry ${attempt + 1}/3...`);
      }

      await page.keyboard.type(triggerWord, { delay: 50 });
      await page.waitForTimeout(300);
      await page.keyboard.press(TRIGGER_SUGGEST_KEY);
      const suggestVisible = await page.locator(SUGGEST_WIDGET_SELECTOR)
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true).catch(() => false);

      if (!suggestVisible) continue;
      await page.waitForTimeout(500);

      const snippetOption = page.locator(".monaco-list-row .suggest-icon.codicon-symbol-snippet").first();
      const hasSnippet = await snippetOption.isVisible().catch(() => false);

      if (hasSnippet) {
        await snippetOption.click();
        await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      await page.keyboard.press("Escape");
      await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }

    console.log("   ⏳ Snippet not found in suggest, using Insert Snippet command...");
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`);
    await page.keyboard.press("Delete");
    await this.runCommandFromPalette("Snippets: Insert Snippet");
    const snippetPicker = page.locator(QUICK_INPUT_SELECTOR);
    await snippetPicker.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await snippetPicker.fill(triggerWord);
    await page.waitForTimeout(500);
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async waitForLanguageServer(this: DriverContext, timeoutMs = 120_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();
    const pollInterval = 2000;

    console.log(`   ⏳ Waiting for Language Server (timeout: ${timeoutMs / 1000}s)...`);

    let lastStatus = "";
    while (Date.now() - start < timeoutMs) {
      const statusItems = page.locator("footer a, footer [role='button']");
      const count = await statusItems.count();
      let currentStatus = "";

      for (let i = 0; i < count; i++) {
        const text = (await statusItems.nth(i).textContent().catch(() => ""))?.trim() ?? "";
        if (/^Java:/.test(text) || /^☕/.test(text)) {
          currentStatus = text;
          break;
        }
      }

      if (currentStatus && currentStatus !== lastStatus) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`   ⏳ ${elapsed}s — "${currentStatus}"`);
        lastStatus = currentStatus;
      }

      if (/Java:\s*Ready/i.test(currentStatus) || currentStatus.includes("👍")) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`   ✅ Language Server ready (${elapsed}s)`);
        return true;
      }

      await page.waitForTimeout(pollInterval);
    }

    console.log(`   ⚠️ Language Server not ready after ${timeoutMs / 1000}s (last: "${lastStatus}")`);
    return false;
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

  async navigateToNextError(this: DriverContext): Promise<void> {
    await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
  },

  async navigateToError(this: DriverContext, index: number): Promise<void> {
    const page = this.getPage();
    await this.runCommandFromPalette("View: Focus Problems (Errors, Warnings, Infos)");
    await page.waitForTimeout(500);

    const errorRows = page.locator(".markers-panel .monaco-list-row .codicon-error");
    const count = await errorRows.count();

    if (count >= index) {
      const targetRow = errorRows.nth(index - 1).locator("..").locator("..");
      await targetRow.click();
      await page.waitForTimeout(500);
      await targetRow.dblclick();
      await page.waitForTimeout(1000);
    } else {
      for (let i = 0; i < index; i++) {
        await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
      }
    }
  },

  async applyCodeAction(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

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

    await page.keyboard.press("Escape");
    const available = result.labels.length > 0 ? result.labels.join(", ") : "none";
    throw new Error(`Code action "${label}" not found. Available actions: ${available}`);
  },

  async findText(this: DriverContext, text: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+F`);
    const findInput = page.locator(".find-part .input");
    await findInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await findInput.fill(text);
    await page.waitForTimeout(500);
    await page.keyboard.press("Escape");
    await page.locator(".find-part").waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(300);
  },

  async renameSymbol(this: DriverContext, newName: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("F2");
    const renameInput = page.locator(".rename-box .rename-input");
    await renameInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await renameInput.fill(newName);
    await page.waitForTimeout(300);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  },

  async organizeImports(this: DriverContext): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Shift+Alt+O");
    await page.waitForTimeout(1000);
    const quickPick = page.locator(QUICK_INPUT_WIDGET_SELECTOR);
    const hasQuickPick = await quickPick.isVisible().catch(() => false);
    if (hasQuickPick) {
      await page.keyboard.press(ENTER_KEY);
      await quickPick.waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }
  },

  async triggerCompletion(this: DriverContext): Promise<string[]> {
    const page = this.getPage();
    await page.keyboard.press(TRIGGER_SUGGEST_KEY);
    await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT }).catch(() => {});
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
    return this.getPage().locator(SUGGEST_WIDGET_SELECTOR).isVisible().catch(() => false);
  },

  async readCompletionItems(this: DriverContext): Promise<string[]> {
    const page = this.getPage();
    return await page.locator(SUGGEST_WIDGET_SELECTOR)
      .locator(".monaco-list-row .label-name")
      .allTextContents().catch(() => [] as string[]);
  },

  async dismissCompletion(this: DriverContext): Promise<void> {
    await this.getPage().keyboard.press("Escape");
    await this.getPage().locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },
};
