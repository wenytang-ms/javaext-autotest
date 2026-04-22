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
  /** Marketplace extensions to install before launch (e.g. ["vscjava.vscode-java-pack"]) */
  extensions?: string[];
  /** Local VSIX files to install before launch (paths relative to test plan file) */
  vsix?: string[];
  vscodeVersion?: "stable" | "insiders";
  /** Workspace folder to open. Mutually exclusive with `file`. */
  workspace?: string;
  /** Single file to open (no workspace). For testing LS in no-workspace mode. */
  file?: string;
  /** Git repos to clone before running. Each entry: { url, path?, branch? } */
  repos?: RepoClone[];
  settings?: Record<string, unknown>;
  timeout?: number;
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
  timeout?: number;
  waitBefore?: number;
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
  /** Marketplace extension IDs to install before launch */
  extensions?: string[];
  /** Local VSIX file paths to install before launch */
  vsix?: string[];
  workspacePath?: string;
  /** Single file to open (no workspace) */
  filePath?: string;
  userDataDir?: string;
  settings?: Record<string, unknown>;
  launchArgs?: string[];
  /** Connect to an existing VSCode instance via CDP port instead of launching */
  attachPort?: number;
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
