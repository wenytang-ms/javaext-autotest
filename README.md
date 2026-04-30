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

# Re-analyze existing test results
npx autotest analyze test-results
```

### Requirements

- Node.js >= 18
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
│  Launch VS Code → execute steps → screenshots → report│
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
│           │              │ failure analysis│         │
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
| Navigation / code intelligence | `waitForLanguageServer`, `goToLine <n>`, `goToEndOfLine`, `findText <text>`, `navigateToError <n>`, `applyCodeAction <label>`, `renameSymbol <newName>`, `organizeImports`, `triggerCompletion`, `triggerCompletionAt <position>`, `hoverOnText <text>`, `dismissHover` | Java LS, Problems, Code Actions, completion, rename, and hover. Completion positions support `endOfLine`, `endOfMethod`, and `line <n> [column <m>]`. |
| Workbench UI | `click side tab <name>`, `collapseSidebarSection <name>`, `collapseWorkspaceRoot`, `select <name> option`, `selectOptionByIndex <n>`, `wait <n> seconds` | Side bar, Quick Pick, and static waits |
| TreeView | `click <name> tree item`, `expandTreeItem <name>`, `doubleClick <name> tree item`, `clickTreeItemAction <item> <label>`, `contextMenu <item> <menuLabel>`, `createNewFile <folder> <name>`, `openDependencyExplorer` | Tree node click/expand/double-click, inline actions, context menus, and Java Dependencies. Quote arguments that contain spaces, for example `contextMenu "Maven Dependencies" "Add JAR"`. |
| Quick Input / Dialog | `fillQuickInput <text>`, `fillAnyInput <text>`, `typeInQuickInput <text>`, `confirmQuickInput`, `dismissQuickInput`, `waitForDialog [seconds]`, `clickDialogButton <label>`, `tryClickDialogButton <label>`, `confirmDialog`, `tryClickButton <label>` | Quick Input, inline rename, and modal dialogs |
| Debug / Test Runner | `startDebugSession`, `stopDebugSession`, `setBreakpoint <line>`, `debugStepOver`, `debugStepInto`, `debugStepOut`, `openTestExplorer`, `waitForTestDiscovery <name> [timeout]s`, `runAllTests`, `runTestsWithProfile <profile>`, `clickCodeLens <label>` | Java Debugger and Java Test Runner scenarios |

### Supported verification fields

| Field | Type | Description |
|-------|------|-------------|
| `verify` | string | Natural-language expected outcome; currently used as context for LLM failure analysis and does not decide pass/fail by itself |
| `verifyFile` | object | File existence/content checks with `path`, `exists`, and `contains` |
| `verifyNotification` | string | Notification text match |
| `verifyEditor` | object | Editor content match, commonly `contains` |
| `verifyProblems` | object | Problems count checks with `errors`, `warnings`, `atLeast`, and polling |
| `verifyCompletion` | object | Completion list checks with `notEmpty`, `contains`, and `excludes` |
| `verifyQuickInput` | object | Quick Input validation checks with `noError`, `messageContains`, and `messageExcludes` |
| `verifyDialog` | object | Modal dialog visibility/content with `visible` and `contains` |
| `verifyTreeItem` | object | Tree item appearance/disappearance with `name`, `visible`, and `exact` |
| `verifyEditorTab` | object | Editor tab title appearance |
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

### Process management

- The VS Code user-data directory is cleared before each launch to avoid restoring old windows.
- Ctrl+C automatically shuts down the VS Code process.
- `close()` includes retries for Windows file locks.

---

## LLM failure analysis (optional)

LLM support is an optional failure-analysis layer. When a deterministic check fails or a step errors, the framework sends before/after screenshots, the action, and the `verify` description to Azure OpenAI to generate reasoning and repair suggestions. `verify` does not replace deterministic checks and does not decide step pass/fail by itself.

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
```

- If not configured, LLM analysis is skipped and deterministic checks are unaffected.
- `--no-llm` forces LLM analysis off.

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
| `--no-llm` | `run` / `run-all` / `analyze` | Skip LLM failure analysis |
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
│   │       ├── commandOperations.ts
│   │       ├── dialogOperations.ts
│   │       ├── hoverOperations.ts
│   │       └── testRunnerOperations.ts
│   ├── operators/
│   │   ├── actionResolver.ts   # Action → Driver calls (50+ regex)
│   │   ├── stepVerifier.ts     # Deterministic verification (10+ strategies)
│   │   ├── llmClient.ts        # Azure OpenAI client (failure screenshot analysis)
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
│       └── screenshots/
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
