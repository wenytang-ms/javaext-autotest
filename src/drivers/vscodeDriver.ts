/**
 * VscodeDriver — Core driver for launching and controlling VSCode via Playwright.
 *
 * Provides stable operation primitives categorized by reliability:
 * - Level 1 (🟢): Command-based — uses VSCode command system, extremely stable
 * - Level 2 (🟡): Role-based — uses Accessibility roles, stable across versions
 * - Level 3 (🟠): Snapshot-based — AI reads A11y tree to decide, fully dynamic
 */

import { _electron, type ElectronApplication, type Page } from "@playwright/test";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { A11yNode, Diagnostic, VscodeDriverOptions } from "../types.js";

const DEFAULT_TIMEOUT = 5000;
const COMMAND_PALETTE_KEY = "F1";
const ENTER_KEY = "Enter";
const CODE_ACTION_KEY = "Control+.";
const TRIGGER_SUGGEST_KEY = "Control+Space";
const NEXT_MARKER_COMMAND = "Go to Next Problem (Error, Warning, Info)";
const QUICK_INPUT_SELECTOR = ".quick-input-box input";
const QUICK_INPUT_WIDGET_SELECTOR = ".quick-input-widget";
const SUGGEST_WIDGET_SELECTOR = ".editor-widget.suggest-widget";
const WORKBENCH_SELECTOR = ".monaco-workbench";

export class VscodeDriver {
  private app: ElectronApplication | null = null;
  private page: Page | null = null;
  private options: VscodeDriverOptions;
  /** Temp copy of workspace — cleaned up on close() */
  private tempWorkspaceDir: string | null = null;

  constructor(options: VscodeDriverOptions = {}) {
    this.options = {
      vscodeVersion: "insiders",
      ...options,
    };
  }

  // ═══════════════════════════════════════════════════════
  //  Lifecycle
  // ═══════════════════════════════════════════════════════

  async launch(): Promise<void> {
    // If a previous instance is still running, close it first
    if (this.app) {
      console.log("⚠️  Closing previous VSCode instance...");
      await this.close();
    }

    const version = this.options.vscodeVersion ?? "insiders";
    const vscodePath = await downloadAndUnzipVSCode(version);
    const [cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodePath);

    const userDataDir = this.options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"));

    // Wipe user data dir to prevent window restoration and stale file index.
    // Extensions are in a separate --extensions-dir so they won't be affected.
    const defaultUserDataDir = baseArgs.find(a => a.startsWith("--user-data-dir="))?.split("=")[1];
    if (defaultUserDataDir && fs.existsSync(defaultUserDataDir)) {
      try {
        fs.rmSync(defaultUserDataDir, { recursive: true, force: true });
      } catch {
        // If locked by a previous process, wait and retry
        await new Promise((r) => setTimeout(r, 2000));
        try { fs.rmSync(defaultUserDataDir, { recursive: true, force: true }); } catch { /* proceed anyway */ }
      }
    }

    // Pre-install marketplace extensions before launching
    if (this.options.extensions && this.options.extensions.length > 0) {
      console.log(`📦 Installing ${this.options.extensions.length} extension(s)...`);
      for (const extId of this.options.extensions) {
        console.log(`   ↳ ${extId}`);
        try {
          execFileSync(cli, [
            ...baseArgs,
            "--install-extension", extId,
            "--force",
          ], {
            stdio: "pipe",
            timeout: 120_000,
            env: { ...process.env },
            shell: true,  // Required on Windows for .cmd files
          });
        } catch (e) {
          console.warn(`   ⚠️  Failed to install ${extId}: ${(e as Error).message}`);
        }
      }
      console.log(`📦 Extensions installed\n`);
    }

    const args = [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      "--disable-workspace-trust",
      "--password-store=basic",
      ...baseArgs,
    ];

    if (this.options.extensionPath) {
      args.push(`--extensionDevelopmentPath=${this.options.extensionPath}`);
    }

    if (this.options.workspacePath) {
      // Use a fixed temp directory name so cleanup is deterministic
      const tmpDir = os.tmpdir();
      const fixedDir = path.join(tmpDir, "autotest-workspace");
      // Remove any previous workspace copy and stale temp dirs
      try {
        for (const entry of fs.readdirSync(tmpDir)) {
          if (entry.startsWith("autotest-ws-") || entry === "autotest-workspace") {
            fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
          }
        }
      } catch { /* ignore */ }

      this.tempWorkspaceDir = fixedDir;
      fs.mkdirSync(fixedDir, { recursive: true });
      const destDir = path.join(fixedDir, path.basename(this.options.workspacePath));
      fs.cpSync(this.options.workspacePath, destDir, { recursive: true });
      console.log(`📂 Workspace copied to: ${destDir}`);
      args.push(destDir);
    } else if (this.options.filePath) {
      // Single file mode — copy the file to a temp dir and open it directly
      const tmpDir = os.tmpdir();
      const fixedDir = path.join(tmpDir, "autotest-workspace");
      if (fs.existsSync(fixedDir)) fs.rmSync(fixedDir, { recursive: true, force: true });
      fs.mkdirSync(fixedDir, { recursive: true });
      const destFile = path.join(fixedDir, path.basename(this.options.filePath));
      fs.copyFileSync(this.options.filePath, destFile);
      this.tempWorkspaceDir = fixedDir;
      console.log(`📄 File copied to: ${destFile}`);
      args.push(destFile);
    }

    // Inject settings.json into the ACTUAL user data dir that VSCode will use (from baseArgs)
    const actualUserDataDir = baseArgs.find(a => a.startsWith("--user-data-dir="))?.split("=")[1] ?? userDataDir;
    const settingsPath = path.join(actualUserDataDir, "User", "settings.json");
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    // Always disable window restoration for test isolation
    const existingSettings = fs.existsSync(settingsPath)
      ? JSON.parse(fs.readFileSync(settingsPath, "utf-8"))
      : {};
    const settings = {
      ...existingSettings,
      "window.restoreWindows": "none",
      "window.newWindowDimensions": "maximized",
      // Force Standard mode — Hybrid/LightWeight only provides syntax features
      "java.server.launchMode": "Standard",
      // Suppress notifications that can interfere with UI automation
      "java.help.showReleaseNotes": false,
      "java.help.firstView": "none",
      "java.configuration.checkProjectSettingsExclusions": false,
      "extensions.ignoreRecommendations": true,
      "telemetry.telemetryLevel": "off",
      "update.showReleaseNotes": false,
      "workbench.enableExperiments": false,
      "redhat.telemetry.enabled": false,
      ...this.options.settings,
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));

    this.app = await _electron.launch({
      executablePath: vscodePath,
      env: { ...process.env, NODE_ENV: "development" },
      args,
    });

    this.page = await this.app.firstWindow();
    // Wait for VSCode workbench to render
    await this.page.locator(WORKBENCH_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });

    // Dismiss all notification toasts that may interfere with UI automation
    await this.dismissAllNotifications();
  }

  /** Close all visible notification toasts */
  async dismissAllNotifications(): Promise<void> {
    try {
      await this.runCommandFromPalette("Notifications: Clear All Notifications");
    } catch { /* ignore if command not found */ }
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.page = null;
    }
    // Clean up temp workspace copy (retry to handle file locks released after process exit)
    if (this.tempWorkspaceDir) {
      const dir = this.tempWorkspaceDir;
      this.tempWorkspaceDir = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          fs.rmSync(dir, { recursive: true, force: true });
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
  }

  getPage(): Page {
    if (!this.page) throw new Error("VscodeDriver not launched. Call launch() first.");
    return this.page;
  }

  // ═══════════════════════════════════════════════════════
  //  Level 1 🟢: Command-based operations (extremely stable)
  // ═══════════════════════════════════════════════════════

  /** Execute a VSCode command via Command Palette (F1 → type → Enter) */
  async runCommandFromPalette(label: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(COMMAND_PALETTE_KEY);

    const palette = page.locator(QUICK_INPUT_SELECTOR);
    await palette.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    // F1 opens with ">" prefix for command mode — fill() replaces all text,
    // so we must include ">" to stay in command search mode.
    await palette.fill(`>${label}`);
    await page.waitForTimeout(300);

    await page.keyboard.press(ENTER_KEY);
    // Wait for Quick Input to close
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Open a file via Quick Open (Ctrl+P). Retries if the file indexer isn't ready. */
  async openFile(filePath: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      await page.keyboard.press(`${modifier}+P`);

      const input = page.locator(QUICK_INPUT_SELECTOR);
      await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await input.fill(filePath);
      await page.waitForTimeout(500);

      // Check if Quick Open found any results
      const hasResults = await page.locator(".quick-input-list .monaco-list-row").count() > 0;

      if (hasResults) {
        await page.keyboard.press(ENTER_KEY);
        await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      // No results — dismiss and retry after waiting for file indexer
      await page.keyboard.press("Escape");
      await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});

      if (attempt < maxAttempts - 1) {
        console.log(`   ⏳ Quick Open: no results for "${filePath}", retrying (${attempt + 1}/${maxAttempts})...`);
        await page.waitForTimeout(3000);
      }
    }

    throw new Error(`File not found in Quick Open after ${maxAttempts} attempts: ${filePath}`);
  }

  /** Get the content of the active editor */
  async getEditorContent(): Promise<string> {
    const page = this.getPage();
    // Try Monaco model API first
    const modelContent = await page.evaluate(() => {
      const model = (window as any).monaco?.editor?.getModels?.()?.[0];
      return model?.getValue?.() ?? null;
    });
    if (modelContent) return modelContent;

    // Fallback: read visible text from editor DOM
    return await page.locator(".monaco-editor .view-lines").first().innerText().catch(() => "");
  }

  /** Check if the active editor contains the specified text (checks model + visible DOM) */
  async editorContains(text: string): Promise<boolean> {
    const content = await this.getEditorContent();
    if (content.includes(text)) return true;

    // Fallback: use Playwright's getByText to search visible text in the editor
    const page = this.getPage();
    const found = await page.locator(".monaco-editor").getByText(text, { exact: false }).first()
      .isVisible().catch(() => false);
    return found;
  }

  /** Save the active file (Ctrl+S) */
  async saveFile(): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+S`);
    await page.waitForTimeout(500);
  }

  /** Go to a specific line number (Ctrl+G) */
  async goToLine(line: number): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+G`);
    const input = page.locator(QUICK_INPUT_SELECTOR);
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    // Ctrl+G opens with ":" prefix for line navigation — must preserve it
    await input.fill(`:${line}`);
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Move cursor to end of current line */
  async goToEndOfLine(): Promise<void> {
    await this.getPage().keyboard.press("End");
  }

  /** Execute a keyboard shortcut */
  async pressKeys(keys: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(keys);
    await page.waitForTimeout(300);
  }

  /** Run a command in the integrated terminal */
  async runInTerminal(command: string): Promise<void> {
    await this.runCommandFromPalette("Terminal: Create New Terminal");
    // Wait for terminal to be ready
    const page = this.getPage();
    await page.locator(".terminal-wrapper").first().waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.keyboard.type(command);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  }

  // ═══════════════════════════════════════════════════════
  //  Level 2 🟡: Role-based operations (stable)
  // ═══════════════════════════════════════════════════════

  /** Activate a side tab by name (e.g., "Explorer", "Extensions", "API Center") */
  async activeSideTab(tabName: string): Promise<void> {
    const page = this.getPage();
    const tab = page.getByRole("tab", { name: tabName }).locator("a");
    await tab.click();
    // Wait for the corresponding side pane to render
    await page.waitForTimeout(500);
  }

  /** Check if a side tab is visible */
  async isSideTabVisible(tabName: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("tab", { name: tabName }).isVisible();
  }

  /** Click a tree item by its display name */
  async clickTreeItem(name: string): Promise<void> {
    const page = this.getPage();
    const item = page.getByRole("treeitem", { name }).locator("a").first();
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.click();
    await page.waitForTimeout(500);
  }

  /** Check if a tree item is visible */
  async isTreeItemVisible(name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("treeitem", { name }).isVisible();
  }

  /** Select an option by name in the Command Palette dropdown */
  async selectPaletteOption(optionText: string): Promise<void> {
    const page = this.getPage();
    const option = page.getByRole("option", { name: optionText }).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Select an option by index in the Command Palette dropdown */
  async selectPaletteOptionByIndex(index: number): Promise<void> {
    const page = this.getPage();
    const option = page.getByRole("option").nth(index).locator("a");
    await option.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await option.click();
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Get all current notification messages */
  async getNotifications(): Promise<string[]> {
    const page = this.getPage();
    const notifications = await page.locator(".notifications-toasts .notification-toast").allTextContents();
    return notifications;
  }

  /** Get status bar text */
  async getStatusBarText(): Promise<string> {
    const page = this.getPage();
    return await page.locator(".statusbar").textContent() ?? "";
  }

  // ═══════════════════════════════════════════════════════
  //  Level 3 🟠: Snapshot-based operations (AI dynamic)
  // ═══════════════════════════════════════════════════════

  /** Get the Accessibility tree snapshot of the current window */
  async snapshot(): Promise<A11yNode> {
    const page = this.getPage();
    // accessibility.snapshot() was removed in newer Playwright; use type assertion
    const tree = await (page as any).accessibility?.snapshot?.();
    return (tree as A11yNode) ?? { role: "window", name: "empty" };
  }

  /** Get a DOM HTML snapshot */
  async domSnapshot(): Promise<string> {
    const page = this.getPage();
    return await page.evaluate(() => document.documentElement.outerHTML);
  }

  /** Take a screenshot and return as buffer */
  async screenshot(outputPath?: string): Promise<Buffer> {
    const page = this.getPage();
    const buffer = await page.screenshot({ fullPage: true });
    if (outputPath) {
      fs.writeFileSync(outputPath, buffer);
    }
    return buffer;
  }

  /** Click any element by role and name (generic) */
  async clickByRole(role: string, name: string): Promise<void> {
    const page = this.getPage();
    const el = page.getByRole(role as any, { name });
    await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await el.click();
  }

  /** Click any element containing specific text */
  async clickByText(text: string): Promise<void> {
    const page = this.getPage();
    const el = page.getByText(text).first();
    await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await el.click();
  }

  // ═══════════════════════════════════════════════════════
  //  Level 1.5 🟢: Java / Language Server operations
  // ═══════════════════════════════════════════════════════

  /** Type text into the active editor at the cursor position */
  async typeInEditor(text: string): Promise<void> {
    const page = this.getPage();
    // Dismiss any active suggest/autocomplete
    await page.keyboard.press("Escape");

    // Use VSCode's internal 'type' command — this is the same path as real keyboard input,
    // so the Language Server will receive didChange notifications.
    const success = await page.evaluate(async (t) => {
      const vscode = (window as any).require?.("vscode");
      if (!vscode) return false;
      // 'type' command inserts text at cursor, triggers all editor events including LS sync
      await vscode.commands.executeCommand("type", { text: t });
      return true;
    }, text);

    if (!success) {
      // Fallback: use Monaco executeEdits API
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
  }

  /** Select all text in the active editor */
  async selectAllInEditor(): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`);
  }

  /** Replace entire editor content with new text */
  async setEditorContent(content: string): Promise<void> {
    await this.selectAllInEditor();
    const page = this.getPage();
    await page.keyboard.press("Delete");
    await page.keyboard.type(content, { delay: 10 });
  }

  /**
   * Type a snippet trigger word and select the snippet from completion list.
   */
  async typeAndTriggerSnippet(triggerWord: string): Promise<void> {
    const page = this.getPage();
    const editor = page.locator(".monaco-editor .view-lines").first();
    await editor.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await editor.click();

    await page.keyboard.type(triggerWord, { delay: 50 });

    // Trigger suggestion and wait for suggest widget
    await page.keyboard.press(TRIGGER_SUGGEST_KEY);
    await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT }).catch(() => {});

    // Try to find and select the snippet item
    const snippetOption = page.locator(
      ".monaco-list-row .suggest-icon.codicon-symbol-snippet"
    ).first();
    const hasSnippet = await snippetOption.isVisible().catch(() => false);

    if (hasSnippet) {
      await snippetOption.click();
    } else {
      await page.keyboard.press(ENTER_KEY);
    }
    // Wait for suggest widget to close
    await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /**
   * Wait for the Java Language Server to become ready.
   * Polls the status bar for the LS ready indicator.
   */
  async waitForLanguageServer(timeoutMs = 120_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();
    const pollInterval = 2000;

    console.log(`   ⏳ Waiting for Language Server (timeout: ${timeoutMs / 1000}s)...`);

    let lastStatus = "";
    while (Date.now() - start < timeoutMs) {
      // Use Playwright locator to find the Java status bar item by its text
      // The status text transitions: (none) → "Lightweight Mode" → "Activating" → "Importing" → "Ready"
      const statusItems = page.locator("footer a, footer [role='button']");
      const count = await statusItems.count();
      let currentStatus = "";

      for (let i = 0; i < count; i++) {
        const text = (await statusItems.nth(i).textContent().catch(() => ""))?.trim() ?? "";
        // Match "Java: Ready", "Java: Activating...", "Java: Importing Maven project(s)" etc.
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

      // Only match "Java: Ready" exactly (or with 👍)
      if (/Java:\s*Ready/i.test(currentStatus) || currentStatus.includes("👍")) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`   ✅ Language Server ready (${elapsed}s)`);
        return true;
      }

      await page.waitForTimeout(pollInterval);
    }

    console.log(`   ⚠️ Language Server not ready after ${timeoutMs / 1000}s (last: "${lastStatus}")`);
    return false;
  }

  /**
   * Get the count of errors and warnings in the Problems panel.
   */
  async getProblemsCount(): Promise<{ errors: number; warnings: number }> {
    const page = this.getPage();

    // Strategy 1: read from status bar aria-labels (fast, ~5 elements)
    const items = page.locator(".statusbar a");
    const count = await items.count();
    for (let i = 0; i < count; i++) {
      const label = await items.nth(i).getAttribute("aria-label") ?? "";
      const errMatch = label.match(/(\d+)\s*error/i);
      const warnMatch = label.match(/(\d+)\s*warning/i);
      if (errMatch || warnMatch) {
        return {
          errors: errMatch ? parseInt(errMatch[1], 10) : 0,
          warnings: warnMatch ? parseInt(warnMatch[1], 10) : 0,
        };
      }
    }

    // Strategy 2: open Problems panel and count by icon class
    await this.runCommandFromPalette("View: Focus Problems (Errors, Warnings, Infos)");
    await page.waitForTimeout(500);

    const errors = await page.locator(".markers-panel .codicon-error").count().catch(() => 0);
    const warnings = await page.locator(".markers-panel .codicon-warning").count().catch(() => 0);

    // Close the panel focus
    await page.keyboard.press("Escape");

    return { errors, warnings };
  }

  /** Navigate to the next problem (error/warning) in the editor */
  async navigateToNextError(): Promise<void> {
    await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
  }

  /** Navigate to a specific error by index (1-based) */
  async navigateToError(index: number): Promise<void> {
    for (let i = 0; i < index; i++) {
      await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
    }
  }

  /**
   * Trigger Code Action menu at current cursor and select an action by label.
   */
  async applyCodeAction(label: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    await page.keyboard.press(`${modifier}+.`);

    // Wait for code action menu to appear
    const actionItem = page.getByRole("option", { name: label }).first();
    try {
      await actionItem.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
      await actionItem.click();
    } catch {
      // Fallback: type in the filter and press Enter
      const filterInput = page.locator(
        ".context-view .monaco-inputbox input, .quick-input-box input"
      ).first();
      const hasFilter = await filterInput.isVisible().catch(() => false);
      if (hasFilter) {
        await filterInput.fill(label);
        await page.waitForTimeout(300);
      }
      await page.keyboard.press(ENTER_KEY);
    }

    // Wait for code action to be applied
    await page.waitForTimeout(1000);
  }

  /**
   * Trigger code completion (IntelliSense) at the current cursor position.
   * Returns the visible completion items as an array of label strings.
   */
  async triggerCompletion(): Promise<string[]> {
    const page = this.getPage();
    await page.keyboard.press(TRIGGER_SUGGEST_KEY);

    // Wait for suggest widget to appear
    await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT }).catch(() => {});

    const items = await page.locator(
      ".monaco-list-row .label-name"
    ).allTextContents().catch(() => [] as string[]);

    return items;
  }

  /** Dismiss the current completion widget */
  async dismissCompletion(): Promise<void> {
    await this.getPage().keyboard.press("Escape");
    await this.getPage().locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════
  //  Verification helpers
  // ═══════════════════════════════════════════════════════

  /** Check if an element with given role and name is visible */
  async isElementVisible(role: string, name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole(role as any, { name }).isVisible();
  }

  /** Get text content of an element by role and name */
  async getElementText(role: string, name: string): Promise<string> {
    const page = this.getPage();
    return (await page.getByRole(role as any, { name }).textContent()) ?? "";
  }

  /** Get Problems panel diagnostics */
  async getProblems(): Promise<Diagnostic[]> {
    const page = this.getPage();
    const problems = await page.evaluate(() => {
      // Try reading from VSCode's diagnostic API via DOM
      const items = document.querySelectorAll(".markers-panel .monaco-list-row");
      return Array.from(items).map((el) => ({
        severity: "error" as const,
        message: el.textContent ?? "",
      }));
    });
    return problems;
  }

  /** Check if a file exists in the workspace */
  async fileExists(filePath: string): Promise<boolean> {
    return fs.existsSync(filePath);
  }

  /** Check if a file contains specific text */
  async fileContains(filePath: string, text: string): Promise<boolean> {
    if (!fs.existsSync(filePath)) return false;
    const content = fs.readFileSync(filePath, "utf-8");
    return content.includes(text);
  }

  /** Read file content */
  async readFile(filePath: string): Promise<string> {
    return fs.readFileSync(filePath, "utf-8");
  }

  /** Get the workspace root path (temp copy) */
  getWorkspacePath(): string | null {
    if (!this.tempWorkspaceDir) return null;
    const entries = fs.readdirSync(this.tempWorkspaceDir);
    return entries.length > 0 ? path.join(this.tempWorkspaceDir, entries[0]) : null;
  }

  /**
   * Insert a line into a file on disk at the specified line number (1-based).
   * The file must already be open in the editor. After modifying on disk,
   * reverts the editor to pick up changes — the LS stays active and re-analyzes quickly.
   */
  async insertLineInFile(relativePath: string, lineNumber: number, text: string): Promise<void> {
    const wsPath = this.getWorkspacePath();
    if (!wsPath) throw new Error("No workspace path available");

    const filePath = path.join(wsPath, relativePath);

    // Handle escaped \n sequences (literal backslash-n from YAML) as actual newlines.
    // If text already contains real newlines (from YAML multiline), use as-is.
    const resolvedText = text.includes("\\n") ? text.replace(/\\n/g, "\n") : text;

    if (fs.existsSync(filePath)) {
      // Modify existing file
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      lines.splice(lineNumber - 1, 0, resolvedText);
      fs.writeFileSync(filePath, lines.join("\n"));
      console.log(`   📝 Inserted line ${lineNumber} in ${relativePath}`);
      // Revert editor to pick up the on-disk changes
      await this.runCommandFromPalette("File: Revert File");
    } else {
      // Create new file with content
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, resolvedText);
      console.log(`   📝 Created ${relativePath}`);
      // Open the newly created file
      await this.openFile(path.basename(filePath));
    }
  }

  /** Revert the current file to its on-disk state */
  async revertFile(): Promise<void> {
    await this.runCommandFromPalette("File: Revert File");
  }

  // ═══════════════════════════════════════════════════════
  //  Debugging operations
  // ═══════════════════════════════════════════════════════

  /** Start a debug session (F5 or via command) */
  async startDebugSession(): Promise<void> {
    await this.getPage().keyboard.press("F5");
    // Wait for debug toolbar to appear
    await this.getPage().locator(".debug-toolbar").waitFor({ state: "visible", timeout: 30_000 }).catch(() => {});
  }

  /** Stop the current debug session (Shift+F5) */
  async stopDebugSession(): Promise<void> {
    await this.getPage().keyboard.press("Shift+F5");
    await this.getPage().locator(".debug-toolbar").waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
  }

  /** Set a breakpoint at a specific line in the current file */
  async setBreakpoint(line: number): Promise<void> {
    await this.goToLine(line);
    await this.runCommandFromPalette("Debug: Toggle Breakpoint");
  }

  /** Wait for the debugger to hit a breakpoint */
  async waitForBreakpointHit(timeoutMs = 30_000): Promise<boolean> {
    const page = this.getPage();
    try {
      // When paused, the debug toolbar shows pause-related buttons
      // and the editor shows a yellow highlight on the stopped line
      await page.locator(".debug-toolbar .codicon-debug-continue").waitFor({
        state: "visible", timeout: timeoutMs,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Debug step over (F10) */
  async debugStepOver(): Promise<void> {
    await this.getPage().keyboard.press("F10");
    await this.getPage().waitForTimeout(500);
  }

  /** Debug step into (F11) */
  async debugStepInto(): Promise<void> {
    await this.getPage().keyboard.press("F11");
    await this.getPage().waitForTimeout(500);
  }

  /** Debug step out (Shift+F11) */
  async debugStepOut(): Promise<void> {
    await this.getPage().keyboard.press("Shift+F11");
    await this.getPage().waitForTimeout(500);
  }

  /** Get variable values from the Variables panel */
  async getDebugVariables(): Promise<Array<{ name: string; value: string }>> {
    const page = this.getPage();
    // Focus on Variables view
    await this.runCommandFromPalette("Debug: Focus on Variables View");
    await page.waitForTimeout(500);

    const items = await page.locator(".debug-view-content .monaco-list-row").all();
    const variables: Array<{ name: string; value: string }> = [];
    for (const item of items) {
      const text = await item.textContent().catch(() => "") ?? "";
      // Format: "name: value" or "name = value"
      const match = text.match(/^(.+?)[\s:=]+(.+)$/);
      if (match) {
        variables.push({ name: match[1].trim(), value: match[2].trim() });
      }
    }
    return variables;
  }

  /** Get Debug Console output text */
  async getDebugConsoleOutput(): Promise<string> {
    const page = this.getPage();
    await this.runCommandFromPalette("Debug Console: Focus on Debug Console View");
    await page.waitForTimeout(500);

    const output = await page.locator(".repl .monaco-list-rows").textContent().catch(() => "");
    return output ?? "";
  }

  // ═══════════════════════════════════════════════════════
  //  Test Runner operations
  // ═══════════════════════════════════════════════════════

  /** Open the Test Explorer view */
  async openTestExplorer(): Promise<void> {
    await this.runCommandFromPalette("Testing: Focus on Test Explorer View");
  }

  /** Run all tests via command */
  async runAllTests(): Promise<void> {
    await this.runCommandFromPalette("Test: Run All Tests");
  }

  /** Wait for test execution to complete by polling the test status bar */
  async waitForTestComplete(timeoutMs = 60_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      // Check if test progress is done (no spinning icon in test explorer)
      const spinning = await page.locator(".testing-progress-icon .codicon-loading").isVisible().catch(() => false);
      if (!spinning && Date.now() - start > 3000) {
        return true;
      }
      await page.waitForTimeout(2000);
    }
    return false;
  }

  /** Get test results summary from the Test Explorer */
  async getTestResults(): Promise<{ passed: number; failed: number; total: number }> {
    const page = this.getPage();
    await this.openTestExplorer();
    await page.waitForTimeout(500);

    const passedCount = await page.locator(".test-explorer .codicon-testing-passed-icon").count().catch(() => 0);
    const failedCount = await page.locator(".test-explorer .codicon-testing-failed-icon").count().catch(() => 0);

    return {
      passed: passedCount,
      failed: failedCount,
      total: passedCount + failedCount,
    };
  }

  /** Click a CodeLens link by its text */
  async clickCodeLens(label: string): Promise<void> {
    const page = this.getPage();
    const codeLens = page.locator(`.codelens-decoration a`).filter({ hasText: label }).first();
    await codeLens.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await codeLens.click();
    await page.waitForTimeout(1000);
  }

  // ═══════════════════════════════════════════════════════
  //  Hover & context interaction
  // ═══════════════════════════════════════════════════════

  /** Hover on a symbol in the editor to trigger hover provider */
  async hoverOnText(text: string): Promise<void> {
    const page = this.getPage();
    const target = page.locator(".monaco-editor .view-lines").getByText(text, { exact: false }).first();
    await target.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await target.hover();
    // Wait for hover widget to appear
    await page.locator(".monaco-hover").waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Get the content of the hover popup */
  async getHoverContent(): Promise<string> {
    const page = this.getPage();
    return await page.locator(".monaco-hover-content").textContent().catch(() => "") ?? "";
  }

  /** Click an action link inside the hover popup */
  async clickHoverAction(label: string): Promise<void> {
    const page = this.getPage();
    const action = page.locator(".monaco-hover-content a, .monaco-hover-content .action-label")
      .filter({ hasText: label }).first();
    await action.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await action.click();
    await page.waitForTimeout(500);
  }

  /** Dismiss the hover popup */
  async dismissHover(): Promise<void> {
    await this.getPage().keyboard.press("Escape");
    await this.getPage().locator(".monaco-hover").waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  // ═══════════════════════════════════════════════════════
  //  File Explorer context menu
  // ═══════════════════════════════════════════════════════

  /** Right-click a tree item and select a context menu option */
  async contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void> {
    const page = this.getPage();
    const item = page.getByRole("treeitem", { name: itemName }).locator("a");
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.click({ button: "right" });

    // Wait for context menu
    const menu = page.locator(".context-view .action-label").filter({ hasText: menuLabel }).first();
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await menu.click();
    await page.waitForTimeout(500);
  }

  /** Create a new file via Explorer right-click menu */
  async createNewFileViaExplorer(parentFolder: string, fileName: string): Promise<void> {
    await this.contextMenuOnTreeItem(parentFolder, "New File");

    // Type the file name in the inline input
    const page = this.getPage();
    const input = page.locator(".explorer-viewlet .monaco-inputbox input").first();
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(fileName);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  }

  // ═══════════════════════════════════════════════════════
  //  Dependency tree operations
  // ═══════════════════════════════════════════════════════

  /** Open the Java Dependencies view */
  async openDependencyExplorer(): Promise<void> {
    await this.runCommandFromPalette("Java: Focus on Java Dependencies View");
  }

  /** Expand a chain of tree nodes (e.g., ["Sources", "src", "main"]) */
  async expandTreePath(names: string[]): Promise<void> {
    for (const name of names) {
      await this.clickTreeItem(name);
    }
  }

  /** Wait for a specified duration (seconds) */
  async wait(seconds: number): Promise<void> {
    await this.getPage().waitForTimeout(seconds * 1000);
  }
}
