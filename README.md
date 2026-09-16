# VSCode AutoTest

An AI-assisted end-to-end testing framework for VS Code extensions.

Users provide a YAML test plan. The framework launches VS Code, executes actions, verifies outcomes, captures screenshots, and writes structured reports.

> **Goal**: Use declarative YAML test plans to automate VS Code extension E2E testing, with Copilot CLI able to run, analyze, and help fix test plans directly.

---

## Quick start

```bash
# Install dependencies
npm install

# Build
npm run build

# Validate a test plan
npx autotest validate test-plans/java-maven.yaml

# Run a test plan (default output: test-results/<plan-name>/)
npx autotest run test-plans/java-maven.yaml

# Run with an explicit output directory
npx autotest run test-plans/java-maven.yaml --output test-results/java-maven

# Run all plans and generate an aggregate summary
npx autotest run-all test-plans --exclude java-fresh-import

# Opt in to per-case pass audits / failure RCA and matrix-level clustering
npx autotest run-all test-plans --analysis-mode case

# Capture a reusable evidence bundle without calling an LLM
npx autotest run test-plans/java-maven.yaml --analysis-mode evidence-only

# Re-analyze existing test results
npx autotest analyze test-results --analysis-mode case --report-only
```

### Requirements

- Node.js >= 22
- JDK installed for Java extension tests
- The `vscode-java` repository cloned locally when a test plan references its sample projects

---

## Core architecture

```text
┌─────────────────────────────────────────────────────┐
│                  Test Plan (YAML)                    │
│   Describes steps and expected outcomes; no locators │
└──────────────────┬──────────────────────────────────┘
                   │  planParser.ts
                   ▼
┌─────────────────────────────────────────────────────┐
│              TestRunner (orchestrator)               │
│  Launch VS Code → execute steps → evidence → report   │
│                                                     │
│  ┌──────────────────┐  ┌─────────────────────────┐  │
│  │  ActionResolver   │  │     StepVerifier        │  │
│  │  Action → Driver  │  │  Deterministic checks   │  │
│  │  (50+ regex)      │  │  (10+ strategies)       │  │
│  └────────┬─────────┘  └──────────┬──────────────┘  │
│           │                       │                  │
│           │              ┌────────┴────────┐         │
│           │              │    LLMClient    │         │
│           │              │  Azure OpenAI   │         │
│           │              │case + matrix AI │         │
│           │              └─────────────────┘         │
│           │              ┌─────────────────┐         │
│           │              │EvidenceCollector│         │
│           │              │ evidence bundle │         │
│           │              └─────────────────┘         │
└───────────┼──────────────────────────────────────────┘
            ▼
┌─────────────────────────────────────────────────────┐
│           VscodeDriver (operation SDK)               │
│  Playwright Electron + @vscode/test-electron         │
│  Workspace isolation · event waits · process cleanup │
└──────────────────┬──────────────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────────────┐
│           Playwright Electron Runtime                │
│  Launches the VS Code process and exposes Page APIs  │
└─────────────────────────────────────────────────────┘
```

---

## Writing test plans

### Basic structure

```yaml
name: "My test"
setup:
  extension: "my-extension"       # Marketplace extension ID; also installed as the primary extension
  extensionPath: "./path/to/extension"
  extensions: ["publisher.other-extension"]
  vsix: ["./dist/my-extension.vsix"]
  vscodeVersion: "stable"
  workspace: "./test-workspace"   # Relative to the test plan file
  # file: "./Single.java"         # Single-file mode without a workspace
  # repos: [{ url: "https://github.com/org/repo.git", path: "./repo", branch: "main" }]
  timeout: 60
  settings:                       # Injected into VS Code user settings
    editor.fontSize: 14
  workspaceSettings:              # Written to <workspace>/.vscode/settings.json
    java.configuration.updateBuildConfiguration: "automatic"
  workspaceTrust: "disabled"      # disabled | trusted | untrusted
  mockOpenDialog:                 # Optional mocked native open/save dialog responses
    - ["~/lib/example.jar"]

steps:
  - id: "step-1"
    action: "run command My Extension: Hello"
    verifyNotification: "Hello World!"
```

> **Path resolution**: `extensionPath`, `extensionPaths`, `localExtensions`, `workspace`, `file`, `vsix`, `repos[].path`, and non-`~/` `mockOpenDialog` paths are resolved relative to the test plan file, not the current working directory. `~/` means the temporary workspace root at runtime.

### Supported actions

ActionResolver uses a deterministic regex dictionary. Unmatched actions are executed as Command Palette text.

| Category | Action syntax | Description |
|----------|---------------|-------------|
| Commands / keys | `run command <name>`, `selectCommand <name>`, `executeVSCodeCommand <id> [jsonArg]`, `pressKey <key>`, `pressTerminalKey <key>` | Command Palette, VS Code command IDs, and keyboard input |
| Files / editor | `open file <name>`, `saveFile`, `insertLineInFile <path> <line> <text>`, `deleteFile <path>`, `typeInEditor <text>`, `typeAndTriggerSnippet <word>` | Open/save/delete files and edit text; prefer `insertLineInFile` for LS-sensitive code changes |
| Navigation / code intelligence | `waitForLanguageServer`, `goToLine <n>`, `goToEndOfLine`, `findText <text>`, `navigateToError <n>`, `applyCodeAction <label>`, `renameSymbol <newName>`, `organizeImports`, `triggerCompletion`, `triggerCompletionAt <position>`, `hoverOnText <text>`, `clickHoverAction <label>`, `dismissHover` | Java LS, Problems, Code Actions, completion, rename, and hover. Completion positions support `endOfLine`, `endOfMethod`, and `line <n> [column <m>]`. Use `clickHoverAction` to follow links inside the hover popup (e.g. "Go to super implementation"). |
| Workbench UI | `click side tab <name>`, `collapseSidebarSection <name>`, `collapseWorkspaceRoot`, `select <name> option`, `selectOptionByIndex <n>`, `wait <n> seconds` | Side bar, Quick Pick, and static waits |
| TreeView | `click <name> tree item`, `expandTreeItem <name>`, `doubleClick <name> tree item`, `clickTreeItemAction <item> <label>`, `contextMenu <item> <menuLabel>`, `createNewFile <folder> <name>`, `openDependencyExplorer` | Tree node click/expand/double-click, inline actions, context menus, and Java Dependencies. Quote arguments that contain spaces, for example `contextMenu "Maven Dependencies" "Add JAR"`. |
| Quick Input / Dialog | `fillQuickInput <text>`, `fillAnyInput <text>`, `typeInQuickInput <text>`, `confirmQuickInput`, `dismissQuickInput`, `waitForDialog [seconds]`, `clickDialogButton <label>`, `tryClickDialogButton <label>`, `confirmDialog`, `tryClickButton <label>` | Quick Input, inline rename, and modal dialogs |
| Debug / Test Runner | `startDebugSession`, `stopDebugSession`, `setBreakpoint <line>`, `debugStepOver`, `debugStepInto`, `debugStepOut`, `openTestExplorer`, `waitForTestDiscovery <name> [timeout]s`, `runAllTests`, `runTestsWithProfile <profile>`, `clickCodeLens <label>` | Java Debugger and Java Test Runner scenarios |

### Supported verification fields

| Field | Type | Description |
|-------|------|-------------|
| `verify` | string | Natural-language expected outcome used by the existing screenshot re-check and case analysis |
| `verifyFile` | object | File existence/content checks with `path`, `exists`, and `contains` |
| `verifyNotification` | string | Notification text match |
| `verifyEditor` | object | Editor content match, commonly `contains` |
| `verifyProblems` | object | Problems count checks with `errors`, `warnings`, `atLeast`, and polling |
| `verifyCompletion` | object | Completion list checks with `notEmpty`, `contains`, and `excludes` |
| `verifyQuickInput` | object | Quick Input validation checks with `noError`, `messageContains`, and `messageExcludes` |
| `verifyDialog` | object | Modal dialog visibility/content with `visible` and `contains` |
| `verifyTreeItem` | object | Tree item appearance/disappearance with `name`, `visible`, `exact`, optional visible `count`, and optional 1-based `level` (`aria-level`) |
| `verifyEditorTab` | object | Editor tab title appearance |
| `verifyWebview` | object | Active webview text checks with `contains` and `notContains` |
| `verifyOutputChannel` | object | Output channel text checks with `channel`, `contains`, and `notContains` |
| `verifyTerminal` | object | Terminal text checks with `contains` and `notContains` |

---

## Test isolation and screenshots

### Workspace isolation

Each run copies `workspace` into a temporary `autotest-workspace/` location and cleans it up afterwards. The original workspace is never modified.

### Screenshot strategy

Every step captures screenshots under the output directory's `screenshots/` subdirectory. The default output path is `test-results/<plan-name>/screenshots/`; use `--output` to change the output root.

| Step status | Screenshot files |
|-------------|------------------|
| pass | `NN_<stepId>_before.png` + `NN_<stepId>_after.png` |
| fail / error | `NN_<stepId>_before.png` + `NN_<stepId>_after.png` or `NN_<stepId>_error.png` |

The default `legacy` mode keeps the existing report and screenshot behavior unchanged.
`--analysis-mode case` and `--analysis-mode evidence-only` additionally produce a generic
evidence bundle under `evidence/`. A bundled test-only probe reads diagnostics through
`vscode.languages.getDiagnostics()` and records extension/runtime metadata. The Node
collector adds bounded, secret-redacted logs and component metadata; Java runs currently
include an optional adapter for JDT LS logs and bundled JDT/Lombok artifacts. The probe is
loaded only for these opt-in modes and is not part of the extension under test.

### Process management

- The VS Code user-data directory is cleared before each launch to avoid restoring old windows.
- Ctrl+C automatically shuts down the VS Code process.
- `close()` includes retries for Windows file locks.

---

## Analysis modes (optional)

Evidence-backed case analysis is opt-in so existing plans, reports, verdicts, and exit codes remain compatible:

| Mode | Behavior |
|------|----------|
| `legacy` | Default. Keeps the existing step screenshot verification and report shape; does not load the probe or write an evidence bundle. |
| `case` | Keeps step verification, writes the evidence bundle, then performs one case-level pass audit or failure RCA. The case analysis is advisory and never changes the runner verdict. |
| `evidence-only` | Writes the same evidence bundle without any LLM calls. |

Case analysis follows one framework-agnostic pattern: reconstruct the complete scenario and
attempt history, identify the earliest divergence, cite logs/diagnostics/screenshots, split
direct failures from cascading failures, record evidence gaps, and recommend a confirming
experiment. Passing cases are audited for no-op actions, stale state, weak assertions,
hidden errors, and other false-pass risks. Results are stored under the optional top-level
`analysis` field and, when successful, in `analysis/case-analysis.json`.

Each case-analysis request defaults to a 4,000-token completion budget. Set
`AUTOTEST_CASE_ANALYSIS_MAX_TOKENS` to override it in the CLI, or pass
`caseAnalysisMaxTokens` to the SDK's `LLMClient`. Precedence is SDK option, then environment
variable, then the default. The selected value must be a positive safe integer; environment
values use decimal digits, with optional surrounding whitespace.

```typescript
import { LLMClient } from "@vscjava/vscode-autotest";

const llm = new LLMClient({ caseAnalysisMaxTokens: 6000 });
```

This setting applies only to case analysis, not step verification or aggregate summaries.
Invalid values fail case analysis before sending the request. The runner records these
errors, as well as truncated responses, in `analysis.error` without changing the test verdict.

`run-all --analysis-mode case` and `analyze --analysis-mode case` aggregate those case
analyses using evidence-backed root-cause groups across plans and platforms. Reports
created by older AutoTest versions remain readable; cases without the new `analysis` field
fall back to their full failed-step reasons.

Both commands share the same `summary.md` layout in `case` mode:

1. **AI Analysis — TL;DR**: key conclusions, affected cases/platforms, priority actions,
   and important uncertainty, shown before the results table.
2. **E2E Test Results**: the existing result table and totals.
3. **Detailed Analysis**: analysis coverage, evidence-backed problem groups from the
   aggregate model, saved case diagnoses/audits, and folded original execution failures.

One aggregate LLM request produces both the TL;DR and detailed analysis. Each problem
should identify its affected cases/platforms, earliest supported divergence, direct and
cascading failures, evidence, uncertainty, and a confirming action. Recorded failures
and runtime signals accompany the model-generated case diagnoses; matching fingerprints
are only candidate groups, not proof of a common cause. The TL;DR stays short, while
detailed analysis is no longer subject to a shared 500-word limit. Identical recorded
observations are supplied once with per-case/step references to avoid inflating the
aggregate input; this deduplication does not establish shared causality.

Case-mode aggregation defaults to an **8,000-token completion budget**. Configure it with
`LLMClientOptions.aggregateAnalysisMaxTokens` or `AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS`;
precedence is SDK option, environment variable, then default. Both
`summarizeCaseResults()` and `summarizeCaseResultsStructured()` use this setting. It is
validated only when either aggregate method is called, using the same positive-safe-integer
and decimal-environment-value rules as the case budget. Step verification, individual case
analysis, and legacy `summarizeResults()` budgets are unchanged.

```typescript
const llm = new LLMClient({
  caseAnalysisMaxTokens: 4000,
  aggregateAnalysisMaxTokens: 16000,
});
```

The configured budget must be supported by the selected Azure deployment. It can include
reasoning tokens for reasoning models; 8,000 is a default, not a guarantee against truncation.
AutoTest does not automatically increase the budget or retry the aggregate request.

If aggregate analysis is disabled, unconfigured, or fails (including invalid configuration,
truncated, or malformed responses), the TL;DR explicitly reports that it is unavailable.
The report still renders saved per-case RCA and pass audits without another model call:
failure diagnoses and audit warnings are expanded as a fallback, without guessing
cross-case groups. Coverage and individual analysis errors remain visible. Model assessments
and confidence are labeled as opinions, and suspected false passes do not change verdicts.

The case-mode results table identifies platforms and links to the corresponding saved
analysis. Case details include the model's hypothesis, cited evidence, recorded diagnostic
snapshots, direct/cascading step mappings, confirming actions, and evidence gaps. Diagnostic
snapshots are folded after the hypotheses and confirming actions. Original failure/crash
reasons are retained in a folded section without the 150-character cut;
HTML and terminal control characters are escaped or removed for safe display. This does
not change stored case results or command exit behavior.

Legacy and evidence-only report layouts are unchanged. SDK callers can use
`LLMClient.summarizeCaseResultsStructured()` for an `AggregateAnalysis` containing `tldr`
and `details` Markdown strings; it rejects unavailable or invalid analysis. The existing
string-returning summary methods remain compatible.

```yaml
- id: "check-ls"
  action: "waitForLanguageServer"
  verify: "The status bar shows the Java language server is ready"
  verifyProblems:
    errors: 0
```

Enable it with environment variables:

```bash
export AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
export AZURE_OPENAI_API_KEY=<key>
export AZURE_OPENAI_DEPLOYMENT=gpt-4.1       # Optional, default: gpt-4.1
export AZURE_OPENAI_API_VERSION=2024-12-01-preview
export AUTOTEST_CASE_ANALYSIS_MAX_TOKENS=4000 # Optional, default: 4000
export AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS=8000 # Optional, case-aggregate default: 8000
```

- If Azure OpenAI is not configured, `case` mode still writes evidence and records
  `analysis.error`; the runner verdict is unchanged.
- `--no-llm` disables LLM calls. In `case` mode, evidence collection still runs.

---

## TreeView inline actions

VS Code TreeView inline actions, such as Run / Add / New icons on the right side of a row, are usually visible only after hover, focus, or selection. Do not click them with hard-coded coordinates. Use `clickTreeItemAction <item> <label>`:

```yaml
- action: "expandTreeItem Lifecycle"
- action: "clickTreeItemAction compile Run"
```

If the target view is pushed off screen by Explorer, Outline, Timeline, Java Projects, or other sections, collapse space-consuming sections before focusing the target view:

```yaml
- action: "collapseWorkspaceRoot"
- action: "collapseSidebarSection OUTLINE"
- action: "collapseSidebarSection TIMELINE"
- action: "run command Maven: Focus on Maven Projects View"
```

---

## Copilot CLI integration

This repository provides `AGENTS.md`, so Copilot CLI can run tests directly from this directory:

```text
> run the java-maven test
```

Copilot CLI runs `npx autotest run`, reads results and screenshots, and analyzes failures.

See [AGENTS.md](AGENTS.md).

---

## CLI commands

| Command | Description |
|---------|-------------|
| `npx autotest run <plan>` | Run one YAML test plan; default output is `test-results/<plan-name>/` |
| `npx autotest run-all <dir>` | Run all `.yaml/.yml` test plans in a directory and generate `summary.md` |
| `npx autotest analyze <dir>` | Scan existing `results.json` files and regenerate summary / LLM analysis |
| `npx autotest validate <plan>` | Validate YAML test plan format |

Common options:

| Option | Commands | Description |
|--------|----------|-------------|
| `--output <dir>` | `run` / `run-all` / `analyze` | Set the output directory |
| `--analysis-mode <mode>` | `run` / `run-all` / `analyze` | Select `legacy` (default), `case`, or `evidence-only` |
| `--no-llm` | `run` / `run-all` / `analyze` | Skip LLM calls; opt-in evidence collection remains enabled |
| `--report-only` | `analyze` | Write the summary and exit 0 even when cases failed |
| `--vsix <paths>` | `run` / `run-all` | Comma-separated VSIX paths appended to `setup.vsix` |
| `--override <kv...>` | `run` / `run-all` | Override `setup` fields, for example `--override extensionPath=../../vscode-java` |
| `--exclude <plans>` | `run-all` | Comma-separated plan names; defaults to excluding `java-fresh-import` |

---

## Existing test plans

| File | Steps | Scenario |
|------|-------|----------|
| `annotation-completion-before.yaml` | 6 | Annotation completion baseline |
| `java-annotation-completion-bug.yaml` | 6 | Annotation completion regression |
| `java-basic-editing.yaml` | 21 | Basic editing, snippet, Code Action, Rename, Import, Explorer |
| `java-debugger.yaml` | 9 | Breakpoints, debug start, stepping, stop |
| `java-dependency-viewer.yaml` | 7 | Java Dependencies / TreeView |
| `java-extension-pack.yaml` | 3 | Java Extension Pack / Configure Classpath |
| `java-fresh-import.yaml` | 3 | Fresh import / Spring Petclinic |
| `java-gradle-delegate-test.yaml` | 15 | Gradle delegate test |
| `java-gradle-java25.yaml` | 6 | Gradle Java 25 |
| `java-gradle.yaml` | 7 | Gradle LS, completion, navigation, editing |
| `java-maven-java25.yaml` | 6 | Maven Java 25 |
| `java-maven-multimodule.yaml` | 5 | Maven multi-module |
| `java-maven-resolve-type.yaml` | 6 | Maven resolve type / Code Action |
| `java-maven.yaml` | 7 | Maven LS, completion, navigation, editing, diagnostics |
| `java-new-file-snippet.yaml` | 4 | New Java file + class snippet |
| `java-single-file.yaml` | 6 | Single Java file |
| `java-single-no-workspace.yaml` | 6 | Single Java file without a workspace |
| `java-test-runner.yaml` | 6 | Java Test Runner |
| `java-unicode-classname-789.yaml` | 6 | Unicode class name regression |
| `maven-workspace-trust.yaml` | 5 | Maven workspace trust |

### Wiki scenario coverage

| Wiki scenario | Status | Notes |
|---------------|--------|-------|
| Basic #1-5 | Covered | Existing test plan |
| Basic #6-8 (completion/import/rename) | Covered | Existing test plan |
| Basic #9 (New Java File snippet) | Covered | Existing test plan |
| Maven | Covered | Existing test plan |
| Maven Multimodule | Covered | Existing test plan |
| Gradle | Covered | Existing test plan |
| Maven Java 25 | Covered | Existing test plan |
| Gradle Java 25 | Covered | Existing test plan |
| Single file | Covered | Existing test plan |
| Single file without workspace | Covered | `file` single-file mode |
| Fresh import (spring-petclinic) | Covered | Requires the project to be cloned first |
| Debugger for Java | Covered | Existing test plan |
| Java Test Runner | Covered | Existing test plan |
| Maven for Java | Covered | Existing test plan |
| Java Dependency Viewer | Covered | Existing test plan |
| Java Extension Pack | Covered | Webview internals remain limited |

---

## Project structure

```text
autotest/
├── .github/
│   ├── copilot-instructions.md  # Repository-wide Copilot instructions
│   └── instructions/             # Scoped Copilot instruction files
│       ├── action-dsl.instructions.md
│       ├── driver-operations.instructions.md
│       ├── test-plans.instructions.md
│       └── verifiers.instructions.md
├── src/
│   ├── drivers/
│   │   ├── vscodeDriver.ts    # VS Code lifecycle, workspace isolation, shared Driver state
│   │   └── operations/         # Function-specific Driver operation mixins
│   │       ├── _shared.ts          # Shared selectors, key constants, helpers
│   │       ├── commandOperations.ts
│   │       ├── debugOperations.ts
│   │       ├── dialogOperations.ts
│   │       ├── editorOperations.ts
│   │       ├── fileExplorerOperations.ts
│   │       ├── hoverOperations.ts
│   │       ├── languageServerOperations.ts
│   │       ├── quickInputOperations.ts
│   │       ├── snapshotOperations.ts
│   │       ├── testRunnerOperations.ts
│   │       ├── treeOperations.ts
│   │       └── verificationOperations.ts
│   ├── operators/
│   │   ├── actionResolver.ts   # Action → Driver calls (50+ regex)
│   │   ├── defaults.ts         # Shared timeout / poll-interval constants
│   │   ├── evidenceCollector.ts # Diagnostics, runtime metadata, and log evidence
│   │   ├── stepVerifier.ts     # Deterministic verification (10+ strategies)
│   │   ├── verifierUtils.ts    # pollUntil + verify result helpers
│   │   ├── llmClient.ts        # Azure OpenAI client (evidence-based root-cause analysis)
│   │   ├── planParser.ts       # YAML test plan parser (paths relative to plan file)
│   │   └── testRunner.ts       # Orchestrator (launch → execute → screenshot → report)
│   ├── cli/
│   │   └── index.ts            # CLI entry point (run / run-all / analyze / validate)
│   ├── types.ts                # Core type definitions
│   └── index.ts                # SDK exports
├── test-plans/                  # YAML test plans
├── test-results/                # Test output (one subdirectory per plan)
│   └── <plan-name>/
│       ├── results.json
│       ├── diagnostics/
│       └── screenshots/
├── probe-extension/             # Bundled test-only VS Code diagnostics bridge
├── AGENTS.md                    # Copilot CLI integration guide
├── CONTRIBUTING.md              # Contributor workflow and design rules
├── docs/
│   ├── architecture.md          # Architecture
│   ├── implementation-plan.md   # Implementation plan
│   └── ROADMAP.md               # Roadmap
└── package.json
```

## Related documents

- [Architecture](docs/architecture.md)
- [Contributing](CONTRIBUTING.md)
- [Copilot instructions](.github/copilot-instructions.md)
- [Implementation plan](docs/implementation-plan.md)
- [Roadmap](docs/ROADMAP.md)
