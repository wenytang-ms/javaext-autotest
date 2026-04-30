import type { Page } from "@playwright/test";

const DEFAULT_TIMEOUT = 5000;
const COMMAND_PALETTE_KEY = "F1";
const ENTER_KEY = "Enter";
const QUICK_INPUT_SELECTOR = ".quick-input-box input";
const QUICK_INPUT_WIDGET_SELECTOR = ".quick-input-widget";

interface DriverContext {
  getPage(): Page;
  resolveWorkspacePlaceholders(value: unknown): unknown;
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
}

export const commandOperations: CommandOperations = {
  async runCommandFromPalette(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(COMMAND_PALETTE_KEY);

    const palette = page.locator(QUICK_INPUT_SELECTOR);
    await palette.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await palette.fill(`>${label}`);
    await page.waitForTimeout(300);

    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  },

  async selectAndRunCommand(this: DriverContext, label: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(COMMAND_PALETTE_KEY);

    const palette = page.locator(QUICK_INPUT_SELECTOR);
    await palette.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await palette.fill(`>${label}`);
    await page.waitForTimeout(500);

    const option = page.getByRole("option", { name: label }).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
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
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await page.keyboard.press(`${modifier}+P`);

      const input = page.locator(QUICK_INPUT_SELECTOR);
      await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await input.fill(filePath);
      await page.waitForTimeout(500);

      const hasResults = await page.locator(".quick-input-list .monaco-list-row").count() > 0;
      if (hasResults) {
        await page.keyboard.press(ENTER_KEY);
        await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      await page.keyboard.press("Escape");
      await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});

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
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+S`);
    await page.waitForTimeout(500);
  },

  async goToLine(this: DriverContext, line: number): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+G`);
    const input = page.locator(QUICK_INPUT_SELECTOR);
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(`:${line}`);
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
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
    await this.getPage().evaluate(
      async ({ id, commandArgs }) => {
        const driver = (window as any).driver;
        if (!driver?.executeCommand) {
          throw new Error("VS Code smoke test driver executeCommand API is not available.");
        }
        await driver.executeCommand(id, ...commandArgs);
      },
      { id: commandId, commandArgs: resolvedArgs }
    );
    await this.getPage().waitForTimeout(500);
  },

  async runInTerminal(this: DriverContext, command: string): Promise<void> {
    await commandOperations.runCommandFromPalette.call(this, "Terminal: Create New Terminal");
    const page = this.getPage();
    await page.locator(".terminal-wrapper").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.keyboard.type(command);
    await page.keyboard.press(ENTER_KEY);
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
};
