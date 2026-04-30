# javaext-autotest — AI Agent Guide

AI-driven VSCode extension E2E testing framework. This guide helps LLM agents create, modify, and debug test plans without repeating known pitfalls.

## Quick Commands

```bash
cd javaext-autotest

# Run a single test plan
npx autotest run test-plans/java-maven.yaml

# Run a single test plan with a VSIX extension
npx autotest run test-plans/plan.yaml --vsix path/to/extension.vsix

# Run all test plans with aggregate summary
npx autotest run-all test-plans --exclude java-fresh-import

# Run all with VSIX and LLM analysis
npx autotest run-all test-plans --vsix path/to/ext.vsix --output test-results

# Validate test plan format
npx autotest validate test-plans/<plan>.yaml
```

## Architecture Overview

```
YAML Test Plan → PlanParser → TestRunner → ActionResolver → VscodeDriver (Playwright)
                                         → StepVerifier (deterministic checks)
                                         → LLMClient (post-failure analysis)
```

- **VscodeDriver** — Playwright Electron wrapper, launches VSCode via `@vscode/test-electron`
- **ActionResolver** — Maps natural language actions to Driver methods via regex patterns
- **StepVerifier** — Deterministic verification (file, editor, problems, completion, notification, tree item, editor tab, dialog, output channel, terminal)
- **LLMClient** — Azure OpenAI for post-failure screenshot analysis (optional)

## Test Plan YAML Structure

```yaml
name: "Plan Name"
description: "What this tests"
setup:
  extension: "redhat.java"                   # primary extension (auto-installed)
  extensions: ["vscjava.vscode-java-pack"]   # additional marketplace extensions
  vsix: ["../../path/to/local.vsix"]         # local VSIX files (relative to plan)
  vscodeVersion: "stable"
  workspace: "../../relative/path/to/project"   # relative to plan file
  # file: "../../path/to/File.java"             # single-file mode (no workspace)
  # repos: [{url: "...", path: "..."}]          # auto-clone repos
  timeout: 90
  settings:                                      # injected into VSCode settings.json
    java.jdt.ls.java.home: "C:\\path\\to\\jdk"
  workspaceTrust: "disabled"                     # "disabled" | "trusted" | "untrusted"
  # Mock native file dialogs (showOpenDialog) — each entry consumed in order
  # mockOpenDialog:
  #   - ["~/libSource/simple.jar"]               # ~/ = workspace root
  #   - ["~/path/to/folder"]

steps:
  - id: "step-id"           # unique, descriptive kebab-case
    action: "actionName args"
    verify: "human-readable description"
    verifyProblems:          # deterministic check
      errors: 0
      warnings: 1
      atLeast: true
    verifyEditor:
      contains: "expected text"
    verifyFile:
      path: "~/relative/to/workspace.java"   # ~/ = workspace root
      contains: "expected content"
    verifyCompletion:
      notEmpty: true
    verifyTreeItem:          # verify tree item visibility
      name: "my-app"
      visible: true          # true (default) = must appear, false = must disappear
      exact: false           # true = exact name match (avoid "App" matching "AppToDelete")
    verifyEditorTab:         # verify editor tab exists
      title: "App.java"
    verifyDialog:
      contains: "dialog text"
      visible: true
    verifyQuickInput:
      noError: true
    verifyTerminal:
      contains: "BUILD SUCCESS"
      notContains: "BUILD FAILURE"
    timeout: 30              # step-level timeout (seconds)
    waitBefore: 5            # wait N seconds before executing
```

## Available Actions

### File Operations
| Action | Description |
|--------|-------------|
| `open file <name>` | Open file via Quick Open (Ctrl+P) |
| `saveFile` | Save current file (Ctrl+S) |
| `insertLineInFile <path> <line> <text>` | **Disk write + Revert** — LS-aware, reliable |
| `typeInEditor <text>` | Inject text via EditContext — LS may NOT detect changes |
| `typeAndTriggerSnippet <word>` | Type + trigger IntelliSense snippet |
| `deleteFile <path>` | Delete a file from disk |

### Navigation
| Action | Description |
|--------|-------------|
| `goToLine <n>` | Ctrl+G jump to line |
| `goToEndOfLine` | End key |
| `findText <text>` | Ctrl+F to find text, cursor stays on match |
| `navigateToError <n>` | Jump to nth error in Problems panel |

### Code Intelligence
| Action | Description |
|--------|-------------|
| `waitForLanguageServer` | Poll until LS shows "Ready" |
| `triggerCompletionAt endOfMethod` | Move cursor + trigger IntelliSense |
| `applyCodeAction <label>` | Ctrl+. → click action by label (partial match) |
| `organizeImports` | Shift+Alt+O |
| `renameSymbol <newName>` | F2 rename |
| `hoverOnText <text>` | Hover to trigger hover provider |
| `dismissHover` | Dismiss hover popup |

### UI Operations
| Action | Description |
|--------|-------------|
| `run command <Command Name>` | Execute via Command Palette (F1) |
| `selectCommand <Command Name>` | Open palette, type, click exact match (not Enter) |
| `pressKey <key>` | Press a keyboard key (e.g. "Enter", "Escape") |
| `click <name> tree item` | Single-click tree node (expands/collapses) |
| `expandTreeItem <name>` | Expand a collapsed tree item by its twistie; no-op if already expanded |
| `doubleClick <name> tree item` | Double-click to open file from Explorer |
| `select <name> option` | Select from Quick Pick dropdown by name |
| `selectOptionByIndex <n>` | Select from Quick Pick dropdown by index (0-based) |
| `click side tab <name>` | Click a sidebar tab (e.g. "Explorer") |
| `collapseSidebarSection <name>` | Collapse an Explorer sidebar section by header text |
| `collapseWorkspaceRoot` | Collapse the first expanded workspace root in Explorer to free vertical space |
| `wait <n> seconds` | Static wait |

### Tree Item Actions
| Action | Description |
|--------|-------------|
| `clickTreeItemAction <item> <label>` | Click inline hover button on tree item (e.g. "Run", "New...") |
| `contextMenu <item> <menuLabel>` | Right-click tree item → select context menu option |
| `openDependencyExplorer` | Open the Java Dependencies view |
| `createNewFile <folder> <name>` | Create file via Explorer right-click → New File |

### Quick Input / Dialog
| Action | Description |
|--------|-------------|
| `fillQuickInput <text>` | Type text + press Enter in quick input box |
| `fillAnyInput <text>` | Fill whichever input is visible (quick input OR inline tree rename) |
| `typeInQuickInput <text>` | Type text into quick input (without confirming) |
| `confirmQuickInput` | Press Enter in quick input |
| `dismissQuickInput` | Press Escape to close quick input |
| `clickDialogButton <label>` | Click a button in a modal dialog |
| `tryClickDialogButton <label>` | Try to click dialog button (silently succeeds if no dialog) |
| `confirmDialog` | Auto-confirm any visible dialog (platform-agnostic) |
| `tryClickButton <label>` | Try to click any button in the workbench (e.g. "Apply") |
| `waitForDialog [<seconds>]` | Wait for a modal dialog to appear |

### Debug
| Action | Description |
|--------|-------------|
| `startDebugSession` | F5 — throws if build errors or toolbar doesn't appear |
| `stopDebugSession` | Shift+F5 — safe if no session active |
| `setBreakpoint <line>` | Toggle breakpoint at line |
| `debugStepOver` / `debugStepInto` / `debugStepOut` | Throws if no active session |

### Test Runner
| Action | Description |
|--------|-------------|
| `openTestExplorer` | Open the Test Explorer view |
| `waitForTestDiscovery <name> [<timeout>s]` | Wait for test item to appear |
| `runAllTests` | Run all tests |
| `runTestsWithProfile <profile>` | Run tests with a specific profile |
| `clickCodeLens <label>` | Click a CodeLens action |

## ⚠️ Critical Gotchas — READ BEFORE WRITING TEST PLANS

### 1. `typeInEditor` vs `insertLineInFile`

**`typeInEditor`** uses VSCode's EditContext API (via `--enable-smoke-test-driver`). It does NOT trigger autocomplete, but **LS may not detect the change**. Use for non-LS-dependent text (comments, markers).

**`insertLineInFile`** writes to disk + `File: Revert`. LS **always** detects the change. Use for any code that LS needs to analyze (imports, type references, method calls).

```yaml
# ❌ BAD — LS won't see the Gson type, no error reported
- action: "typeInEditor         Gson gson;"

# ✅ GOOD — LS detects change, reports error for unknown type
- action: "insertLineInFile src/main/java/Foo.java 10         Gson gson;"
```

### 2. Dual-Tab Problem

When LS performs edits (Code Action, Organize Imports), VSCode may open a **second tab** for the same file. The two tabs have different buffer states. **Never verify editor content after LS edits** — use `verifyFile` instead.

```yaml
# ❌ BAD — may read from the wrong tab
- action: "open file App.java"
  verifyEditor:
    contains: "import java.io.File"

# ✅ GOOD — checks the file on disk, bypasses dual-tab
- action: "run command File: Save All"
  verifyFile:
    path: "~/src/app/App.java"
    contains: "import java.io.File"
```

### 3. Focus After navigateToError

`navigateToError` leaves focus in the **Problems panel**, not the editor. `Ctrl+.` (Code Action) requires editor focus. The `applyCodeAction` method handles this internally (Ctrl+1 to focus editor), but if you use `run command` for Code Actions, add a focus step first.

### 4. Code Action Label Matching

The Code Action widget uses **partial text matching**. The actual label may include extra info:
- Test plan: `applyCodeAction Create method 'call()'`
- Actual menu: `Create method 'call()' in type 'Foo'`

This works because the framework uses `includes()` matching.

### 5. Snippet Expansion Requires LS

`typeAndTriggerSnippet class` needs the Java extension's snippet provider. If LS is still in "Searching" state, snippets may not appear. The framework retries up to 3 times and falls back to "Insert Snippet" command.

### 6. Completion Position Matters

```yaml
# ❌ BAD — random cursor position, may return only keywords
- action: "triggerCompletion"

# ✅ GOOD — positions cursor inside method body first
- action: "triggerCompletionAt endOfMethod"
```

### 7. Tree Item Visibility (Virtualized Trees)

VSCode uses virtualized lists — off-screen items are NOT in the DOM. If expanding a tree node pushes others off-screen, collapse first:

```yaml
- id: "expand-jdk"
  action: "expand JRE System Library tree item"

- id: "collapse-jdk"     # ← collapse to free space
  action: "expand JRE System Library tree item"

- id: "expand-maven"     # ← now visible
  action: "expand Maven Dependencies tree item"
```

### 8. Rename Verification — File Rename

When renaming a class symbol (e.g., `Foo` → `FooNew`), LS also renames the file. The old editor tab becomes stale. **Close all + double-click the renamed file in Explorer**:

```yaml
- action: "renameSymbol FooNew"
- action: "run command File: Save All"
- action: "run command Workbench: Close All Editors"
- action: "doubleClick FooNew.java"   # ← opens renamed file from Explorer
  verifyEditor:
    contains: "public class FooNew"
```

### 9. Rename via Context Menu (Cross-Platform)

On some platforms, context menu "Rename" triggers VSCode's inline tree rename instead of the extension's `showInputBox`. Use `fillAnyInput` instead of `fillQuickInput` to handle both:

```yaml
- action: "contextMenu AppToRename Rename"
- action: "fillAnyInput AppRenamed"      # ← handles both inline and quick input
  waitBefore: 2
- action: "confirmDialog"                # ← handle optional confirmation
- action: "tryClickButton Apply"         # ← handle optional refactor preview
```

### 10. `verifyFile` Path Resolution

- `~/path` → relative to workspace root (handles worktree paths automatically)
- `absolute/path` → resolved as-is
- Always use `~/` for workspace files — the actual workspace may be in a temp worktree

### 11. Debug Requires Zero Compilation Errors

`startDebugSession` checks problems count immediately after F5. If there are compilation errors, it throws within 1 second instead of waiting 30s for timeout.

### 12. Process Cleanup Between Tests

The framework kills its own VSCode process tree on `close()` via PID tracking. If tests crash, stale `Code.exe` processes may block the next launch. The `run-all` command handles this automatically.

### 13. `--enable-smoke-test-driver` Effects

VSCode is launched with this flag, which:
- Registers `window.driver` with `typeInEditor()` API (EditContext injection)
- **Suppresses notification toasts** (no need to dismiss manually)
- Sets `InAutomationContext` (suppresses some auto-focus behaviors)

### 14. Electron Dialog Auto-Dismiss

The framework automatically monkey-patches `dialog.showMessageBox` to auto-confirm native Electron dialogs (delete confirmations, rename confirmations, etc.). No manual handling needed for these dialogs.

### 15. Sidebar Section Conflicts

When the Java Projects view is inside the Explorer sidebar, other sections (file tree, Outline, Timeline) can consume all the vertical space. Use `collapseSidebarSection` to collapse them before interacting with Java Projects:

```yaml
- action: "collapseSidebarSection OUTLINE"
- action: "collapseSidebarSection TIMELINE"
- action: "run command Java Projects: Focus on Java Projects View"
```

For extension views that live in Explorer, collapse the workspace root itself instead of collapsing the whole Explorer section:

```yaml
- action: "collapseWorkspaceRoot"
- action: "collapseSidebarSection OUTLINE"
- action: "run command Maven: Focus on Maven Projects View"
```

### 16. TreeView Inline Actions

TreeView inline actions are the buttons shown on the right side of a row, usually only after hover/focus/selection. Do not use hard-coded mouse coordinates for these buttons. Use `clickTreeItemAction <item> <label>` so the driver hovers the row, locates the visible action, and clicks it through Playwright mouse events:

```yaml
- action: "expandTreeItem Lifecycle"
- action: "clickTreeItemAction compile Run"
```

Use `expandTreeItem` when you need idempotent expansion. Prefer `click <name> tree item` only when toggling is acceptable.

### 17. Tree Item Name Case Sensitivity

`getByRole("treeitem", { name })` is **case-insensitive**. If the Explorer has a folder called `INVISIBLE` and Java Projects has a node called `invisible`, they will both match. Be aware of this when working with projects whose names match sidebar section headers.

## CLI Options

### `autotest run <plan>`
| Option | Description |
|--------|-------------|
| `--vsix <paths>` | Comma-separated VSIX files to install |
| `--override <kv...>` | Override setup fields (e.g. `--override extensionPath=../../vscode-java`) |
| `--output <dir>` | Output directory (default: `./test-results/<plan-name>`) |
| `--no-llm` | Skip LLM verification |
| `--attach <port>` | Connect to existing VSCode via CDP port |
| `--interactive` | Step-by-step execution with manual confirmation |

### `autotest run-all <dir>`
| Option | Description |
|--------|-------------|
| `--vsix <paths>` | Comma-separated VSIX files (applied to all plans) |
| `--override <kv...>` | Override setup fields for all plans |
| `--output <dir>` | Output directory (default: `./test-results`) |
| `--no-llm` | Skip LLM analysis |
| `--exclude <plans>` | Comma-separated plan names to exclude |

## Test Output

```
test-results/<plan-name>/
├── results.json          # Full report with step results
└── screenshots/
    ├── 01_step-id_before.png
    ├── 02_step-id_after.png    # or _error.png on failure
    └── ...

test-results/
├── summary.md            # Aggregate results table (from run-all)
└── summary.txt           # LLM analysis (if configured)
```

## LLM Configuration (Optional)

```
AZURE_OPENAI_ENDPOINT=https://<resource>.openai.azure.com/
AZURE_OPENAI_API_KEY=<key>
AZURE_OPENAI_DEPLOYMENT=o4-mini
```

- o4-mini: no `temperature` or `max_tokens` params — use `max_completion_tokens` only
- LLM analyzes failed steps (before/after screenshot comparison) and generates aggregate summary
- Not configured → all LLM features silently skipped

## Environment Requirements

- Node.js ≥ 18
- JDK 21+ installed
- `vscode-java` and `eclipse.jdt.ls` repos cloned as siblings
- Close system VSCode before running locally (prevents launch conflicts)
