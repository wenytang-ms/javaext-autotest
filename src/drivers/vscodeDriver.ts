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
import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { A11yNode, Diagnostic, VscodeDriverOptions } from "../types.js";
import { commandOperations, type CommandOperations } from "./operations/commandOperations.js";
import { dialogOperations, type DialogOperations } from "./operations/dialogOperations.js";
import { hoverOperations, type HoverOperations } from "./operations/hoverOperations.js";
import { testRunnerOperations, type TestRunnerOperations } from "./operations/testRunnerOperations.js";

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
  /** PID of the launched VSCode process — used for targeted cleanup */
  private launchedPid: number | null = null;
  /** Temp copy of workspace — cleaned up on close() */
  private tempWorkspaceDir: string | null = null;
  /** Git worktree path — cleaned up on close() */
  private worktreeRoot: string | null = null;

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
    const extensionsDir = baseArgs.find(a => a.startsWith("--extensions-dir="))?.split("=")[1];
    const extensionDevelopmentPaths = [
      ...(this.options.extensionPath ? [this.options.extensionPath] : []),
      ...(this.options.extensionPaths ?? []),
    ];

    if (extensionsDir) {
      for (const extensionDevelopmentPath of extensionDevelopmentPaths) {
        this.removeInstalledExtensionDuplicate(extensionsDir, extensionDevelopmentPath);
      }
    }

    if (this.options.localExtensions?.length) {
      if (!extensionsDir) {
        throw new Error("Unable to resolve VS Code extensions directory for local extension installation.");
      }
      fs.mkdirSync(extensionsDir, { recursive: true });
      for (const extensionPath of this.options.localExtensions) {
        const packageJsonPath = path.join(extensionPath, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        const publisher = packageJson.publisher ?? "local";
        const name = packageJson.name;
        const version = packageJson.version ?? "0.0.0";
        if (!name) {
          throw new Error(`Local extension is missing package.json name: ${extensionPath}`);
        }
        const targetPath = path.join(extensionsDir, `${publisher}.${name}-${version}`);
        fs.rmSync(targetPath, { recursive: true, force: true });
        fs.cpSync(extensionPath, targetPath, { recursive: true });
        console.log(`📦 Installed local extension: ${targetPath}`);
      }
    }

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
    const allExtensions = [
      ...(this.options.extensions ?? []),
      ...(this.options.vsix ?? []),
    ];
    if (allExtensions.length > 0) {
      console.log(`📦 Installing ${allExtensions.length} extension(s)...`);
      for (const ext of allExtensions) {
        const isVsix = ext.endsWith(".vsix");
        console.log(`   ↳ ${ext}${isVsix ? " (vsix)" : ""}`);
        try {
          execFileSync(cli, [
            ...baseArgs,
            "--install-extension", ext,
            "--force",
          ], {
            stdio: "pipe",
            timeout: 120_000,
            env: { ...process.env },
            shell: process.platform === "win32",
          });
        } catch (e) {
          console.warn(`   ⚠️  Failed to install ${ext}: ${(e as Error).message}`);
        }
      }
      console.log(`📦 Extensions installed\n`);
    }

    const trustMode = this.options.workspaceTrust ?? "disabled";
    const args = [
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-gpu",
      "--disable-updates",
      "--skip-welcome",
      "--skip-release-notes",
      ...(trustMode === "disabled" ? ["--disable-workspace-trust"] : []),
      "--password-store=basic",
      "--enable-smoke-test-driver",
      ...baseArgs,
    ];

    for (const extensionPath of extensionDevelopmentPaths) {
      args.push(`--extensionDevelopmentPath=${extensionPath}`);
    }

    if (this.options.workspacePath) {
      // Use git worktree for workspace isolation — this preserves all project paths
      // so the Language Server doesn't get confused by temp directory copies.
      const wsPath = this.options.workspacePath;
      const worktreeDir = await this.createWorktree(wsPath);
      let openedWorkspacePath: string;
      if (worktreeDir) {
        console.log(`📂 Workspace (worktree): ${worktreeDir}`);
        args.push(worktreeDir);
        openedWorkspacePath = worktreeDir;
      } else {
        // Fallback: copy workspace to temp dir (for non-git workspaces)
        const tmpDir = os.tmpdir();
        const fixedDir = path.join(tmpDir, "autotest-workspace");
        try {
          for (const entry of fs.readdirSync(tmpDir)) {
            if (entry.startsWith("autotest-ws-") || entry === "autotest-workspace") {
              fs.rmSync(path.join(tmpDir, entry), { recursive: true, force: true });
            }
          }
        } catch { /* ignore */ }

        this.tempWorkspaceDir = fixedDir;
        fs.mkdirSync(fixedDir, { recursive: true });
        const destDir = path.join(fixedDir, path.basename(wsPath));
        fs.cpSync(wsPath, destDir, { recursive: true });
        console.log(`📂 Workspace (copy): ${destDir}`);
        args.push(destDir);
        openedWorkspacePath = destDir;
      }

      // Inject workspace-level settings (takes precedence over user settings).
      if (this.options.workspaceSettings && Object.keys(this.options.workspaceSettings).length > 0) {
        const wsSettingsDir = path.join(openedWorkspacePath, ".vscode");
        fs.mkdirSync(wsSettingsDir, { recursive: true });
        const wsSettingsPath = path.join(wsSettingsDir, "settings.json");
        const existing = fs.existsSync(wsSettingsPath)
          ? JSON.parse(fs.readFileSync(wsSettingsPath, "utf-8"))
          : {};
        const merged = { ...existing, ...this.options.workspaceSettings };
        fs.writeFileSync(wsSettingsPath, JSON.stringify(merged, null, 2));
        console.log(`⚙️  Wrote workspace settings: ${wsSettingsPath}`);
      }
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

    // Track the main process PID for targeted cleanup on close
    this.launchedPid = this.app.process().pid ?? null;

    this.page = await this.app.firstWindow();
    // Wait for VSCode workbench to render
    await this.page.locator(WORKBENCH_SELECTOR).waitFor({ state: "visible", timeout: 30_000 });

    // Auto-dismiss Electron native dialogs (e.g. redhat.java refactoring
    // confirmation, delete file confirmation). These dialogs are outside
    // the renderer DOM and cannot be handled via Playwright Page API.
    // Must be after firstWindow() to avoid "execution context destroyed" errors.
    try {
      await this.app.evaluate(({ dialog }) => {
        const confirmLabels = /^(OK|Delete|Move to Recycle Bin|Move to Trash)$/i;
        dialog.showMessageBox = async (_win: any, opts: any) => {
          const options = opts || _win;
          const buttons: string[] = options?.buttons || [];
          let idx = buttons.findIndex((b: string) => confirmLabels.test(b));
          if (idx < 0) idx = 0;
          return { response: idx, checkboxChecked: true };
        };
        dialog.showMessageBoxSync = (_win: any, opts: any) => {
          const options = opts || _win;
          const buttons: string[] = options?.buttons || [];
          let idx = buttons.findIndex((b: string) => confirmLabels.test(b));
          if (idx < 0) idx = 0;
          return idx;
        };
      });
    } catch {
      console.warn("⚠️  Could not patch Electron dialogs — native dialogs may need manual handling");
    }

    // Mock showOpenDialog if configured — intercept native file picker
    // and return pre-configured file paths instead of showing OS dialog
    if (this.options.mockOpenDialog?.length) {
      // Resolve ~/ paths to actual workspace directory
      const wsPath = this.getWorkspacePath();
      const mockResponses = this.options.mockOpenDialog.map(entry =>
        entry.map(p => {
          if (p.startsWith("~/") && wsPath) {
            return path.join(wsPath, p.substring(2));
          }
          return p;
        })
      );
      try {
        await this.app.evaluate(({ dialog }, responses) => {
          let callIndex = 0;
          dialog.showOpenDialog = async () => {
            const paths = responses[callIndex] || [];
            callIndex = Math.min(callIndex + 1, responses.length - 1);
            if (paths.length === 0) {
              return { canceled: true, filePaths: [] };
            }
            return { canceled: false, filePaths: paths };
          };
        }, mockResponses);
        console.log(`🔧 Mocked showOpenDialog with ${mockResponses.length} response(s)`);
      } catch {
        console.warn("⚠️  Could not mock showOpenDialog");
      }
    }

    // Handle workspace trust prompt if trust mode is not disabled
    if (trustMode !== "disabled") {
      await this.handleWorkspaceTrustPrompt(trustMode);
    }
  }

  /**
   * Handle the workspace trust startup dialog.
   * VSCode shows a modal dialog asking "Do you trust the authors of the files in this folder?"
   */
  private async handleWorkspaceTrustPrompt(mode: "trusted" | "untrusted"): Promise<void> {
    const page = this.getPage();
    const DIALOG_SELECTOR = ".monaco-dialog-box";

    try {
      // Wait for the trust dialog to appear (up to 10s)
      await page.locator(DIALOG_SELECTOR).waitFor({ state: "visible", timeout: 10_000 });

      if (mode === "trusted") {
        // Click the "I Trust the Authors" / "Yes, I trust" button
        const trustButton = page.locator(DIALOG_SELECTOR)
          .getByRole("button", { name: /trust/i });
        if (await trustButton.count() > 0) {
          await trustButton.first().click();
        } else {
          // Fallback: click first non-cancel button
          await page.locator(DIALOG_SELECTOR).locator(".dialog-buttons button").first().click();
        }
      } else {
        // "untrusted" — click the "Don't Trust" / "No, I don't trust" button
        const dontTrustButton = page.locator(DIALOG_SELECTOR)
          .getByRole("button", { name: /don.*trust|no/i });
        if (await dontTrustButton.count() > 0) {
          await dontTrustButton.first().click();
        } else {
          // Fallback: click last button (typically the "reject" option)
          const buttons = page.locator(DIALOG_SELECTOR).locator(".dialog-buttons button");
          const count = await buttons.count();
          if (count > 1) {
            await buttons.nth(count - 1).click();
          } else if (count > 0) {
            await buttons.first().click();
          }
        }
      }

      console.log(`🔒 Workspace trust: ${mode}`);
    } catch {
      // Dialog may not appear (e.g., trust already resolved) — that's OK
      console.log(`🔒 No workspace trust prompt appeared (mode: ${mode})`);
    }
  }

  /** Close all visible notification toasts (rarely needed with --enable-smoke-test-driver) */
  async dismissAllNotifications(): Promise<void> {
    try {
      await this.runCommandFromPalette("Notifications: Clear All Notifications");
    } catch { /* ignore if command not found */ }
  }

  async close(): Promise<void> {
    const pid = this.launchedPid;
    if (this.app) {
      try {
        await this.app.close();
      } catch { /* may already be closed */ }
      this.app = null;
      this.page = null;
    }

    // Ensure the process tree is fully dead — prevents stale processes
    // from blocking the next test's VSCode launch
    if (pid) {
      this.launchedPid = null;
      await new Promise(r => setTimeout(r, 1000));
      try {
        // Check if process is still alive
        process.kill(pid, 0);
        // Still alive — force kill the process tree
        if (process.platform === "win32") {
          execSync(`taskkill /F /T /PID ${pid}`, { stdio: "ignore" });
        } else {
          execSync(`kill -9 -${pid}`, { stdio: "ignore" });
        }
        await new Promise(r => setTimeout(r, 1000));
      } catch {
        // Process already exited — good
      }
    }
    // Clean up git worktree
    if (this.worktreeRoot) {
      const wt = this.worktreeRoot;
      this.worktreeRoot = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          execSync(`git worktree remove "${wt}" --force`, { stdio: "pipe", cwd: wt });
          break;
        } catch {
          // If git worktree remove fails, try manual delete
          try { fs.rmSync(wt, { recursive: true, force: true }); break; } catch { /* retry */ }
          await new Promise((r) => setTimeout(r, 1000));
        }
      }
    }
    // Clean up temp workspace copy
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

  resolveWorkspacePlaceholders(value: unknown): unknown {
    if (typeof value === "string") {
      const wsPath = this.getWorkspacePath();
      if (!wsPath) {
        return value;
      }
      const wsParent = path.dirname(wsPath);
      const resolvedHome = value.startsWith("~/") ? path.join(wsPath, value.substring(2)) : value;
      return resolvedHome
        .replace(/\$\{workspaceFolder\}/g, wsPath)
        .replace(/\$\{workspaceParent\}/g, wsParent);
    }
    if (Array.isArray(value)) {
      return value.map(item => this.resolveWorkspacePlaceholders(item));
    }
    if (value && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          this.resolveWorkspacePlaceholders(item)
        ])
      );
    }
    return value;
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

  /** Collapse a sidebar section by its title (e.g., "Explorer", "Outline", "Timeline") */
  async collapseSidebarSection(sectionLabel: string): Promise<void> {
    const page = this.getPage();
    const header = page.locator(`.pane-header[aria-expanded="true"]`).filter({ hasText: sectionLabel });
    if (await header.count() > 0) {
      await header.first().click();
      await page.waitForTimeout(500);
    }
  }

  /** Collapse the first expanded workspace folder in the File Explorer tree. */
  async collapseWorkspaceRoot(): Promise<void> {
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
  }

  /** Click a tree item by its display name (excludes sticky scroll rows) */
  async clickTreeItem(name: string): Promise<void> {
    const page = this.getPage();
    // Use getByRole for ARIA matching — won't match section headers (role="button").
    // Click the inner <a> link which triggers expand/collapse in VSCode trees.
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
  }

  /** Expand a tree item by clicking its twistie if it is currently collapsed. */
  async expandTreeItem(name: string): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name, exact: true }).first();
    const item = await exactItem.count() > 0 ? exactItem : page.getByRole("treeitem", { name }).first();
    await item.waitFor({ state: "visible", timeout: 15_000 });
    await item.scrollIntoViewIfNeeded();

    const expanded = await item.getAttribute("aria-expanded").catch(() => null);
    if (expanded === "true") {
      return;
    }

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
      if (currentExpanded === "true") {
        return;
      }
      await item.focus();
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(500);
      const expandedAfterKeyboard = await item.getAttribute("aria-expanded").catch(() => null);
      if (expandedAfterKeyboard === "true") {
        return;
      }
    }

    const finalExpanded = await item.getAttribute("aria-expanded").catch(() => null);
    throw new Error(`Tree item "${name}" did not expand. aria-expanded=${finalExpanded}`);
  }

  /** Double-click a tree item to open it (e.g., open a file from Explorer) */
  async doubleClickTreeItem(name: string): Promise<void> {
    const page = this.getPage();
    const item = page.getByRole("treeitem", { name }).locator("a").first();
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.scrollIntoViewIfNeeded();
    await item.dblclick();
    await page.waitForTimeout(500);
  }

  /** Check if a tree item is visible */
  async isTreeItemVisible(name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole("treeitem", { name }).isVisible();
  }

  /** Wait for a tree item to appear and become visible */
  async waitForTreeItem(name: string, timeoutMs = 15_000, exact = false): Promise<boolean> {
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
  }

  /** Wait for a tree item to disappear from the view */
  async waitForTreeItemGone(name: string, timeoutMs = 15_000, exact = false): Promise<boolean> {
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
  }

  /** Click an inline action button on a tree item (icons that appear on hover) */
  async clickTreeItemAction(itemName: string, actionLabel: string): Promise<void> {
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
      if (!rowBox) {
        break;
      }

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
      if (!box) {
        break;
      }

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
  }

  /** Wait for an editor tab with the given title to become visible */
  async waitForEditorTab(title: string, timeoutMs = 15_000): Promise<boolean> {
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
  }

  /** Type text into quick input and confirm with Enter (convenience method) */
  async fillQuickInput(text: string): Promise<void> {
    // Wait longer for the quick input to appear — some operations (e.g., rename)
    // show the input box with a delay after processing
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const input = page.locator(QUICK_INPUT_SELECTOR);
    await input.waitFor({ state: "visible", timeout: 15_000 });
    await input.fill(resolvedText);
    await page.waitForTimeout(500);
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /**
   * Fill any visible input — tries quick input box first, then inline tree rename input.
   * Useful when the input type depends on the platform or VSCode version.
   */
  async fillAnyInput(text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();

    // Try quick input (showInputBox) first
    const quickInput = page.locator(QUICK_INPUT_SELECTOR);
    // Try inline tree rename input
    const inlineInput = page.locator('.monaco-inputbox input:visible').first();

    // Race: whichever appears first wins
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      if (await quickInput.isVisible().catch(() => false)) {
        await quickInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(ENTER_KEY);
        await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }
      if (await inlineInput.isVisible().catch(() => false)) {
        await inlineInput.fill(resolvedText);
        await page.waitForTimeout(300);
        await page.keyboard.press(ENTER_KEY);
        await page.waitForTimeout(500);
        return;
      }
      await page.waitForTimeout(500);
    }
    throw new Error("No input field (quick input or inline rename) appeared within 15s");
  }

  /** Select an option by name in the Command Palette dropdown */
  async selectPaletteOption(optionText: string): Promise<void> {
    const page = this.getPage();
    // Try exact match first (so "compile" doesn't accidentally pick "test-compile"),
    // then fall back to substring match for partial labels.
    const exactOption = page.getByRole("option", { name: optionText, exact: true }).locator("a");
    const fuzzyOption = page.getByRole("option", { name: optionText }).locator("a");
    const option = (await exactOption.count()) > 0 ? exactOption : fuzzyOption;
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

  /** Type text into the currently visible quick input box (without pressing Enter) */
  async typeInQuickInput(text: string): Promise<void> {
    const resolvedText = this.resolveWorkspacePlaceholders(text) as string;
    const page = this.getPage();
    const input = page.locator(QUICK_INPUT_SELECTOR);
    await input.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await input.fill(resolvedText);
    await page.waitForTimeout(500); // wait for validation to run
  }

  /** Read the validation message from the quick input widget */
  async getQuickInputValidationMessage(): Promise<string> {
    const page = this.getPage();
    // VSCode shows validation in .quick-input-message with severity class
    const msg = page.locator(".quick-input-widget .quick-input-message");
    const visible = await msg.isVisible().catch(() => false);
    if (!visible) return "";
    return await msg.textContent() ?? "";
  }

  /** Press Enter in the quick input to confirm, then wait for it to close */
  async confirmQuickInput(): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press(ENTER_KEY);
    await page.locator(QUICK_INPUT_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
  }

  /** Dismiss/close the quick input widget with Escape */
  async dismissQuickInput(): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Escape");
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
    // Use viewport-only screenshot; fullPage:true can trigger a synthetic
    // scroll/resize in Electron that dismisses modal dialogs and popovers.
    const buffer = await page.screenshot({ fullPage: false });
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

    // Use VSCode's built-in smoke test driver (window.driver.typeInEditor).
    // This injects text via EditContext/TextUpdateEvent — the same mechanism
    // used by VSCode's own E2E tests. It properly triggers LS didChange
    // notifications WITHOUT triggering autocomplete.
    const driverSuccess = await page.evaluate(async (t) => {
      const driver = (window as any).driver;
      if (!driver?.typeInEditor) return false;
      // Find the active editor's EditContext or textarea element
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

    // Try up to 3 times: type trigger word → Ctrl+Space → find snippet
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        // Clear previous attempt
        const modifier = process.platform === "darwin" ? "Meta" : "Control";
        await page.keyboard.press(`${modifier}+A`);
        await page.keyboard.press("Delete");
        await page.waitForTimeout(500);
        console.log(`   ⏳ Snippet retry ${attempt + 1}/3...`);
      }

      await page.keyboard.type(triggerWord, { delay: 50 });
      await page.waitForTimeout(300);

      // Trigger suggestion and wait for suggest widget
      await page.keyboard.press(TRIGGER_SUGGEST_KEY);
      const suggestVisible = await page.locator(SUGGEST_WIDGET_SELECTOR)
        .waitFor({ state: "visible", timeout: 5000 })
        .then(() => true).catch(() => false);

      if (!suggestVisible) continue;

      // Wait a moment for completion items to populate
      await page.waitForTimeout(500);

      // Try to find and select the snippet item
      const snippetOption = page.locator(
        ".monaco-list-row .suggest-icon.codicon-symbol-snippet"
      ).first();
      const hasSnippet = await snippetOption.isVisible().catch(() => false);

      if (hasSnippet) {
        await snippetOption.click();
        await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
        return;
      }

      // Dismiss suggest widget before retry
      await page.keyboard.press("Escape");
      await page.locator(SUGGEST_WIDGET_SELECTOR).waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }

    // Fallback: use "Snippets: Insert Snippet" command
    console.log(`   ⏳ Snippet not found in suggest, using Insert Snippet command...`);
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

    // Locate the problems indicator by its error/warning icons in the status bar.
    // The indicator contains codicon-error and codicon-warning spans followed by count text.
    // We read textContent directly — it updates faster than aria-label.
    const result = await page.evaluate(() => {
      const footer = document.querySelector("footer");
      if (!footer) return null;

      // Find the link that contains error/warning icons
      for (const link of footer.querySelectorAll("a")) {
        const hasErrorIcon = link.querySelector("[class*='codicon-error']");
        const hasWarningIcon = link.querySelector("[class*='codicon-warning']");

        if (hasErrorIcon || hasWarningIcon) {
          // Read counts from textContent: icons render as empty, numbers as text
          // textContent looks like " 0  2  1" (errors, warnings, infos)
          const text = link.textContent ?? "";
          const numbers = text.match(/\d+/g);
          if (numbers && numbers.length >= 2) {
            return {
              errors: parseInt(numbers[0], 10),
              warnings: parseInt(numbers[1], 10),
            };
          }
          // Only one number visible
          if (numbers && numbers.length === 1) {
            return {
              errors: hasErrorIcon ? parseInt(numbers[0], 10) : 0,
              warnings: hasWarningIcon ? parseInt(numbers[0], 10) : 0,
            };
          }
        }

        // Also check for "No Problems" aria-label (when 0/0, icons may not be present)
        const label = link.getAttribute("aria-label") ?? "";
        if (/no problems/i.test(label)) {
          return { errors: 0, warnings: 0 };
        }
      }
      return null;
    });

    return result ?? { errors: -1, warnings: -1 };
  }

  /** Navigate to the next problem (error/warning) in the editor */
  async navigateToNextError(): Promise<void> {
    await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
  }

  /** Navigate to a specific error by index (1-based) */
  async navigateToError(index: number): Promise<void> {
    const page = this.getPage();

    // Open Problems panel and click the Nth error directly —
    // this works across files, unlike "Go to Next Problem" which stays in current file.
    await this.runCommandFromPalette("View: Focus Problems (Errors, Warnings, Infos)");
    await page.waitForTimeout(500);

    const errorRows = page.locator(".markers-panel .monaco-list-row .codicon-error");
    const count = await errorRows.count();

    if (count >= index) {
      // Click the error row to navigate to its location
      const targetRow = errorRows.nth(index - 1).locator("..").locator("..");
      await targetRow.click();
      await page.waitForTimeout(500);
      // Double-click to open the file at the error location
      await targetRow.dblclick();
      await page.waitForTimeout(1000);
    } else {
      // Fallback to "Go to Next Problem" command
      for (let i = 0; i < index; i++) {
        await this.runCommandFromPalette(NEXT_MARKER_COMMAND);
      }
    }
  }

  /**
   * Trigger Code Action menu at current cursor and select an action by label.
   */
  async applyCodeAction(label: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";

    // Ensure editor has focus
    await page.keyboard.press(`${modifier}+1`);
    await page.waitForTimeout(500);

    // Click lightbulb if visible, otherwise Ctrl+.
    const lightbulb = page.locator(".lightBulbWidget .codicon");
    if (await lightbulb.isVisible().catch(() => false)) {
      await lightbulb.click();
    } else {
      await page.keyboard.press(`${modifier}+.`);
    }

    // Wait for the code action widget to render
    const widget = page.locator(".action-widget").first();
    await widget.waitFor({ state: "visible", timeout: 10_000 }).catch(() => {});
    await page.waitForTimeout(500);

    // Search for the action by inner text using page.evaluate (bypasses shadow DOM)
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
  }

  /**
   * Rename the symbol at the current cursor position (F2).
   * Types the new name and confirms with Enter.
   */
  /** Use Find (Ctrl+F) to locate text and place cursor on it, then close the find dialog */
  async findText(text: string): Promise<void> {
    const page = this.getPage();
    const modifier = process.platform === "darwin" ? "Meta" : "Control";
    await page.keyboard.press(`${modifier}+F`);
    const findInput = page.locator(".find-part .input");
    await findInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await findInput.fill(text);
    await page.waitForTimeout(500);
    // Press Escape to close Find widget — cursor stays at the found occurrence
    await page.keyboard.press("Escape");
    await page.locator(".find-part").waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(300);
  }

  async renameSymbol(newName: string): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("F2");
    // Wait for rename input box to appear
    const renameInput = page.locator(".rename-box .rename-input");
    await renameInput.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    // Clear existing text and type new name
    await renameInput.fill(newName);
    await page.waitForTimeout(300);
    await page.keyboard.press(ENTER_KEY);
    await page.waitForTimeout(1000);
  }

  /** Organize Imports via keyboard shortcut (Shift+Alt+O) */
  async organizeImports(): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("Shift+Alt+O");
    await page.waitForTimeout(1000);
    // If a Quick Pick appears for ambiguous imports, select the first option
    const quickPick = page.locator(QUICK_INPUT_WIDGET_SELECTOR);
    const hasQuickPick = await quickPick.isVisible().catch(() => false);
    if (hasQuickPick) {
      await page.keyboard.press(ENTER_KEY);
      await quickPick.waitFor({ state: "hidden", timeout: DEFAULT_TIMEOUT }).catch(() => {});
    }
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

    return this.readCompletionItems();
  }

  /**
   * Move the cursor to a named or explicit position before triggering completion.
   * Supported positions:
   * - endOfLine: end of the current line
   * - endOfMethod: end of the current method body, before its closing brace
   * - line <n> [column <m>]: explicit editor position
   */
  async triggerCompletionAt(position: string): Promise<string[]> {
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
  }

  /** Check if the suggest widget is currently visible */
  async isCompletionVisible(): Promise<boolean> {
    return this.getPage().locator(SUGGEST_WIDGET_SELECTOR).isVisible().catch(() => false);
  }

  /** Read completion items from the currently open suggest widget */
  async readCompletionItems(): Promise<string[]> {
    const page = this.getPage();
    // Scope selector under the suggest widget to avoid picking up other Monaco lists
    const items = await page.locator(SUGGEST_WIDGET_SELECTOR)
      .locator(".monaco-list-row .label-name")
      .allTextContents().catch(() => [] as string[]);
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

  /** Get the workspace root path (worktree or temp copy) */
  getWorkspacePath(): string | null {
    // Prefer worktree workspace (preserves real git paths)
    if (this.worktreeRoot && this.options.workspacePath) {
      const gitRoot = this.findGitRoot(this.options.workspacePath);
      if (gitRoot) {
        const relPath = path.relative(gitRoot, this.options.workspacePath);
        return path.join(this.worktreeRoot, relPath);
      }
    }
    // Fallback to temp copy
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

  /** Delete a file from the workspace on disk */
  async deleteFile(relativePath: string): Promise<void> {
    const wsPath = this.getWorkspacePath();
    if (!wsPath) throw new Error("No workspace path available");
    const filePath = path.join(wsPath, relativePath);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      console.log(`   🗑️ Deleted ${relativePath}`);
    } else {
      console.log(`   ⚠️ File not found: ${relativePath}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  //  Debugging operations
  // ═══════════════════════════════════════════════════════

  /** Start a debug session (F5 or via command) */
  async startDebugSession(): Promise<void> {
    const page = this.getPage();
    await page.keyboard.press("F5");

    // Race: debug toolbar (success) vs error dialog (build errors) vs timeout
    const toolbar = page.locator(".debug-toolbar");
    const errorDialog = page.locator(".monaco-dialog-box");

    // Poll in a loop: check toolbar, dialog, and problems count
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      // Success: debug toolbar appeared
      if (await toolbar.isVisible().catch(() => false)) {
        return;
      }

      // Fail fast: error dialog appeared (e.g., "Build errors exist")
      if (await errorDialog.isVisible().catch(() => false)) {
        const message = await errorDialog.locator(".dialog-message-text").textContent().catch(() => "") ?? "";
        await page.keyboard.press("Escape");
        throw new Error(`Debug session failed: ${message || "error dialog appeared"}`);
      }

      // Fail fast: compilation errors prevent debug from starting
      // (VSCode silently refuses F5 when there are build errors)
      const problems = await this.getProblemsCount();
      if (problems.errors > 0) {
        throw new Error(`Debug session failed: ${problems.errors} compilation error(s) in project`);
      }

      await page.waitForTimeout(1000);
    }

    throw new Error("Debug session failed to start: debug toolbar did not appear within 30s");
  }

  /** Stop the current debug session (Shift+F5) */
  async stopDebugSession(): Promise<void> {
    const page = this.getPage();
    // Only stop if debug toolbar is visible
    const toolbar = page.locator(".debug-toolbar");
    const isActive = await toolbar.isVisible().catch(() => false);
    if (!isActive) {
      console.log("   ⚠️ No active debug session to stop");
      return;
    }
    await page.keyboard.press("Shift+F5");
    await toolbar.waitFor({ state: "hidden", timeout: 10_000 }).catch(() => {});
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

  /** Debug step over (F10) — throws if no active debug session */
  async debugStepOver(): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step over: no active debug session");
    }
    await page.keyboard.press("F10");
    await page.waitForTimeout(500);
  }

  /** Debug step into (F11) — throws if no active debug session */
  async debugStepInto(): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step into: no active debug session");
    }
    await page.keyboard.press("F11");
    await page.waitForTimeout(500);
  }

  /** Debug step out (Shift+F11) — throws if no active debug session */
  async debugStepOut(): Promise<void> {
    const page = this.getPage();
    if (!await page.locator(".debug-toolbar").isVisible().catch(() => false)) {
      throw new Error("Cannot step out: no active debug session");
    }
    await page.keyboard.press("Shift+F11");
    await page.waitForTimeout(500);
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

  /**
   * Read the current text of a specific Output channel (e.g. "Maven for Java").
   * Opens the Output panel, selects the channel via its dropdown, and returns
   * the visible text from the Monaco editor backing the channel. Returns an
   * empty string if the channel cannot be found (rather than throwing) so
   * notContains assertions can still pass when the channel was never created.
   */
  async getOutputChannelText(channelName: string): Promise<string> {
    const page = this.getPage();

    // Ensure the bottom panel is visible.
    const panel = page.locator(".part.panel").first();
    if (!(await panel.isVisible().catch(() => false))) {
      await page.keyboard.press("Control+j");
      await page.waitForTimeout(300);
    }

    // Click the "Output" tab within the panel header (li with role="tab"
    // containing an <a class="action-label"> with text "Output").
    const outputTab = page.locator('.part.panel .composite-bar li.action-item[role="tab"]')
      .filter({ has: page.locator('a.action-label', { hasText: /^Output$/i }) })
      .first();
    try {
      await outputTab.click({ timeout: 3000 });
      await page.waitForTimeout(400);
    } catch {
      // Fallback: keyboard shortcut for Output panel.
      const modifier = process.platform === "darwin" ? "Meta" : "Control";
      await page.keyboard.press(`${modifier}+Shift+U`);
      await page.waitForTimeout(400);
    }

    // The Output panel has a <select class="monaco-select-box"> dropdown in its
    // title bar listing all registered channels. Pick the requested channel.
    const dropdown = page.locator(".part.panel select.monaco-select-box").first();
    if (await dropdown.count() > 0) {
      try {
        await dropdown.selectOption({ label: channelName });
        await page.waitForTimeout(500);
      } catch {
        // Channel not registered yet — leave whatever is currently selected.
      }
    }

    // Monaco renders the channel as a read-only editor with view-lines.
    const lines = page.locator(".part.panel .monaco-editor .view-lines").first();
    const raw = await lines.textContent().catch(() => "");
    // Monaco renders spaces as \u00A0 (non-breaking space). Normalize to
    // regular spaces so natural-language `contains` checks match.
    return (raw ?? "").replace(/\u00A0/g, " ");
  }

  // ═══════════════════════════════════════════════════════
  //  File Explorer context menu
  // ═══════════════════════════════════════════════════════

  /** Right-click a tree item and select a context menu option */
  async contextMenuOnTreeItem(itemName: string, menuLabel: string): Promise<void> {
    const page = this.getPage();
    const exactItem = page.getByRole("treeitem", { name: itemName, exact: true }).locator("a").first();
    const fuzzyItem = page.getByRole("treeitem", { name: itemName }).locator("a").first();
    const item = await exactItem.count() > 0 ? exactItem : fuzzyItem;
    await item.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await item.scrollIntoViewIfNeeded();
    await item.click({ button: "right" });

    // Wait for context menu — scope to .monaco-menu-container for precision
    const menu = page.locator(".monaco-menu-container .monaco-menu");
    await menu.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    const menuItem = menu.getByRole("menuitem", { name: menuLabel });
    await menuItem.first().waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await menuItem.first().hover();
    // Wait for focus state before clicking to avoid flaky clicks
    await page.locator(".monaco-menu-container .action-item.focused").waitFor({
      state: "visible",
      timeout: DEFAULT_TIMEOUT,
    }).catch(() => {});
    await menuItem.first().click();
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

  // ═══════════════════════════════════════════════════════
  //  Private helpers
  // ═══════════════════════════════════════════════════════

  /** Find the git repository root for a given path */
  private findGitRoot(dirPath: string): string | null {
    try {
      const result = execSync("git rev-parse --show-toplevel", {
        cwd: dirPath,
        stdio: "pipe",
        encoding: "utf-8",
      });
      return result.trim();
    } catch {
      return null;
    }
  }

  /**
   * Create a git worktree for workspace isolation.
   * Returns the workspace subdirectory path within the worktree, or null if not a git repo.
   */
  private async createWorktree(workspacePath: string): Promise<string | null> {
    const gitRoot = this.findGitRoot(workspacePath);
    if (!gitRoot) return null;

    const tmpDir = os.tmpdir();

    // Clean up ALL stale autotest-worktree-* directories from previous runs
    try {
      for (const entry of fs.readdirSync(tmpDir)) {
        if (entry.startsWith("autotest-worktree")) {
          const stale = path.join(tmpDir, entry);
          try {
            execSync(`git worktree remove "${stale}" --force`, { cwd: gitRoot, stdio: "pipe" });
          } catch { /* may not be a worktree */ }
          try { fs.rmSync(stale, { recursive: true, force: true }); } catch { /* EBUSY — skip */ }
        }
      }
    } catch { /* ignore readdir errors */ }

    // Use unique name to prevent conflicts between consecutive test plans
    const suffix = Math.random().toString(36).substring(2, 8);
    const worktreeDir = path.join(tmpDir, `autotest-worktree-${suffix}`);

    // Create new worktree from HEAD
    try {
      execSync(`git worktree add "${worktreeDir}" HEAD --detach`, {
        cwd: gitRoot, stdio: "pipe",
      });
    } catch (e) {
      console.warn(`⚠️ Failed to create git worktree: ${(e as Error).message.slice(0, 100)}`);
      return null;
    }

    this.worktreeRoot = worktreeDir;

    // Compute the workspace subdirectory within the worktree
    const relPath = path.relative(gitRoot, workspacePath);
    const worktreeWorkspace = path.join(worktreeDir, relPath);
    return worktreeWorkspace;
  }

  private removeInstalledExtensionDuplicate(extensionsDir: string, extensionDevelopmentPath: string): void {
    const packageJsonPath = path.join(extensionDevelopmentPath, "package.json");
    if (!fs.existsSync(packageJsonPath) || !fs.existsSync(extensionsDir)) {
      return;
    }

    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
    const publisher = packageJson.publisher;
    const name = packageJson.name;
    if (!publisher || !name) {
      return;
    }

    const extensionPrefix = `${publisher}.${name}-`.toLowerCase();
    for (const entry of fs.readdirSync(extensionsDir)) {
      if (entry.toLowerCase().startsWith(extensionPrefix)) {
        const installedExtensionPath = path.join(extensionsDir, entry);
        fs.rmSync(installedExtensionPath, { recursive: true, force: true });
        console.log(`🧹 Removed installed extension duplicate: ${installedExtensionPath}`);
      }
    }
  }

}

export interface VscodeDriver extends CommandOperations, DialogOperations, HoverOperations, TestRunnerOperations {}

Object.assign(VscodeDriver.prototype, commandOperations, dialogOperations, hoverOperations, testRunnerOperations);
