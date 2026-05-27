import type { Page } from "@playwright/test";
import { DEFAULT_TIMEOUT, KEYS, SELECTORS, getModifierKey } from "./_shared.js";

interface DriverContext {
  getPage(): Page;
  resolveWorkspacePlaceholders(value: unknown): unknown;
  assignKeybindingForCommand(commandId: string, args: unknown[]): Promise<string>;
  subScreenshot?(label: string): Promise<void>;
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

    // Guard against silent-pass: if no visible option's label-name contains the
    // requested label (case-insensitive), Enter would dismiss the palette
    // without running anything and the step would falsely "pass" in ~800ms.
    // Surface this as an error so a typo'd or renamed command is loud.
    const labelNames = page.locator(`${SELECTORS.QUICK_INPUT_WIDGET} .quick-input-list a.label-name`);
    try {
      await labelNames.first().waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    } catch {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`No palette match for "${label}"`);
    }
    const names = (await labelNames.allInnerTexts()).map(t => t.trim().toLowerCase());
    const wanted = label.trim().toLowerCase();
    if (!names.some(n => n.includes(wanted))) {
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(`No palette match for "${label}" (top entries: ${names.slice(0, 3).join(" | ") || "<none>"})`);
    }

    // No sub-screenshot here: this path confirms via Enter keypress, not a
    // mouse click. Sub-screenshots are reserved for actual click events.
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

    // Match the visible label-name text exactly (case-insensitive) to
    // disambiguate similarly-prefixed entries (e.g. "View: Close All Editors"
    // vs "View: Close All Editors in Group") and avoid clicking the gear
    // "Configure Keybinding" anchor on the option row.
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const option = page
      .locator(`${SELECTORS.QUICK_INPUT_WIDGET} .quick-input-list a.label-name`)
      .filter({ hasText: new RegExp(`^\\s*${escaped}\\s*$`, "i") })
      .first();
    try {
      await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    } catch {
      const visible = await page
        .locator(`${SELECTORS.QUICK_INPUT_WIDGET} .quick-input-list a.label-name`)
        .allInnerTexts()
        .catch(() => [] as string[]);
      await page.keyboard.press("Escape").catch(() => {});
      throw new Error(
        `No exact palette match for "${label}" (top entries: ${visible.slice(0, 3).map(t => t.trim()).join(" | ") || "<none>"})`
      );
    }
    await option.hover().catch(() => { /* best effort */ });
    await this.subScreenshot?.(`palette-${label}-pre-click`);
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
    // Focus the active terminal via VS Code's built-in command. This
    // bypasses DOM locator heuristics ("which `.terminal-wrapper .xterm`
    // is the right one?") entirely: VS Code's TerminalService knows
    // exactly which xterm instance is the active one and will focus
    // its input regardless of DOM order or CSS visibility state.
    //
    // Background: the previous implementation used
    //   page.locator(".terminal-wrapper .xterm, .terminal-wrapper").last()
    // and `.last()` would intermittently pick a CSS-hidden xterm wrapper
    // left over from extension-host bootstrap on headless GitHub Actions
    // Windows runners (canvas-renderer environments). Playwright's
    // `waitFor visible` would then time out and the key was never
    // delivered. Going through the VS Code command avoids the entire
    // class of "stale ghost xterm" flakes and works identically on all
    // three OSes.
    //
    // The keybinding-driven `executeVSCodeCommand` is used instead of
    // the command palette so this helper does not pollute the palette
    // history or risk dismissing an unrelated quick-input the caller
    // might have open.
    const keybinding = await this.assignKeybindingForCommand("workbench.action.terminal.focus", []);
    await page.keyboard.press(keybinding);
    await page.waitForTimeout(200);
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
    // VS Code's "Go to Line/Column..." (workbench.action.gotoLine) is bound to
    // `Ctrl+G` on Windows, Linux AND macOS — unlike most VS Code shortcuts,
    // it is NOT remapped to `Cmd+G` on macOS because `Cmd+G` is the standard
    // macOS "Find Next" binding (editor.action.nextMatchFindAction). Using
    // `${getModifierKey()}+G` would press `Cmd+G` on darwin and silently
    // trigger find-next instead of opening the Go-to-Line quick input,
    // making this helper a no-op on macOS CI runners.
    await page.keyboard.press("Control+G");
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

  /**
   * Run an arbitrary VS Code command by id, including commands hidden from the
   * palette (`"when": false` in `commandPalette` menu).
   *
   * **Multi-arg semantics:** `keybindings.json` only accepts a single `args` value,
   * so this implementation packs the call as follows:
   *   - 0 args  → omit `args`
   *   - 1 arg   → pass the single value as-is
   *   - >1 args → pack them into an array and pass that array as `args`
   *
   * Commands that natively take multiple positional arguments are uncommon; if
   * you need to call one, prefer wrapping it in an extension command that
   * accepts a single options object.
   */
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
