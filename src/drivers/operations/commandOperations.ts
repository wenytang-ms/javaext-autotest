import type { Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS, SELECTORS, getModifierKey } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  resolveWorkspacePlaceholders(value: unknown): unknown;
  assignKeybindingForCommand(commandId: string, args: unknown[]): Promise<string>;
}

export interface CommandOperations {
  runCommandFromPalette(label: string): Promise<void>;
  selectAndRunCommand(label: string): Promise<void>;
  pressKey(key: string): Promise<void>;
  pressTerminalKey(key: string): Promise<void>;
  openFile(filePath: string): Promise<void>;
  getEditorContent(): Promise<string>;
  editorContains(text: string): Promise<boolean>;
  saveFile(): Promise<void>;
  goToLine(line: number): Promise<void>;
  goToEndOfLine(): Promise<void>;
  pressKeys(keys: string): Promise<void>;
  executeVSCodeCommand(commandId: string, ...args: unknown[]): Promise<void>;
  runInTerminal(command: string): Promise<void>;
  getTerminalText(): Promise<string>;
  wait(seconds: number): Promise<void>;
}

export const commandOperations: CommandOperations = {
  async runCommandFromPalette(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(KEYS.COMMAND_PALETTE);

    const palette = page.locator(SELECTORS.QUICK_INPUT);
    await palette.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await palette.fill(`>${label}`);
    await page.waitForTimeout(300);

    await page.keyboard.press(KEYS.ENTER);
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async selectAndRunCommand(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(KEYS.COMMAND_PALETTE);

    const palette = page.locator(SELECTORS.QUICK_INPUT);
    await palette.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await palette.fill(`>${label}`);
    await page.waitForTimeout(500);

    const option = page.getByRole("option", { name: label }).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async pressKey(this: DriverContext, key: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
  },

  async pressTerminalKey(this: DriverContext, key: string): Promise<void> {
    const page = this.getPage();
    const terminal = page.locator(".terminal-wrapper .xterm, .terminal-wrapper").last();
    await terminal.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await terminal.click({ force: true });
    await page.keyboard.press(key);
    await page.waitForTimeout(300);
  },

  async openFile(this: DriverContext, filePath: string): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await page.keyboard.press(`${modifier}+P`);

      const input = page.locator(SELECTORS.QUICK_INPUT);
      await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await input.fill(filePath);
      await page.waitForTimeout(500);

      const hasResults = await page.locator(`.quick-input-list ${SELECTORS.MONACO_LIST_ROW}`).count() > 0;
      if (hasResults) {
        await page.keyboard.press(KEYS.ENTER);
        await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      await page.keyboard.press(KEYS.ESCAPE);
      await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});

      if (attempt < maxAttempts - 1) {
        console.log(`   ⏳ Quick Open: no results for "${filePath}", retrying (${attempt + 1}/${maxAttempts})...`);
        await page.waitForTimeout(3000);
      }
    }

    throw new Error(`File not found in Quick Open after ${maxAttempts} attempts: ${filePath}`);
  },

  async getEditorContent(this: DriverContext): Promise<string> {
    const page = this.getPage();
    const modelContent = await page.evaluate(() => {
      const model = (window as any).monaco?.editor?.getModels?.()?.[0];
      return model?.getValue?.() ?? null;
    });
    if (modelContent) return modelContent;

    return await page.locator(".monaco-editor .view-lines").first().innerText().catch(() => "");
  },

  async editorContains(this: DriverContext, text: string): Promise<boolean> {
    const content = await commandOperations.getEditorContent.call(this);
    if (content.includes(text)) return true;

    const page = this.getPage();
    return await page.locator(".monaco-editor").getByText(text, { exact: false }).first()
      .isVisible().catch(() => false);
  },

  async saveFile(this: DriverContext): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+S`);
    await page.waitForTimeout(500);
  },

  async goToLine(this: DriverContext, line: number): Promise<void> {
    const page = this.getPage();
    const modifier = getModifierKey();
    await page.keyboard.press(`${modifier}+G`);
    const input = page.locator(SELECTORS.QUICK_INPUT);
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(`:${line}`);
    await page.keyboard.press(KEYS.ENTER);
    await page.locator(SELECTORS.QUICK_INPUT_WIDGET).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async goToEndOfLine(this: DriverContext): Promise<void> {
    await this.getPage().keyboard.press("End");
  },

  async pressKeys(this: DriverContext, keys: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(keys);
    await page.waitForTimeout(300);
  },

  async executeVSCodeCommand(this: DriverContext, commandId: string, ...args: unknown[]): Promise<void> {
    const resolvedArgs = args.map(arg => this.resolveWorkspacePlaceholders(arg));
    // VS Code's smoke-test driver does NOT expose `executeCommand` on `window.driver`
    // (only typeInEditor, getElements, getTerminalBuffer and a handful of others —
    // see src/vs/workbench/services/driver/browser/driver.ts upstream). To run a
    // command by id — including palette-hidden commands ("when": false in the
    // package.json `commandPalette` menu) — we register the command as a user
    // keybinding and dispatch the binding via Playwright. Bindings persist in
    // ${userDataDir}/User/keybindings.json for the session and are pooled, so
    // repeated calls to the same (commandId, args) reuse the same key.
    const playwrightKey = await this.assignKeybindingForCommand(commandId, resolvedArgs);
    const page = this.getPage();
    await page.keyboard.press(playwrightKey);
    await page.waitForTimeout(500);
  },

  async runInTerminal(this: DriverContext, command: string): Promise<void> {
    await commandOperations.runCommandFromPalette.call(this, "Terminal: Create New Terminal");
    const page = this.getPage();
    await page.locator(".terminal-wrapper").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.keyboard.type(command);
    await page.keyboard.press(KEYS.ENTER);
    await page.waitForTimeout(1000);
  },

  async getTerminalText(this: DriverContext): Promise<string> {
    const page = this.getPage();
    const panel = page.locator(".part.panel").first();
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+j");
      await page.waitForTimeout(300);
    }

    const texts = await page.locator(".terminal-wrapper .xterm-rows, .xterm .xterm-rows").evaluateAll(elements =>
      elements.map(element => element.textContent ?? "")
    ).catch(() => []);
    const buffers = await page.evaluate(async () => {
      const driver = (window as unknown as { driver?: { getTerminalBuffer?: (selector: string) => Promise<string[]> } }).driver;
      const terminals = Array.from(document.querySelectorAll(".terminal-wrapper .xterm, .xterm"));
      const output: string[] = [];
      for (let index = 0; index < terminals.length; index++) {
        const selector = `.terminal-wrapper .xterm:nth-of-type(${index + 1}), .xterm:nth-of-type(${index + 1})`;
        try {
          if (driver?.getTerminalBuffer) {
            output.push((await driver.getTerminalBuffer(selector)).join("\n"));
          }
        } catch {
          // Fall back to DOM text below.
        }
      }
      return output;
    }).catch(() => []);
    const raw = [...texts, ...buffers].join("\n--- terminal ---\n");
    return raw.replace(/\u00A0/g, " ");
  },

  async wait(this: DriverContext, seconds: number): Promise<void> {
    await this.getPage().waitForTimeout(seconds * 1000);
  },
};
