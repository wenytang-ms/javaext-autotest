# javaext-autotest — AI Agent Guide

AI-driven VSCode extension E2E testing framework. This guide helps LLM agents create, modify, and debug test plans without repeating known pitfalls.

## Quick Commands

```bash
cd javaext-autotest

# Run a single test plan
npx autotest run test-plans/java-maven.yaml

# Run all test plans with aggregate summary
npx autotest run-all test-plans --exclude java-fresh-import

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
- **StepVerifier** — Deterministic verification (file, editor, problems, completion, notification)
- **LLMClient** — Azure OpenAI for post-failure screenshot analysis (optional)

## Test Plan YAML Structure

```yaml
name: "Plan Name"
description: "What this tests"
setup:
  extension: "redhat.java"
  extensions: ["vscjava.vscode-java-pack"]
  vscodeVersion: "stable"
  workspace: "../../relative/path/to/project"   # relative to plan file
  # file: "../../path/to/File.java"             # single-file mode (no workspace)
  # repos: [{url: "...", path: "..."}]          # auto-clone repos
  timeout: 90
  settings:                                      # injected into VSCode settings.json
    java.jdt.ls.java.home: "C:\\path\\to\\jdk"

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
| `captureFileMtime <key> <path>` | Snapshot current mtime for a later `verifyFile: { mtimeAfter: "<key>" }` assertion. Missing file captures `0`. |

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

### UI Operations
| Action | Description |
|--------|-------------|
| `run command <Command Name>` | Execute via Command Palette (F1) |
| `click <name> tree item` | Single-click tree node |
| `doubleClick <name> tree item` | Double-click to open file from Explorer |
| `select <name> option` | Select from Quick Pick dropdown |
| `wait <n> seconds` | Static wait |

### Debug
| Action | Description |
|--------|-------------|
| `startDebugSession` | F5 — throws if build errors or toolbar doesn't appear |
| `stopDebugSession` | Shift+F5 — safe if no session active |
| `setBreakpoint <line>` | Toggle breakpoint at line |
| `debugStepOver` / `debugStepInto` / `debugStepOut` | Throws if no active session |

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

### 9. `verifyFile` Path Resolution

- `~/path` → relative to workspace root (handles worktree paths automatically)
- `absolute/path` → resolved as-is
- Always use `~/` for workspace files — the actual workspace may be in a temp worktree

Supported assertion fields:

| Field | Meaning |
|-------|---------|
| `exists: false` | File must NOT exist |
| `contains: "<text>"` | File must contain the literal substring |
| `matches: "<regex>"` | File must match the JS regex (no multi-line flag; use `[\s\S]` if needed) |
| `mtimeAfter: <n \| "key">` | File's mtime must be strictly greater than a numeric epoch-ms threshold, or the value captured earlier via `captureFileMtime <key> <path>` |
| `mtimeUnchangedSince: "<key>"` | File's mtime must be ≤ the previously captured value (asserts file was NOT modified) |


### 10. Debug Requires Zero Compilation Errors

`startDebugSession` checks problems count immediately after F5. If there are compilation errors, it throws within 1 second instead of waiting 30s for timeout.

### 11. Process Cleanup Between Tests

The framework kills its own VSCode process tree on `close()` via PID tracking. If tests crash, stale `Code.exe` processes may block the next launch. The `run-all` command handles this automatically.

### 12. `--enable-smoke-test-driver` Effects

VSCode is launched with this flag, which:
- Registers `window.driver` with `typeInEditor()` API (EditContext injection)
- **Suppresses notification toasts** (no need to dismiss manually)
- Sets `InAutomationContext` (suppresses some auto-focus behaviors)

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
