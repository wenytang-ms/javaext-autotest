# VSCode AutoTest Architecture

VSCode AutoTest is a deterministic end-to-end testing framework for VS Code extensions. A YAML test plan describes setup, actions, and expected outcomes. The framework launches VS Code through Playwright Electron, executes action primitives, runs deterministic verifications, captures screenshots, and optionally asks an LLM to analyze failures.

The core design goal is to keep test plans stable and readable while isolating all brittle VS Code UI automation details inside the Driver layer.

## System overview

```text
YAML Test Plan
  |
  v
PlanParser
  - parses YAML
  - resolves setup paths relative to the plan file
  - validates plan shape
  |
  v
TestRunner
  - creates VscodeDriver
  - launches isolated VS Code
  - loops over steps
  - captures before/after screenshots
  - records results
  |
  +--> ActionResolver
  |      - maps action strings to Driver methods
  |      - uses anchored regex patterns
  |      - falls back to Command Palette for unmatched actions
  |
  +--> StepVerifier
  |      - runs deterministic checks
  |      - decides pass/fail
  |
  +--> LLMClient
         - optional failure analysis only
         - never decides pass/fail

VscodeDriver
  |
  v
Playwright Electron + @vscode/test-electron
```

## Source layout

```text
src/
├── cli/
│   └── index.ts
├── drivers/
│   ├── vscodeDriver.ts
│   └── operations/
│       ├── commandOperations.ts
│       ├── dialogOperations.ts
│       ├── hoverOperations.ts
│       └── testRunnerOperations.ts
├── operators/
│   ├── actionResolver.ts
│   ├── llmClient.ts
│   ├── planParser.ts
│   ├── stepVerifier.ts
│   └── testRunner.ts
├── types.ts
└── index.ts
```

## Component responsibilities

| Component | Responsibility | Should not do |
|-----------|----------------|---------------|
| `PlanParser` | Parse YAML, resolve plan-relative setup paths, validate test plan shape | Execute actions or inspect VS Code UI |
| `TestRunner` | Orchestrate launch, step execution, screenshots, verification, reporting, optional LLM analysis | Contain low-level Playwright selectors |
| `ActionResolver` | Convert human-readable action strings into typed Driver calls | Implement UI automation directly |
| `VscodeDriver` | Own VS Code lifecycle, workspace isolation, process cleanup, and shared Driver state | Parse YAML action syntax |
| `drivers/operations/*` | Implement grouped Driver operation methods | Access private Driver fields directly |
| `StepVerifier` | Execute deterministic verification fields and decide pass/fail | Use LLM output as pass/fail authority |
| `LLMClient` | Analyze failed steps using screenshots and context | Execute test steps or mutate results |

## Execution flow

For each step, `TestRunner` performs this sequence:

1. Apply `waitBefore`, if present.
2. Capture the before screenshot.
3. Call `ActionResolver.resolve(step.action)`.
4. Capture the after screenshot, or an error screenshot if execution fails.
5. Call `StepVerifier.verify(step)`.
6. If the step failed or errored and LLM configuration exists, call `LLMClient` for diagnostic analysis.
7. Append a structured result to `results.json`.

Deterministic verification is the only source of truth for pass/fail. The natural-language `verify` field is context for humans and LLM failure analysis.

## Driver design

`VscodeDriver` is the public operation SDK used by `ActionResolver` and `StepVerifier`. It intentionally exposes stable, scenario-oriented methods such as `openFile`, `expandTreeItem`, `applyCodeAction`, `getProblemsCount`, and `runAllTests`.

The class itself keeps lifecycle and shared state:

- VS Code Electron app and Playwright page.
- User-data and extension directories.
- Temporary workspace or git worktree paths.
- Setup-time monkey patches and workspace path helpers.
- Private cleanup helpers.

Feature-specific Driver methods live in operation modules under `src/drivers/operations`. These modules are mixed into `VscodeDriver.prototype` at the bottom of `vscodeDriver.ts`:

```typescript
export interface VscodeDriver
  extends CommandOperations,
    DialogOperations,
    HoverOperations,
    TestRunnerOperations {}

Object.assign(
  VscodeDriver.prototype,
  commandOperations,
  dialogOperations,
  hoverOperations,
  testRunnerOperations,
);
```

This keeps the existing public `VscodeDriver` API stable while allowing large functional areas to be split out of the main file.

## Operation module pattern

Each operation module should follow this structure:

```typescript
import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette?(label: string): Promise<void>;
}

export interface ExampleOperations {
  exampleAction(arg: string): Promise<void>;
}

export const exampleOperations: ExampleOperations = {
  async exampleAction(this: DriverContext, arg: string): Promise<void> {
    const page = this.getPage();
    // implementation
  },
};
```

Operation modules must only depend on public Driver methods exposed through their local `DriverContext` interface. They must not access `private` fields from `VscodeDriver`.

If an operation needs private state, prefer one of these options:

1. Add a small public/protected Driver helper with a clear contract.
2. Keep the operation in `vscodeDriver.ts` until the dependency can be cleanly extracted.
3. Move a coherent group of methods together so shared behavior remains local.

## Locator stability strategy

Use the most stable automation surface available:

| Priority | Strategy | Examples | Guidance |
|----------|----------|----------|----------|
| 1 | VS Code commands and command IDs | `executeVSCodeCommand`, `runCommandFromPalette` | Prefer this when a command exists. |
| 2 | Keyboard shortcuts with stable VS Code behavior | save, go to line, trigger suggest | Acceptable for core editor behavior. |
| 3 | Accessibility roles and names | `getByRole("treeitem", { name })` | Preferred for TreeViews, buttons, tabs, and Quick Picks. |
| 4 | Scoped CSS selectors | Monaco editor, terminal rows, dialog internals | Use only when VS Code has no accessible role surface. Scope narrowly. |
| 5 | Screenshots and snapshots | failure analysis | Diagnostic only; do not use as pass/fail authority. |

Avoid hard-coded screen coordinates. Avoid selectors that depend on incidental DOM layout unless there is no stable alternative.

## Action DSL design

`ActionResolver` owns the action language. Its patterns should be:

- Anchored with `^...$`.
- Specific before generic.
- English-only.
- Explicit about behavior.
- Strict enough to catch typos.

Examples:

```typescript
{
  regex: /^expandTreeItem\s+(.+)$/i,
  handler: async (m) => { await d.expandTreeItem(m[1].trim()); },
}
```

Do not add ambiguous aliases that map different user intentions to the same behavior. For example, `click <name> tree item` may toggle a tree node, while `expandTreeItem <name>` must be idempotent and leave the node expanded.

For actions with multiple free-text arguments, use quoted argument parsing instead of ad-hoc splits:

```yaml
action: 'contextMenu "Maven Dependencies" "Add JAR"'
```

## Verification model

`StepVerifier` runs deterministic verification fields in a fixed order and fails fast. Supported checks include files, notifications, editor content, Problems counts, completion lists, Quick Input validation, dialogs, tree items, editor tabs, output channels, and terminals.

Verification design rules:

- Prefer direct state checks over visual checks.
- Prefer filesystem verification after language-server edits because VS Code can open duplicate tabs for the same file.
- Poll when VS Code or a language server is expected to update asynchronously.
- Return precise failure reasons that include expected and observed values.
- Keep LLM analysis separate from pass/fail logic.

## Workspace and path model

Runtime workspace paths may differ from source paths because the Driver isolates test execution. Test plans and verifiers should use workspace-aware paths:

- `~/path` means the runtime workspace root.
- `${workspaceFolder}` means the runtime workspace root.
- `${workspaceParent}` means the parent directory of the runtime workspace.
- Setup paths in YAML are resolved relative to the test plan file.

Driver operations that accept workspace-related values should call `resolveWorkspacePlaceholders` where appropriate.

## Error handling

Automation errors should fail loudly with useful messages. Do not silently return success for required behavior.

Allowed no-op operations are limited to explicitly optional actions such as `tryClickDialogButton` and `tryClickButton`; their names must make optional behavior obvious.

## Reporting and AI analysis

Every run writes structured output:

```text
test-results/<plan-name>/
├── results.json
└── screenshots/
    ├── 01_step-id_before.png
    ├── 01_step-id_after.png
    └── 02_step-id_error.png
```

`run-all` also writes aggregate summaries. LLM analysis is optional and only runs after deterministic failure or action error.

## Extension points

Use these extension points for new capability:

| Need | Add code in |
|------|-------------|
| New action syntax | `src/operators/actionResolver.ts` |
| New VS Code operation | `src/drivers/operations/*.ts` or `src/drivers/vscodeDriver.ts` |
| New verification field | `src/types.ts` and `src/operators/stepVerifier.ts` |
| New setup field | `src/types.ts`, `src/operators/planParser.ts`, and `src/operators/testRunner.ts` or Driver setup |
| New CLI command | `src/cli/index.ts` |
| New report field | `src/types.ts` and `src/operators/testRunner.ts` |

Keep the direction of dependencies one-way:

```text
CLI / SDK
  -> TestRunner
    -> PlanParser
    -> ActionResolver
      -> VscodeDriver
    -> StepVerifier
      -> VscodeDriver
    -> LLMClient
```

`VscodeDriver` must not import `ActionResolver`, `StepVerifier`, or `TestRunner`.
