# Roadmap — VSCode AutoTest

## Overall goal

Enable Copilot CLI and `autotest` to run VS Code extension E2E tests from declarative test plans, verify results, capture artifacts, and provide useful failure analysis.

---

## Phase 1: Foundation

> Status: **Done**

- [x] Project bootstrap with TypeScript and npm.
- [x] VscodeDriver core: Playwright Electron launch and shutdown.
- [x] Basic operation primitives:
  - [x] `runCommandFromPalette()` for Command Palette execution.
  - [x] `openFile()` for Quick Open.
  - [x] `getEditorContent()` for editor content reads.
  - [x] `saveFile()` / `pressKeys()` for saves and keyboard shortcuts.
  - [x] `runInTerminal()` for terminal commands.
- [x] UI interaction primitives:
  - [x] `activeSideTab()` for side bar switching.
  - [x] `clickTreeItem()` / `isTreeItemVisible()` for TreeView operations.
  - [x] `selectPaletteOption()` for palette option selection.
  - [x] `getNotifications()` for notification reads.
- [x] Snapshot capabilities:
  - [x] `snapshot()` for accessibility tree snapshots.
  - [x] `domSnapshot()` for DOM snapshots.
  - [x] `screenshot()` for screenshot capture.
- [x] Basic verification:
  - [x] `isElementVisible()` for element visibility.
  - [x] `fileExists()` / `fileContains()` for file checks.

---

## Phase 2: Test plan engine

> Status: **Done**

- [x] YAML test plan parser (`planParser.ts`).
- [x] Test plan validation (`validate` command).
- [x] Test execution engine (`testRunner.ts`):
  - [x] Setup phase: extension loading, workspace configuration, settings injection.
  - [x] Sequential step execution: action matching → execution → verification.
  - [x] Deterministic verification: `verifyFile`, `verifyNotification`, `verifyEditor`.
- [x] CLI entry points (`run` / `validate`).
- [x] JSON report output.
- [x] Example test plan.

---

## Phase 3: Java extension testing capability

> Status: **Done**

- [x] Wiki test plan scenarios converted to YAML.
- [x] Java / language-server Driver primitives:
  - [x] `typeInEditor()` for editor text input through Monaco / smoke-test APIs.
  - [x] `setEditorContent()` / `selectAllInEditor()` for editor replacement.
  - [x] `typeAndTriggerSnippet()` for snippet triggering.
  - [x] `waitForLanguageServer()` for language-server readiness polling.
  - [x] `getProblemsCount()` for Problems error/warning counts.
  - [x] `navigateToError()` / `navigateToNextError()` for diagnostic navigation.
  - [x] `applyCodeAction()` for Code Action execution.
  - [x] `triggerCompletion()` / `dismissCompletion()` for completion.
  - [x] `goToLine()` for Ctrl+G line navigation.
  - [x] `goToEndOfLine()` for end-of-line navigation.
  - [x] `insertLineInFile()` for disk writes followed by `File: Revert`.
  - [x] `editorContains()` for editor content checks.
- [x] 50+ action regex patterns.
- [x] Additional verification types:
  - [x] `verifyProblems` for exact / at-least problem counts with polling.
  - [x] `verifyCompletion` for completion list checks.
- [x] VS Code 1.115 compatibility fixes:
  - [x] Command Palette locator `.quick-input-box input`.
  - [x] Preserve the `>` command-mode prefix.
  - [x] Preserve the `:` line-navigation prefix.
- [x] Workspace isolation:
  - [x] Copy workspaces to a temporary location.
  - [x] Clean stale temporary directories with retry logic.
- [x] Screenshot system:
  - [x] Capture before/after/error screenshots per step.
  - [x] Clear stale output for every run.
- [x] Event-driven waits:
  - [x] Quick Input visible/hidden.
  - [x] Suggest widget visible/hidden.
  - [x] Workbench readiness.
  - [x] Tree item visibility.
- [x] Process lifecycle management:
  - [x] Clear user-data directory before launch.
  - [x] Inject `window.restoreWindows: none`.
  - [x] Handle SIGINT/SIGTERM.
  - [x] Retry `close()`.
- [x] Preserve action argument casing with case-insensitive matching.
- [x] Resolve paths relative to the test plan file.
- [x] Retry Quick Open while file indexing is still settling.

---

## Phase 4: Architecture split, LLM analysis, and Copilot CLI integration

> Status: **Done**

### 4a. Architecture split

The former TestRunner god class was split into focused modules:

- [x] `ActionResolver`: action string → Driver call mapping through 50+ regex patterns, with Command Palette fallback.
- [x] `StepVerifier`: 10+ deterministic checks covering file, editor, problems, completion, notifications, Quick Input, dialogs, tree items, editor tabs, output channels, and terminals.
- [x] `LLMClient`: Azure OpenAI client wrapper.
- [x] `TestRunner`: thin orchestration layer for launch → execute → screenshot → report.

### 4b. LLM failure screenshot analysis

- [x] Azure OpenAI integration: before/after screenshot base64 → reasoning + suggestion.
- [x] Environment-variable configuration: `AZURE_OPENAI_ENDPOINT`, `AZURE_OPENAI_API_KEY`, `AZURE_OPENAI_DEPLOYMENT`.
- [x] Auto-skip when not configured.
- [x] `--no-llm` option to force-disable analysis.
- [x] Deterministic verification decides pass/fail; LLM analysis only runs after failures and uses `verify` plus before/after screenshots as context.

### 4c. Copilot CLI integration

- [x] `AGENTS.md` project guide with CLI options, test plan guidance, and screenshot-analysis notes.
- [x] Root `AGENTS.md` as the agent entry point.

### AI enhancement backlog

- [ ] AI action mapping fallback: let AI plan Driver calls for unmatched actions.
- [ ] Expand the action dictionary from historical action → Driver mappings.

---

## Phase 5: Native Markdown test plan support

> Status: **Not started** · Priority: High

Allow Copilot CLI / `autotest` to read wiki Markdown test plans directly without manual YAML conversion.

- [ ] Markdown test plan parser:
  - [ ] Parse `## Scenario` headings.
  - [ ] Parse ordered lists (`1.`, `2.`, `3.`) into steps.
  - [ ] Recognize inline code blocks as input data.
  - [ ] Recognize words such as "check", "verify", and "should" as verification hints.
- [ ] Structured annotation scheme:
  - [ ] Support HTML comments such as `<!-- autotest:action ... -->`.
  - [ ] Keep Markdown human-readable.
- [ ] Copilot CLI orchestration entry point:
  - [ ] `copilot-test run --wiki-plan Test-Plan.md --scenario "Basic"`.
  - [ ] Extract a scenario, convert it to an internal TestPlan object, and execute it.
- [x] Wiki test plan coverage:
  - [x] Basic #1-5: `java-basic-editing.yaml`.
  - [x] Basic #6-8: merged into `java-basic-editing.yaml`.
  - [x] Basic #9 (New Java File): `java-new-file-snippet.yaml`.
  - [x] Maven: `java-maven.yaml`.
  - [x] Maven Multimodule: `java-maven-multimodule.yaml`.
  - [x] Gradle: `java-gradle.yaml`.
  - [x] Maven Java 25: `java-maven-java25.yaml`.
  - [x] Gradle Java 25: `java-gradle-java25.yaml`.
  - [x] Single file: `java-single-file.yaml`.
  - [x] Single file without workspace: `java-single-no-workspace.yaml`.
  - [x] Fresh import: `java-fresh-import.yaml` (requires Spring Petclinic to be cloned first).
  - [x] Debugger for Java: `java-debugger.yaml`.
  - [x] Java Test Runner: `java-test-runner.yaml`.
  - [x] Maven for Java: `java-maven-resolve-type.yaml`.
  - [x] Java Dependency Viewer: `java-dependency-viewer.yaml`.
  - [x] Java Extension Pack: `java-extension-pack.yaml`.

---

## Phase 6: Runtime environment and CI integration

> Status: **Not started** · Priority: Medium

- [ ] Attach mode: connect to an existing VS Code instance over CDP.
- [ ] Automatic project preparation:
  - [ ] Clone GitHub test projects.
  - [ ] Detect and switch JDK versions.
- [ ] CI/CD integration:
  - [ ] GitHub Actions workflow template.
  - [ ] Upload test results as artifacts.
  - [ ] HTML report generation.
- [ ] Parallel execution for multiple scenarios.

---

## Phase 7: Driver capability expansion

> Status: **Done**

Most non-Webview Driver capabilities are implemented: 70+ Driver methods and 50+ action patterns covering files, editor, TreeView, Quick Input/Dialog, code intelligence, Debug, Test Runner, terminal, and output channels.

### Debugger for Java

| Capability | Description | Status |
|------------|-------------|--------|
| `startDebugSession(config)` | Start debugging through Command Palette / F5 | Implemented |
| `setBreakpoint(file, line)` | Set a breakpoint at a line | Implemented |
| `waitForBreakpointHit()` | Wait for debugger pause state | Implemented |
| `getDebugVariables()` | Read Variables panel name/value pairs | Implemented |
| `debugStepOver/Into/Out()` | Debug stepping | Implemented |
| `getDebugConsoleOutput()` | Read Debug Console / panel text | Implemented |
| `stopDebugSession()` | Stop debugging | Implemented |

### Java Test Runner

| Capability | Description | Status |
|------------|-------------|--------|
| `openTestExplorer()` | Open Test Explorer | Implemented |
| `runAllTests()` | Run all tests | Implemented |
| `getTestResults()` | Get pass/fail/total counts | Implemented |
| `clickCodeLens(label)` | Click a CodeLens action such as "Run Test" | Implemented |
| `waitForTestComplete()` | Wait for test execution to finish | Implemented |

### Hover and context interactions

| Capability | Description | Status |
|------------|-------------|--------|
| `hoverOnSymbol(text)` | Hover on a source symbol | Implemented |
| `getHoverContent()` | Read hover popup content | Implemented |
| `clickHoverAction(label)` | Click an action link in a hover popup | Implemented |
| `followQuickPick(steps)` | Follow multi-step Quick Pick flows | Covered by palette-selection primitives |

### File Explorer interactions

| Capability | Description | Status |
|------------|-------------|--------|
| `rightClickTreeItem(name)` | Right-click a file tree item | Implemented through context-menu primitives |
| `selectContextMenuItem(label)` | Select a context menu item | Implemented |
| `createNewFile(name)` | Create a file through Explorer | Implemented |

### Java Dependency Viewer

| Capability | Description | Status |
|------------|-------------|--------|
| `openDependencyExplorer()` | Open Java Dependencies view | Implemented |
| `expandTreeNode(path)` | Expand nested tree nodes | Implemented through repeated tree expansion |
| `verifyTreeNodeExists(path)` | Verify node existence | Implemented through tree item verification |

### Webview interactions

| Capability | Description | Status |
|------------|-------------|--------|
| `switchToWebview()` | Enter a webview iframe | Complex; not generally implemented |
| `interactWithWebview(selector)` | Operate inside a webview | Complex; requires frame-specific implementation |
| `getWebviewContent()` | Read webview content | Complex; requires frame-specific implementation |

### Feasibility summary

| Category | Required capabilities | Supported | Partial/complex |
|----------|-----------------------|-----------|-----------------|
| Debugging | 7 | 7 | 0 |
| Test Runner | 5 | 5 | 0 |
| Hover/context | 4 | 4 | 0 |
| File Explorer | 3 | 3 | 0 |
| Dependency tree | 3 | 3 | 0 |
| Webview | 3 | 0 | 3 |

> **Conclusion**: Playwright Electron covers most Java extension E2E scenarios. Webview interaction remains the hardest area because of iframe nesting and extension-specific DOM structures.

---

## Phase 8: Test plan audit fixes

> Status: **In progress** · Priority: High
>
> See [test-plan-audit.md](test-plan-audit.md) for the detailed audit.

### Framework fixes

- [x] `renameSymbol(newName)`: F2 rename Driver method.
- [x] `organizeImports()`: Shift+Alt+O Driver method.
- [x] Temporary workspace path issue: solved with git worktrees so files, the language server, and the UI operate on the same workspace path.
- [ ] Code Action duplicate content issue: `typeAndTriggerSnippet` can generate a class body in one tab while Code Action edits another tab, and Save All can merge stale state into a duplicate method. More precise tab management is needed.
- [ ] `getProblemsCount` timing issue: status bar codicon text can update late, so polling may read a stale count.

### Test plan fixes: restore real UI operations

- [x] Basic #3 class snippet: `typeAndTriggerSnippet class` works.
- [x] Basic #4 Code Action: `applyCodeAction` + `navigateToError` works, with the duplicate-method caveat above.
- [ ] Basic #7 Organize Imports: `organizeImports()` exists and needs continued validation in worktree mode.
- [x] Basic #8 Rename Symbol: `renameSymbol` Driver exists and works when `Foo.java` has content.
- [ ] Basic scenario: keep the combined Basic plan stable across shared workspace state.

### Test plan fixes: strengthen deterministic verification

- [ ] Debugger: replace `wait 5 seconds` with `waitForBreakpointHit()` and verify the breakpoint is actually hit.
- [ ] Test Runner: use `waitForTestComplete()` + `getTestResults()` to verify test pass counts.
- [ ] Maven for Java: add `verifyEditor` for imports and `verifyFile` for `pom.xml`.
- [ ] Dependency Viewer: add tree item checks for JDK Libraries and Maven Dependencies.

### Known limitations

- Basic #9 Explorer New File: snippets require the VS Code new-file flow; direct disk creation cannot fully simulate that path.
- Basic #5 Force Compilation: the Quick Pick may not appear when there are zero errors, so behavior is inconsistent.
- Extension Pack Classpath configuration: webview internals are not generally supported.

---

## Phase 9: Stability and extension

> Status: **Not started** · Priority: Low

- [ ] Window-focus hardening:
  - [ ] Headless mode via `xvfb-run` on Linux.
  - [ ] Windows virtual desktop isolation.
  - [ ] Extra retry logic for blur-sensitive components.
- [ ] Step retry mechanism with configurable retry counts.
- [ ] Conditional skips based on platform or JDK version.
- [ ] Interactive mode (`--interactive`) for step-by-step manual confirmation.
- [ ] Automatic test plan repair suggestions after failures.
- [ ] Extend to non-Java VS Code extensions.
- [ ] Unit test coverage with Vitest.

---

## Milestone overview

| Milestone | Status | Key deliverables |
|-----------|--------|------------------|
| M1: Usable framework | Done | CLI + YAML plan + Playwright Driver |
| M2: Java POC | Done | Wiki-to-YAML conversion + Java operation primitives |
| M3: End-to-end runnable | Done | Java plan execution, workspace isolation, screenshots, event-driven waits |
| M4: LLM analysis + architecture split | Done | ActionResolver / StepVerifier / LLMClient split, Azure OpenAI integration, Copilot CLI `AGENTS.md` |
| M5: Run tests from wiki | Planned | Copilot CLI reads Markdown and runs fully automated tests |
| M6: CI integration | Planned | GitHub Actions, HTML reports, parallel execution |
| M7: Driver expansion | Done | Debugging, Test Runner, Hover, dependency tree, file explorer, Rename, Organize Imports |
| M8: Wiki coverage | Done | 16/16 scenarios, 16+ test plans, 90+ steps |
| M9: Audit fixes | In progress | Restore real UI operations, strengthen verification, harden workspace-path behavior |
