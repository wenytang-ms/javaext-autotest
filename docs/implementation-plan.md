# Implementation Plan

## Phase 1: Foundation

### 1.1 Project bootstrap

- Initialize the npm project and TypeScript configuration.
- Install core dependencies: `@playwright/test`, `@vscode/test-electron`, `commander`, and `js-yaml`.
- Configure `tsconfig` and linting.

### 1.2 VscodeDriver core

- Implement VS Code launch and shutdown through Playwright Electron.
- Implement `runCommand()` for direct VS Code command execution.
- Implement `runCommandFromPalette()` for Command Palette automation.
- Implement `snapshot()` for accessibility tree capture.
- Implement `screenshot()` for visual artifacts.

### 1.3 Basic verification

- `isElementVisible()` checks element visibility.
- `getNotifications()` reads notification text.
- `fileExists()` / `fileContains()` verify filesystem state.

---

## Phase 2: Driver primitives

### 2.1 Editor operations

- `openFile()` opens a file.
- `getEditorContent()` / `setEditorContent()` read and write editor content.
- `saveFile()` saves the active file.

### 2.2 UI interactions

- `activeSideTab()` switches side bar tabs.
- `clickTreeItem()` / `expandTreeItem()` operate on TreeView nodes.
- `selectPaletteOption()` selects Command Palette / Quick Pick options.

### 2.3 Terminal operations

- `runInTerminal()` runs a command in the integrated terminal.
- `getTerminalText()` reads terminal output.

---

## Phase 3: Test plan engine

### 3.1 Plan parser

- Parse YAML test plans.
- Run setup tasks such as configuration injection and extension activation waits.
- Execute steps sequentially.

### 3.2 Deterministic verifier

- `verifyFile` verifies files.
- `verifyNotification` verifies notifications.
- `verifyEditor` verifies editor content.
- `verifyProblems` / `verifyCompletion` / `verifyQuickInput` / `verifyDialog` cover language-service and UI state.
- `verifyTreeItem` / `verifyEditorTab` / `verifyOutputChannel` / `verifyTerminal` cover workbench surfaces.

### 3.3 Reporting

- Record pass/fail status and reasons for every step.
- Attach before/after/error screenshots for failed or errored steps.
- Emit JSON output for CI and automation.

---

## Phase 4: LLM failure analysis

### 4.1 ActionResolver

- Map natural-language-like action strings to Driver primitive calls.
- Provide a regex-based action dictionary; unmatched actions fall back to Command Palette execution.

### 4.2 Azure OpenAI screenshot analysis

- When deterministic verification fails or a step errors, send before/after screenshots to Azure OpenAI.
- Use the step's `verify` description as the expected-outcome context.
- Return reasoning and suggestions while keeping pass/fail decisions deterministic.

### 4.3 Aggregate analysis

- `run-all` and `analyze` generate `summary.md` from multiple `results.json` files.
- When LLM configuration is available, failed plans receive aggregate analysis.

---

## Phase 5: CLI wrapper

### 5.1 Command-line interface

```bash
# Run one test plan
autotest run test-plans/tree-view.yaml

# Run all test plans
autotest run-all test-plans

# Validate a test plan
autotest validate test-plans/tree-view.yaml

# Analyze existing test results
autotest analyze test-results
```

### 5.2 Configuration entry points

- The test plan `setup` section configures VS Code version, extensions, VSIX files, workspace/file mode, settings, workspace trust, mocked dialogs, and related runtime options.
- LLM analysis is configured through environment variables: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`, and `AZURE_OPENAI_API_VERSION`.
- Report output is controlled by the CLI `--output` option. The output directory contains `results.json`, `screenshots/`, and `summary.md` for aggregate runs.
