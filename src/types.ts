/**
 * Core type definitions for VSCode AutoTest framework.
 */

// ─── Test Plan Types ───────────────────────────────────────

export interface TestPlan {
  name: string;
  description?: string;
  setup: TestSetup;
  steps: TestStep[];
}

export interface TestSetup {
  extension: string;
  extensionPath?: string;
  /** Additional local extension development paths to load. */
  extensionPaths?: string[];
  /** Local extension folders to copy into the VS Code extensions directory before launch. */
  localExtensions?: string[];
  /** Marketplace extensions to install before launch (e.g. ["vscjava.vscode-java-pack"]) */
  extensions?: string[];
  /** Local VSIX files to install before launch (paths relative to test plan file) */
  vsix?: string[];
  /** Install pre-release versions of marketplace extensions. Defaults to false (stable). */
  preRelease?: boolean;
  vscodeVersion?: "stable" | "insiders";
  /** Workspace folder to open. Mutually exclusive with `file`. */
  workspace?: string;
  /** Single file to open (no workspace). For testing LS in no-workspace mode. */
  file?: string;
  /** Git repos to clone before running. Each entry: { url, path?, branch? } */
  repos?: RepoClone[];
  settings?: Record<string, unknown>;
  /** Workspace-level settings injected into `<workspace>/.vscode/settings.json`. Takes effect only when a workspace is opened. */
  workspaceSettings?: Record<string, unknown>;
  timeout?: number;
  /**
   * Workspace trust mode:
   * - "disabled" (default): passes --disable-workspace-trust, workspace.isTrusted is always true
   * - "trusted": shows trust prompt on launch, automatically clicks "I Trust" to grant trust
   * - "untrusted": shows trust prompt on launch, automatically clicks "Don't Trust" to stay restricted
   */
  workspaceTrust?: "trusted" | "untrusted" | "disabled";
  /**
   * Mock native file/folder dialogs (showOpenDialog/showSaveDialog).
   * Each entry is a list of file paths to return when the dialog is triggered.
   * Paths are resolved relative to the workspace root (use ~/ prefix).
   * Dialogs are consumed in order — first call returns first entry, etc.
   */
  mockOpenDialog?: string[][];
}

export interface RepoClone {
  /** Git clone URL */
  url: string;
  /** Local path to clone into (relative to plan file). If omitted, derived from repo name. */
  path?: string;
  /** Branch or tag to checkout */
  branch?: string;
}

export interface TestStep {
  id: string;
  action: string;
  verify?: string;
  verifyFile?: FileVerification;
  verifyNotification?: string;
  verifyEditor?: EditorVerification;
  verifyProblems?: ProblemsVerification;
  verifyCompletion?: CompletionVerification;
  verifyQuickInput?: QuickInputVerification;
  verifyDialog?: DialogVerification;
  verifyTreeItem?: TreeItemVerification;
  verifyEditorTab?: EditorTabVerification;
  verifyWebview?: WebviewVerification;
  verifyOutputChannel?: OutputChannelVerification;
  verifyTerminal?: TerminalVerification;
  timeout?: number;
  waitBefore?: number;
  /**
   * Number of additional attempts if the step fails or errors. Defaults to 0
   * (no retry). Useful for known-flaky UI steps like context-menu clicks or
   * tree-item polling on slow Windows runners — allows the plan author to
   * declare retry intent instead of working around flake with `wait` steps.
   */
  retries?: number;
  /**
   * If true, skip the LLM screenshot-based re-verification (which can only
   * downgrade pass→fail). Use for steps where the screenshot is fundamentally
   * uninformative and a deterministic check is the ONLY meaningful signal:
   *
   *   - The action *is* the verification (e.g. `waitForLanguageServer`
   *     polls the status bar for "Java: Ready" — looking at the same status
   *     bar with the LLM adds no signal and only false-downgrades on
   *     transient background-indexing text).
   *   - The action produces no visible change by-design (e.g. disk-only
   *     `insertLineInFile` / `saveFile` against a file that isn't open in
   *     any editor — before/after screenshots are necessarily identical
   *     and the LLM will always downgrade).
   *
   * Do NOT set this flag just because the step has a structured `verify*`
   * field — the LLM may still catch silent-pass scenarios that the
   * deterministic check misses (e.g. `verifyEditor.contains` can match
   * stale text in a hidden editor tab; `verifyProblems.errors: 0` can hold
   * trivially if the file isn't being analyzed). Prefer using
   * `retries: 1-2` to mitigate transient LLM downgrades on decoration lag.
   */
  skipLlmVerify?: boolean;
}

export interface DialogVerification {
  /** Dialog message should contain this text */
  contains?: string;
  /** Dialog should be visible (true) or not visible (false). Defaults to true. */
  visible?: boolean;
}

export interface TreeItemVerification {
  /** Tree item name to check */
  name: string;
  /** If true (default), verify the item is visible. If false, verify it has disappeared. */
  visible?: boolean;
  /** If true, match the tree item name exactly (not as substring) */
  exact?: boolean;
  /**
   * Scope the search to a single view pane (e.g. "Java Projects", "Explorer").
   * The view is located by its pane aria-label, so multiple views in the same
   * side-bar container can be disambiguated. When omitted, the search spans
   * the entire page.
   */
  inView?: string;
}

export interface EditorTabVerification {
  /** Editor tab title to check */
  title: string;
}

export interface WebviewVerification {
  /** Active webview text must contain this substring, or all substrings. */
  contains?: string | string[];
  /** Active webview text must NOT contain this substring, or any of these substrings. */
  notContains?: string | string[];
}

export interface OutputChannelVerification {
  /** Name of the Output channel (e.g. "Maven for Java") */
  channel: string;
  /** Channel text must contain this substring */
  contains?: string;
  /** Channel text must NOT contain this substring */
  notContains?: string;
}

export interface TerminalVerification {
  /** Terminal text must contain this substring */
  contains?: string;
  /** Terminal text must NOT contain this substring */
  notContains?: string;
}

export interface FileVerification {
  path: string;
  exists?: boolean;
  contains?: string;
  matches?: string; // regex
}

export interface EditorVerification {
  fileName?: string;
  contains?: string;
  language?: string;
}

export interface ProblemsVerification {
  errors?: number;
  warnings?: number;
  /** If true, check errors >= value instead of exact match */
  atLeast?: boolean;
}

export interface CompletionVerification {
  /** Completion list must not be empty */
  notEmpty?: boolean;
  /** Completion list must include these items (partial match on label) */
  contains?: string[];
  /** Completion list must NOT include these items (partial match on label) */
  excludes?: string[];
}

export interface QuickInputVerification {
  /** If true, verify no validation error is shown */
  noError?: boolean;
  /** Verify the validation message contains this text */
  messageContains?: string;
  /** Verify the validation message does NOT contain this text */
  messageExcludes?: string;
}

// ─── Driver Types ──────────────────────────────────────────

export interface A11yNode {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  focused?: boolean;
  checked?: boolean;
  disabled?: boolean;
  expanded?: boolean;
  children?: A11yNode[];
}

export interface Diagnostic {
  severity: "error" | "warning" | "info" | "hint";
  message: string;
  source?: string;
  file?: string;
  line?: number;
}

export interface VscodeDriverOptions {
  vscodeVersion?: "stable" | "insiders";
  extensionPath?: string;
  /** Additional local extension development paths to load. */
  extensionPaths?: string[];
  /** Local extension folders to copy into the VS Code extensions directory before launch. */
  localExtensions?: string[];
  /** Marketplace extension IDs to install before launch */
  extensions?: string[];
  /** Local VSIX file paths to install before launch */
  vsix?: string[];
  /** Install pre-release versions of marketplace extensions */
  preRelease?: boolean;
  workspacePath?: string;
  /** Single file to open (no workspace) */
  filePath?: string;
  userDataDir?: string;
  settings?: Record<string, unknown>;
  /** Workspace-level settings injected into `<workspace>/.vscode/settings.json`. */
  workspaceSettings?: Record<string, unknown>;
  launchArgs?: string[];
  /** Connect to an existing VSCode instance via CDP port instead of launching */
  attachPort?: number;
  /** Workspace trust mode. See TestSetup.workspaceTrust for details. */
  workspaceTrust?: "trusted" | "untrusted" | "disabled";
  /** Mock showOpenDialog responses — each entry is consumed in order */
  mockOpenDialog?: string[][];
  /**
   * Max time (ms) to wait for `.monaco-workbench` to render after launch.
   * Defaults to {@link DEFAULT_WORKBENCH_LAUNCH_TIMEOUT_MS}. Bump this for slow
   * runners or when the test installs many extensions (extension
   * activation contributes to first-paint on Windows CI).
   */
  workbenchLaunchTimeoutMs?: number;
}

// ─── Execution Result Types ────────────────────────────────

export interface StepResult {
  stepId: string;
  action: string;
  status: "pass" | "fail" | "skip" | "error";
  reason?: string;
  duration: number;
  snapshot?: A11yNode;
  screenshot?: string; // base64 or file path
}

export interface TestReport {
  planName: string;
  startTime: string;
  endTime: string;
  duration: number;
  results: StepResult[];
  /** Set when VSCode crashed before any steps could run */
  crashed?: boolean;
  crashReason?: string;
  summary: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
    errors: number;
  };
  /** LLM-generated analysis of the overall test run (populated by aggregate analysis) */
  llmAnalysis?: string;
}

// ─── AI Integration Types ──────────────────────────────────

export interface ActionMapping {
  /** Original natural language action */
  action: string;
  /** Mapped driver method calls */
  calls: DriverCall[];
}

export interface DriverCall {
  method: string;
  args: unknown[];
}

export interface VerificationResult {
  passed: boolean;
  reasoning: string;
  confidence: number; // 0-1
  /** Suggestion for fixing the failure (only when passed=false) */
  suggestion?: string;
}
