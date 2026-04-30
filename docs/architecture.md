# VSCode AutoTest — AI-Assisted VS Code Extension Testing Framework

## 1. Project positioning

VSCode AutoTest is an **AI-assisted VS Code extension E2E testing tool**.

Users provide a structured YAML test plan. The framework launches VS Code, executes actions, verifies outcomes, captures screenshots, and writes reports.

The core idea is to drive stable VS Code operation primitives with declarative test plans, use deterministic execution and verification first, and keep AI as an optional failure-analysis layer.

---

## 2. Core architecture

```text
┌──────────────────────────────────────────────────────────┐
│                      Test Plan (YAML)                    │
│  Human-authored steps and expected outcomes; no locators │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│                    TestRunner                            │
│  Read plan → ActionResolver → Driver → StepVerifier      │
│  Before/after screenshots → results.json / summary.md    │
│  → optional LLM failure analysis                         │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│              VscodeDriver (operation SDK)                │
│  Playwright + @vscode/test-electron                      │
│  Stable VS Code automation APIs                          │
└──────────────────┬───────────────────────────────────────┘
                   │
                   ▼
┌──────────────────────────────────────────────────────────┐
│              Playwright Electron Runtime                 │
│  Launches VS Code Electron and exposes a Page object     │
└──────────────────────────────────────────────────────────┘
```

---

## 3. Locator stability strategy

The framework avoids brittle CSS selectors and uses three locator strategies in priority order:

| Priority | Strategy | Stability | Example | Use cases |
|----------|----------|-----------|---------|-----------|
| 1 | VS Code command ID | Very high | `editor.action.formatDocument` | Operations with command IDs |
| 2 | Accessibility role + name | High | `getByRole('treeitem', { name: 'API Center' })` | TreeViews, tabs, buttons |
| 3 | Screenshot / A11y snapshot analysis | Flexible | Compare before/after screenshots after failure | Custom extension UI, unknown surfaces |

**Design rule**: prefer commands to bypass UI; use accessibility roles when UI interaction is required; use screenshots and snapshots to diagnose failures.

---

## 4. VscodeDriver operation primitives

### 4.1 Highly stable operations based on VS Code commands / keyboard shortcuts

These operations rely on VS Code commands or keyboard shortcuts and rarely change across versions:

```typescript
// Execute a VS Code command.
async runCommand(commandId: string, ...args: any[]): Promise<void>

// Execute a command through the Command Palette.
async runCommandFromPalette(label: string): Promise<void>

// File operations.
async openFile(filePath: string): Promise<void>
async getEditorContent(): Promise<string>
async setEditorContent(content: string): Promise<void>
async saveFile(): Promise<void>

// Terminal operations.
async runInTerminal(command: string): Promise<string>

// Keyboard shortcuts.
async pressKeys(keys: string): Promise<void>
```

### 4.2 Stable operations based on accessibility roles

Playwright `getByRole` locators are much more stable than CSS selectors:

```typescript
// Side bar.
async activeSideTab(tabName: string): Promise<void>
async isSideTabVisible(tabName: string): Promise<boolean>

// TreeView.
async clickTreeItem(name: string): Promise<void>
async expandTreeItem(name: string): Promise<void>
async isTreeItemVisible(name: string): Promise<boolean>

// Command Palette / Quick Pick.
async selectPaletteOption(optionText: string): Promise<void>
async selectPaletteOptionByIndex(index: number): Promise<void>

// Notifications.
async getNotifications(): Promise<string[]>
async dismissNotification(text: string): Promise<void>

// Status bar.
async getStatusBarText(): Promise<string>
```

### 4.3 Snapshot and generic UI primitives

When command IDs and role-based locators are insufficient, the Driver still exposes screenshots, accessibility snapshots, and generic locators for debugging, failure analysis, and future extension:

```typescript
// Structured accessibility tree for the current UI.
async snapshot(): Promise<A11yTree>

// DOM snapshot for lower-level analysis.
async domSnapshot(): Promise<string>

// Screenshot capture.
async screenshot(path?: string): Promise<Buffer>

// Generic clicks.
async clickByRole(role: string, name: string): Promise<void>
async clickByText(text: string): Promise<void>
```

### 4.4 Verification operations

```typescript
// UI state verification.
async isElementVisible(role: string, name: string): Promise<boolean>
async getElementText(role: string, name: string): Promise<string>

// Editor verification.
async editorContains(text: string): Promise<boolean>
async getEditorLanguage(): Promise<string>
async getEditorFileName(): Promise<string>

// Problems panel.
async getProblems(): Promise<Diagnostic[]>
async getProblemCount(): Promise<{ errors: number; warnings: number }>

// Filesystem verification.
async fileExists(path: string): Promise<boolean>
async fileContains(path: string, text: string): Promise<boolean>
async readFile(path: string): Promise<string>
```

---

## 5. Test plan format

### 5.1 YAML format

```yaml
name: "Validate API Center tree navigation"
description: "Tests the Azure API Center extension TreeView"

setup:
  extension: "azure-api-center"
  extensionPath: "./path/to/extension"    # Extension development path
  vscodeVersion: "insiders"               # stable | insiders
  workspace: "./test-workspace"           # Workspace folder
  settings:                               # Pre-filled VS Code settings
    azure-api-center.tenant:
      name: "test-tenant"
      id: "xxx-xxx"
  timeout: 120                            # Global timeout in seconds

steps:
  - id: "open-side-panel"
    action: "click side tab API Center"
    verify: "The API Center panel is visible"

  - id: "expand-subscription"
    action: "expandTreeItem Azure Subscription"
    verify: "The apic-test service is visible"

  - id: "register-api"
    action: "run command Azure API Center: Register API"
    verify: "A CI/CD option list appears"

  - id: "select-github"
    action: "select GitHub option"
    verify: "A register-api.yml file is generated"
    verifyFile:
      path: ".github/workflows/register-api.yml"
      contains: "azure/api-center"

  - id: "check-notification"
    action: "wait 3 seconds"
    verifyNotification: "API registered successfully"
```

### 5.2 Test plan fields

| Field | Description |
|-------|-------------|
| `action` | Describes the operation to execute; `ActionResolver` maps it to Driver primitives |
| `verify` | Natural-language expected outcome used as LLM failure-analysis context |
| `verifyFile` | Filesystem verification with path and content matching |
| `verifyNotification` | Specific notification verification |
| `verifyEditor` | Editor content verification |
| `verifyProblems` | Problems error/warning count verification |
| `verifyCompletion` | Completion list verification |
| `verifyQuickInput` | Quick Input validation-message verification |
| `verifyDialog` | Modal dialog visibility and content verification |
| `verifyTreeItem` | TreeView item appearance/disappearance verification |
| `verifyEditorTab` | Editor tab title verification |
| `verifyOutputChannel` | Output channel text verification |
| `verifyTerminal` | Terminal text verification |
| `timeout` | Step timeout in seconds |
| `waitBefore` | Delay before executing the step, in seconds |

### 5.3 Iterating on test plans

- Every run emits detailed logs, screenshots, and a JSON report.
- When a step fails and Azure OpenAI is configured, the framework uses before/after screenshots to suggest test plan fixes.
- New test steps are added by appending YAML; no code changes are required for existing primitives.

---

## 6. TestRunner flow

```text
┌─────────────────────────────────────────────────┐
│              TestRunner main loop               │
│                                                 │
│  for each step in testPlan.steps:               │
│    │                                            │
│    ├─ 1. waitBefore (optional)                  │
│    │                                            │
│    ├─ 2. before screenshot                      │
│    │                                            │
│    ├─ 3. ActionResolver.resolve(step.action)    │
│    │     Regex dictionary maps to Driver calls; │
│    │     unmatched actions fall back to the     │
│    │     Command Palette                        │
│    │                                            │
│    ├─ 4. after screenshot                       │
│    │                                            │
│    ├─ 5. StepVerifier.verify(step)              │
│    │     Runs all deterministic checks          │
│    │                                            │
│    ├─ 6. If failed and LLM is configured:       │
│    │     compare before/after screenshots and   │
│    │     generate suggestions                   │
│    │                                            │
│    └─ 7. Record result: pass / fail / reason    │
│                                                 │
│  Output: TestReport                             │
└─────────────────────────────────────────────────┘
```

### 6.1 Deterministic verification vs. AI analysis

| Verification mode | When to use | Benefits | Limitations |
|-------------------|-------------|----------|-------------|
| **Deterministic verification** (`verifyFile`, `verifyProblems`, `verifyTerminal`, etc.) | Expected results that can be checked programmatically | Reliable and repeatable | Requires exact check conditions |
| **AI failure analysis** (`verify` context + screenshots) | Explaining UI changes and likely causes after a failure | Flexible and provides repair suggestions | Does not decide pass/fail and can be wrong |

**Recommendation**: use deterministic checks whenever possible. Use AI to diagnose failures and improve test plans.

---

## 7. Comparison with OpenCLI

| Area | OpenCLI adapter mode | This project |
|------|----------------------|--------------|
| Browser engine | Direct CDP connection (`IPage` wrapper) | Playwright Electron (native `Page`) |
| VS Code automation capability | Weaker `IPage` abstraction, no `getByRole`, no auto-waiting | Full Playwright `Page` capabilities |
| Target application | General-purpose, many app adapters | Focused on VS Code |
| Output format | table/json/yaml for humans | Structured JSON for automation |
| Usage model | CLI commands such as `opencli vscode command ...` | SDK + CLI |
| AI integration | No built-in AI layer | Optional Azure OpenAI failure screenshot analysis |
| Test driver model | Manual command orchestration | Declarative test plans |

---

## 8. Technology choices

| Component | Technology | Rationale |
|-----------|------------|-----------|
| VS Code launch/control | `@playwright/test` + `@vscode/test-electron` | Officially recommended stack with native Electron support |
| CLI entry point | `commander` | Lightweight and mature |
| Test plan parsing | `js-yaml` | YAML parsing |
| AI integration | Copilot CLI / Azure OpenAI API | Run orchestration, failure screenshot analysis, repair suggestions |
| Reporting | Custom JSON + console output | Structured and human-readable |
| Type system | TypeScript | Type safety |

---

## 9. Risks and mitigations

| Risk | Mitigation |
|------|------------|
| VS Code UI changes break accessibility tree assumptions | Prefer command IDs; accessibility roles are more stable than CSS |
| Action mapping fails | Use a regex action dictionary; unmatched actions fall back to Command Palette execution |
| AI analysis is wrong | Pass/fail is decided only by deterministic checks; AI is only diagnostic |
| Electron startup is slow | Reuse temporary user-data/extensions directories and manage process lifecycle; attach mode remains a future extension point |
| Extension activation is slow | Use setup timeouts and explicit language-server waits |
