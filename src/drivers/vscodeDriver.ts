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
import { pathToFileURL } from "node:url";
import type { VscodeDriverOptions } from "../types.js";
import { commandOperations, type CommandOperations } from "./operations/commandOperations.js";
import { debugOperations, type DebugOperations } from "./operations/debugOperations.js";

import { dialogOperations, type DialogOperations } from "./operations/dialogOperations.js";
import { fileExplorerOperations, type FileExplorerOperations } from "./operations/fileExplorerOperations.js";
import { editorOperations, type EditorOperations } from "./operations/editorOperations.js";
import { hoverOperations, type HoverOperations } from "./operations/hoverOperations.js";
import { languageServerOperations, type LanguageServerOperations } from "./operations/languageServerOperations.js";
import { quickInputOperations, type QuickInputOperations } from "./operations/quickInputOperations.js";
import { snapshotOperations, type SnapshotOperations } from "./operations/snapshotOperations.js";
import { testRunnerOperations, type TestRunnerOperations } from "./operations/testRunnerOperations.js";
import { treeOperations, type TreeOperations } from "./operations/treeOperations.js";
import { verificationOperations, type VerificationOperations } from "./operations/verificationOperations.js";

const WORKBENCH_SELECTOR = ".monaco-workbench";

/**
 * Default deadline for `.monaco-workbench` to render after VSCode launch.
 *
 * The previous value (30 s) was tight on Windows runners that install
 * multiple heavy extensions (e.g. redhat.java + vscjava.vscode-java-pack):
 * Electron startup + extension activation can easily push first paint past
 * 30 s on a noisy hosted-compute agent, surfacing as a fatal
 * `locator('.monaco-workbench') waitFor` timeout that skips every step.
 * 60 s is a conservative ceiling — fast launches still finish in < 10 s
 * and are unaffected.
 */
const DEFAULT_WORKBENCH_LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Pool of keybinding combinations used to drive VS Code commands by id.
 *
 * VS Code's smoke-test driver does NOT expose `executeCommand` on `window.driver`
 * (see src/vs/workbench/services/driver/browser/driver.ts). Instead, we register
 * each requested command as a user keybinding and dispatch the binding via
 * Playwright. These combinations were chosen to avoid clashing with default
 * VS Code keybindings on Linux/macOS/Windows.
 */
const KEYBINDING_POOL = [
  "ctrl+alt+shift+f1", "ctrl+alt+shift+f2", "ctrl+alt+shift+f3",
  "ctrl+alt+shift+f4", "ctrl+alt+shift+f5", "ctrl+alt+shift+f6",
  "ctrl+alt+shift+f7", "ctrl+alt+shift+f8", "ctrl+alt+shift+f9",
  "ctrl+alt+shift+f10", "ctrl+alt+shift+f11", "ctrl+alt+shift+f12",
];

/**
 * Time to wait after rewriting `keybindings.json` so VS Code's user-keybindings
 * file watcher picks up the change. The actual reload typically completes in
 * < 500 ms; 1500 ms is a conservative safety margin to keep flakes out of CI.
 */
const KEYBINDING_RELOAD_DELAY_MS = 1500;

/**
 * Convert an OS-native filesystem path to a valid `file://` URI string in a
 * form that `vscode.Uri.parse(...).fsPath` round-trips correctly on both
 * Windows and POSIX.
 *
 * On Windows (paths like `C:\Users\foo\bar.jar`):
 *   `C:\Users\foo\bar.jar` -> `file:///C:/Users/foo/bar.jar`
 * On POSIX (paths like `/home/runner/foo/bar.jar`):
 *   `/home/runner/foo/bar.jar` -> `file:///home/runner/foo/bar.jar`
 *
 * Backed by Node's `pathToFileURL` so encoding (spaces, non-ASCII, drive
 * letter handling) matches VS Code's `URI.file(...).toString()`.
 */
function pathToFileUri(fsPath: string): string {
  return pathToFileURL(fsPath).toString();
}

interface KeybindingEntry {
  commandId: string;
  args: unknown[];
  key: string;
}

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
  /** User data dir actually used by the launched VS Code (for keybindings.json writes) */
  private actualUserDataDir: string | null = null;
  /** Lazy mapping of (commandId+args) → keybinding key for executeVSCodeCommand */
  private keybindingsByCommand: KeybindingEntry[] = [];

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

    // Reset per-launch keybinding state — each VS Code session gets a fresh pool.
    this.keybindingsByCommand = [];
    this.actualUserDataDir = null;

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
    const usePreRelease = this.options.preRelease === true; // default false
    if (allExtensions.length > 0) {
      console.log(`📦 Installing ${allExtensions.length} extension(s)${usePreRelease ? " (pre-release)" : " (stable)"}...`);
      for (const ext of allExtensions) {
        const isVsix = ext.endsWith(".vsix");
        console.log(`   ↳ ${ext}${isVsix ? " (vsix)" : ""}`);
        const installArgs = [
          ...baseArgs,
          "--install-extension", ext,
          "--force",
        ];
        // Add --pre-release for marketplace extensions (not VSIX files)
        if (!isVsix && usePreRelease) {
          installArgs.push("--pre-release");
        }
        try {
          execFileSync(cli, installArgs, {
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
      // Force a predictable chromium window size — Xvfb resolution alone does NOT
      // size the renderer; chromium falls back to its 1024x768 / 1440x900 default
      // unless told otherwise. A larger window keeps view rows out from under
      // sticky pane-headers in CI.
      "--window-size=1920,1080",
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

    // Track the user data dir so executeVSCodeCommand can rewrite keybindings.json
    // at runtime to register on-the-fly bindings for command-id dispatch.
    this.actualUserDataDir = actualUserDataDir;
    // Start each session with an empty keybindings.json so VS Code does not
    // pick up stale bindings from a previous run that shared this dir.
    const keybindingsPath = path.join(actualUserDataDir, "User", "keybindings.json");
    fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
    fs.writeFileSync(keybindingsPath, "[]");

    this.app = await _electron.launch({
      executablePath: vscodePath,
      env: { ...process.env, NODE_ENV: "development" },
      args,
    });

    // Track the main process PID for targeted cleanup on close
    this.launchedPid = this.app.process().pid ?? null;

    this.page = await this.app.firstWindow();
    // Wait for VSCode workbench to render. See DEFAULT_WORKBENCH_LAUNCH_TIMEOUT_MS
    // — Windows runners with multiple heavy extensions can need significantly
    // more than the historic 30 s; the value is now configurable via
    // VscodeDriverOptions.workbenchLaunchTimeoutMs for advanced scenarios.
    const workbenchTimeout = this.options.workbenchLaunchTimeoutMs ?? DEFAULT_WORKBENCH_LAUNCH_TIMEOUT_MS;
    await this.page.locator(WORKBENCH_SELECTOR).waitFor({ state: "visible", timeout: workbenchTimeout });

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
        .replace(/\$\{workspaceFolderUri\}/g, pathToFileUri(wsPath))
        .replace(/\$\{workspaceParentUri\}/g, pathToFileUri(wsParent))
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
   * Allocate (or reuse) a user keybinding for a `(commandId, args)` pair and
   * return the Playwright key chord that fires it.
   *
   * Used by `executeVSCodeCommand` to drive arbitrary command IDs — including
   * those hidden from the command palette via `"when": false` — without relying
   * on `window.driver.executeCommand`, which VS Code's smoke-test driver does
   * not expose.
   *
   * Side effect: rewrites `${userDataDir}/User/keybindings.json` and waits long
   * enough for VS Code's user-keybindings file watcher to pick up the change.
   *
   * @throws if more than KEYBINDING_POOL.length unique (commandId+args) pairs
   *         have been requested in this session.
   */
  async assignKeybindingForCommand(commandId: string, args: unknown[]): Promise<string> {
    if (!this.actualUserDataDir) {
      throw new Error("VscodeDriver.assignKeybindingForCommand called before launch().");
    }

    const cacheKey = this.keybindingCacheKey(commandId, args);
    const existing = this.keybindingsByCommand.find(
      b => this.keybindingCacheKey(b.commandId, b.args) === cacheKey,
    );
    if (existing) {
      return this.toPlaywrightKey(existing.key);
    }

    if (this.keybindingsByCommand.length >= KEYBINDING_POOL.length) {
      throw new Error(
        `executeVSCodeCommand keybinding pool exhausted (max ${KEYBINDING_POOL.length} unique ` +
        `commands per session). Reuse commands across steps or extend KEYBINDING_POOL.`,
      );
    }

    const entry: KeybindingEntry = {
      commandId,
      args,
      key: KEYBINDING_POOL[this.keybindingsByCommand.length],
    };
    this.keybindingsByCommand.push(entry);
    await this.flushKeybindings();
    return this.toPlaywrightKey(entry.key);
  }

  private keybindingCacheKey(commandId: string, args: unknown[]): string {
    return `${commandId}|${JSON.stringify(args)}`;
  }

  /** Serialize the current keybinding map to keybindings.json and wait for VS Code to reload. */
  private async flushKeybindings(): Promise<void> {
    if (!this.actualUserDataDir) return;
    const keybindingsPath = path.join(this.actualUserDataDir, "User", "keybindings.json");
    const json = this.keybindingsByCommand.map(entry => {
      const out: { key: string; command: string; args?: unknown } = {
        key: entry.key,
        command: entry.commandId,
      };
      // VS Code keybindings allow a single `args` value (string/object/array/etc.).
      // We support 0 or 1 positional args from executeVSCodeCommand; multi-arg
      // commands are uncommon and intentionally not supported via this path.
      if (entry.args.length === 1) {
        out.args = entry.args[0];
      } else if (entry.args.length > 1) {
        out.args = entry.args;
      }
      return out;
    });
    fs.mkdirSync(path.dirname(keybindingsPath), { recursive: true });
    fs.writeFileSync(keybindingsPath, JSON.stringify(json, null, 2));
    if (this.page) {
      await this.page.waitForTimeout(KEYBINDING_RELOAD_DELAY_MS);
    }
  }

  /**
   * Convert a VS Code keybindings.json key string ("ctrl+alt+shift+f1") into a
   * Playwright chord ("Control+Alt+Shift+F1").
   */
  private toPlaywrightKey(keybindingsKey: string): string {
    return keybindingsKey
      .split("+")
      .map(part => {
        const lower = part.trim().toLowerCase();
        if (lower === "ctrl") return "Control";
        if (lower === "cmd" || lower === "meta") return "Meta";
        if (lower === "alt" || lower === "option") return "Alt";
        if (lower === "shift") return "Shift";
        if (/^f\d+$/.test(lower)) return lower.toUpperCase();
        if (lower.length === 1) return lower.toUpperCase();
        return lower.charAt(0).toUpperCase() + lower.slice(1);
      })
      .join("+");
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

export interface VscodeDriver
  extends CommandOperations,
    DebugOperations,
    DialogOperations,
    EditorOperations,
    FileExplorerOperations,
    HoverOperations,
    LanguageServerOperations,
    QuickInputOperations,
    SnapshotOperations,
    TestRunnerOperations,
    TreeOperations,
    VerificationOperations {}

Object.assign(
  VscodeDriver.prototype,
  commandOperations,
  debugOperations,
  dialogOperations,
  editorOperations,
  fileExplorerOperations,
  hoverOperations,
  languageServerOperations,
  quickInputOperations,
  snapshotOperations,
  testRunnerOperations,
  treeOperations,
  verificationOperations,
);
