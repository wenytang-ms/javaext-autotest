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

export class VscodeDriver {
  private app: ElectronApplication | null = null;
  private page: Page | null = null;
  private options: VscodeDriverOptions;

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
    const version = this.options.vscodeVersion ?? "insiders";
    const vscodePath = await downloadAndUnzipVSCode(version);
    const [_cli, ...baseArgs] = resolveCliArgsFromVSCodeExecutablePath(vscodePath);

    const userDataDir = this.options.userDataDir ?? fs.mkdtempSync(path.join(os.tmpdir(), "autotest-"));

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
      args.push(this.options.workspacePath);
    }

    // Inject settings.json if provided
    if (this.options.settings) {
      const settingsPath = path.join(userDataDir, "User", "settings.json");
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(this.options.settings, null, 2));
    }

    this.app = await _electron.launch({
      executablePath: vscodePath,
      env: { ...process.env, NODE_ENV: "development" },
      args,
    });

    this.page = await this.app.firstWindow();
    // Wait for VSCode to be ready
    await this.page.waitForTimeout(5000);
  }

  async close(): Promise<void> {
    if (this.app) {
      await this.app.close();
      this.app = null;
      this.page = null;
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
    await page.waitForTimeout(500);

    const palette = page.getByRole("combobox", { name: "input" });
    await palette.fill(label);
    await page.waitForTimeout(500);

    await page.getByRole("listbox").first().press(ENTER_KEY);
    await page.waitForTimeout(1000);
  }

  /** Open a file via Quick Open (Ctrl+P) */
  async openFile(filePath: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+P`);
    await page.waitForTimeout(500);

    const input = page.getByRole("combobox", { name: "input" });
    await input.fill(filePath);
    await page.waitForTimeout(500);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  }

  /** Get the content of the active editor */
  async getEditorContent(): Promise<string> {
    const page = this.getPage();
    return await page.evaluate(() => {
      // Access VSCode's Monaco editor model
      const editor = (window as any).monaco?.editor?.getModels?.()?.[0];
      return editor?.getValue?.() ?? "";
    });
  }

  /** Save the active file (Ctrl+S) */
  async saveFile(): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+S`);
    await page.waitForTimeout(500);
  }

  /** Execute a keyboard shortcut */
  async pressKeys(keys: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(keys);
    await page.waitForTimeout(300);
  }

  /** Run a command in the integrated terminal */
  async runInTerminal(command: string): Promise<void> {
    // Open terminal via command
    await this.runCommandFromPalette("Terminal: Create New Terminal");
    await this.getPage().waitForTimeout(2000);

    const page = this.getPage();
    await page.keyboard.type(command);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(2000);
  }

  // ═══════════════════════════════════════════════════════
  //  Level 2 🟡: Role-based operations (stable)
  // ═══════════════════════════════════════════════════════

  /** Activate a side tab by name (e.g., "Explorer", "Extensions", "API Center") */
  async activeSideTab(tabName: string, timeout = DEFAULT_TIMEOUT): Promise<void> {
    const page = this.getPage();
    await page.getByRole("tab", { name: tabName }).locator("a").click();
    await page.waitForTimeout(timeout);
  }

  /** Check if a side tab is visible */
  async isSideTabVisible(tabName: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("tab", { name: tabName }).isVisible();
  }

  /** Click a tree item by its display name */
  async clickTreeItem(name: string): Promise<void> {
    const page = this.getPage();
    await page.getByRole("treeitem", { name }).locator("a").click();
    await page.waitForTimeout(3000);
  }

  /** Check if a tree item is visible */
  async isTreeItemVisible(name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("treeitem", { name }).isVisible();
  }

  /** Select an option by name in the Command Palette dropdown */
  async selectPaletteOption(optionText: string): Promise<void> {
    const page = this.getPage();
    await page.getByRole("option", { name: optionText }).locator("a").click();
    await page.waitForTimeout(1000);
  }

  /** Select an option by index in the Command Palette dropdown */
  async selectPaletteOptionByIndex(index: number): Promise<void> {
    const page = this.getPage();
    await page.getByRole("option").nth(index).locator("a").click();
    await page.waitForTimeout(1000);
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
    await page.getByRole(role as any, { name }).click();
    await page.waitForTimeout(1000);
  }

  /** Click any element containing specific text */
  async clickByText(text: string): Promise<void> {
    const page = this.getPage();
    await page.getByText(text).first().click();
    await page.waitForTimeout(1000);
  }

  // ═══════════════════════════════════════════════════════
  //  Level 1.5 🟢: Java / Language Server operations
  // ═══════════════════════════════════════════════════════

  /** Type text into the active editor at the cursor position */
  async typeInEditor(text: string): Promise<void> {
    const page = this.getPage();
    // Ensure focus is on the editor
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.waitForTimeout(300);
    await page.keyboard.type(text, { delay: 30 });
    await page.waitForTimeout(500);
  }

  /** Select all text in the active editor */
  async selectAllInEditor(): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+A`);
    await page.waitForTimeout(300);
  }

  /** Replace entire editor content with new text */
  async setEditorContent(content: string): Promise<void> {
    await this.selectAllInEditor();
    const page = this.getPage();
    await page.keyboard.press("Delete");
    await page.waitForTimeout(300);
    await page.keyboard.type(content, { delay: 10 });
    await page.waitForTimeout(500);
  }

  /**
   * Type a snippet trigger word and select the snippet from completion list.
   * E.g., typeAndTriggerSnippet("class") types "class" and picks the Snippet item.
   */
  async typeAndTriggerSnippet(triggerWord: string): Promise<void> {
    const page = this.getPage();
    // Ensure focus on editor
    await page.locator(".monaco-editor .view-lines").first().click();
    await page.waitForTimeout(300);

    // Type the trigger word
    await page.keyboard.type(triggerWord, { delay: 50 });
    await page.waitForTimeout(1000);

    // Trigger suggestion if not already visible
    await page.keyboard.press(TRIGGER_SUGGEST_KEY);
    await page.waitForTimeout(1000);

    // Try to find and select the snippet item
    // Snippets show with a "Snippet" detail or a specific icon
    const snippetOption = page.locator(
      ".monaco-list-row .suggest-icon.codicon-symbol-snippet"
    ).first();
    const hasSnippet = await snippetOption.isVisible().catch(() => false);

    if (hasSnippet) {
      await snippetOption.click();
    } else {
      // Fallback: just press Enter to accept the first suggestion
      await page.keyboard.press(ENTER_KEY);
    }
    await page.waitForTimeout(1000);
  }

  /**
   * Wait for the Java Language Server to become ready.
   * Polls the status bar for the LS ready indicator.
   */
  async waitForLanguageServer(timeoutMs = 120_000): Promise<boolean> {
    const page = this.getPage();
    const start = Date.now();
    const pollInterval = 3000;

    while (Date.now() - start < timeoutMs) {
      // Check for the Java LS status bar item
      // VSCode Java extension shows a "thumbsup" or checkmark when ready
      const statusText = await this.getStatusBarText();
      const ready =
        statusText.includes("👍") ||
        statusText.includes("✓") ||
        statusText.includes("Ready");

      // Also check via the LS progress — when no "loading" spinner is visible
      const spinner = page.locator(".statusbar-item .codicon-loading, .statusbar-item .codicon-sync~spin");
      const hasSpinner = await spinner.isVisible().catch(() => false);

      if (ready || (!hasSpinner && Date.now() - start > 10_000)) {
        // Give extra time after LS reports ready
        await page.waitForTimeout(2000);
        return true;
      }

      await page.waitForTimeout(pollInterval);
    }

    return false;
  }

  /**
   * Get the count of errors and warnings in the Problems panel.
   * Reads from the status bar badge which shows "N errors, M warnings".
   */
  async getProblemsCount(): Promise<{ errors: number; warnings: number }> {
    const page = this.getPage();

    // Open Problems panel to ensure badge is up to date
    await this.runCommandFromPalette("View: Toggle Problems");
    await page.waitForTimeout(1000);

    // Try reading from the status bar "Problems" area
    const statusText = await this.getStatusBarText();

    // Pattern: "X errors, Y warnings" or similar
    const errorMatch = statusText.match(/(\d+)\s*error/i);
    const warningMatch = statusText.match(/(\d+)\s*warning/i);

    if (errorMatch || warningMatch) {
      return {
        errors: errorMatch ? parseInt(errorMatch[1], 10) : 0,
        warnings: warningMatch ? parseInt(warningMatch[1], 10) : 0,
      };
    }

    // Fallback: try reading from the panel tab badge
    const problemsBadge = page.locator(
      ".panel .action-label[title*='Problems']"
    );
    const badgeText = await problemsBadge.textContent().catch(() => "");
    const countMatch = badgeText?.match(/\d+/);

    // Also try reading the marker count from panel DOM
    const markers = await page.locator(
      ".markers-panel .monaco-list-row"
    ).count().catch(() => 0);

    return {
      errors: countMatch ? parseInt(countMatch[0], 10) : markers,
      warnings: 0,
    };
  }

  /** Navigate to the next problem (error/warning) in the editor */
  async navigateToNextError(): Promise<void> {
    await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
    await this.getPage().waitForTimeout(1000);
  }

  /** Navigate to a specific error by index (1-based) */
  async navigateToError(index: number): Promise<void> {
    // First go to the first error, then advance
    await this.runCommandFromPalette("Go to Next Problem (Error, Warning, Info)");
    await this.getPage().waitForTimeout(500);
    for (let i = 1; i < index; i++) {
      await this.runCommandFromPalette("Go to Next Problem (Error, Warning, Info)");
      await this.getPage().waitForTimeout(500);
    }
  }

  /**
   * Trigger Code Action menu at current cursor and select an action by label.
   * Uses Ctrl+. to open Quick Fix menu, then searches for matching item.
   */
  async applyCodeAction(label: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    // Trigger Code Actions
    await page.keyboard.press(`${modifier}+.`);
    await page.waitForTimeout(1500);

    // Look for the action in the context menu / quick fix list
    const actionItem = page.getByRole("option", { name: label }).first();
    const visible = await actionItem.isVisible().catch(() => false);

    if (visible) {
      await actionItem.click();
    } else {
      // Fallback: type in the filter and press Enter
      const filterInput = page.locator(
        ".context-view .monaco-inputbox input, .quick-input-box input"
      ).first();
      const hasFilter = await filterInput.isVisible().catch(() => false);
      if (hasFilter) {
        await filterInput.fill(label);
        await page.waitForTimeout(500);
      }
      await page.keyboard.press(ENTER_KEY);
    }

    await page.waitForTimeout(2000);
  }

  /**
   * Trigger code completion (IntelliSense) at the current cursor position.
   * Returns the visible completion items as an array of label strings.
   */
  async triggerCompletion(): Promise<string[]> {
    const page = this.getPage();
    await page.keyboard.press(TRIGGER_SUGGEST_KEY);
    await page.waitForTimeout(2000);

    // Read completion items from the suggest widget
    const items = await page.locator(
      ".monaco-list-row .label-name"
    ).allTextContents().catch(() => [] as string[]);

    return items;
  }

  /** Dismiss the current completion widget */
  async dismissCompletion(): Promise<void> {
    await this.getPage().keyboard.press("Escape");
    await this.getPage().waitForTimeout(300);
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

  /** Wait for a specified duration (seconds) */
  async wait(seconds: number): Promise<void> {
    await this.getPage().waitForTimeout(seconds * 1000);
  }
}
