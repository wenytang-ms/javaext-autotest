# Test Plan Coverage Audit

## Purpose

This document audits every wiki test scenario against the actual YAML test plan implementation, identifying gaps where core functionality was bypassed, simplified, or left unverified.

## Full Audit Table

| Wiki Scenario | Wiki Step | What Wiki Requires | What YAML Does | Gap/Issue |
|---|---|---|---|---|
| Basic #3 | `class` snippet | Invoke `class` code snippet in `Foo.java`, reduce problems to 1 | `java-basic-editing.yaml` inserts full class body via disk edit | **Snippet UI flow replaced** with direct file edit |
| Basic #4 | Code Action fix | Click `Create method 'call()' in type Foo'` via Code Action lightbulb | `java-basic-editing.yaml` inserts `call()` via disk edit | **Code Action replaced** with direct disk edit |
| Basic #5 | Force compilation | Save all, run `Java: Force Java compilation`, expect no errors | `java-basic-editing.yaml` only does Save All + checks problems=0 | **Force compilation skipped** |
| Basic #6 | File completion + 2 errors | Type `File f = new File("demo.txt");`, completion works for File, **two** errors remain | `java-basic-extended.yaml` inserts text, checks `errors >= 1` after save | **Completion not verified during typing**; error count weaker than wiki |
| Basic #7 | Organize Imports | Use `Source Action... → Organize Imports` or F1 → Organize Imports | `java-basic-extended.yaml` inserts `import java.io.File;` via disk edit | **Organize Imports command replaced** with direct file edit |
| Basic #8 | Rename Symbol | Rename `Foo` → `FooNew` via editor, then back via Explorer, verify all references updated | `java-basic-extended.yaml` only opens `Foo.java` and checks content | **Rename skipped entirely** |
| Basic #9 | New File snippet | Right-click folder → New File → `Hello.java`, verify generated class snippet | `java-new-file-snippet.yaml` creates file on disk and checks body text | **Explorer right-click + snippet generation not exercised** |
| Maven | LS + warnings + editing experience | See several warnings, diagnostics/completion/code actions all work | `java-maven.yaml` checks completion and inserts unused import | Initial warning state not checked; **code actions omitted** |
| Maven Multimodule | Both modules' editing experience | Verify both modules with diagnostics, completion, code actions | `java-maven-multimodule.yaml` checks errors=0 and completion only | **Warnings, diagnostics, and code actions skipped** |
| Gradle | Editing experience incl. code actions | Verify no problems, diagnostics/completion/code actions | `java-gradle.yaml` checks errors=0 and completion only | **Code actions skipped** |
| Single file | Empty folder + Test.java + snippets | Create empty folder, add `Test.java`, use `class`/`main` snippets, verify editing | `java-single-file.yaml` uses existing `App.java`, checks completion + typed text | **Empty-folder/Test.java/class+main snippets skipped** |
| Single file without workspace | Drag file + basic edit + debug | Drag `App.java` into empty window, basic edit, **debug** works | `java-single-no-workspace.yaml` uses direct file mode, basic edit/completion only | **Debug step skipped** |
| Fresh import | Spring Petclinic **and** gs-spring-boot/complete | Both fresh-import scenarios should be exercised | `java-fresh-import.yaml` covers only Spring Petclinic | **Second repo (gs-spring-boot) skipped** |
| Debugger | Breakpoint hit + program output | Start debug, **verify breakpoint is hit** and program output is correct | `java-debugger.yaml` sets breakpoint, starts debug, waits 5s, stops | **Breakpoint hit and output not deterministically verified** |
| Test Runner | Show tests + Run All + CodeLens | Test explorer shows cases, Run All works, CodeLens appears, Run Test via CodeLens | `java-test-runner.yaml` opens explorer, runs all, waits, checks for CodeLens | **No deterministic proof tests ran or CodeLens exists** |
| Maven for Java | Resolve unknown type | Hover shows "Resolve unknown type", Code Action adds dependency to `pom.xml` **and** import | `java-maven-resolve-type.yaml` hovers and applies action | **pom.xml and import changes not deterministically verified** |
| Java Dependency Viewer | Sources + JDK Libraries + Maven Dependencies + add/remove libs | Verify all dependency nodes; add/remove referenced libs; errors disappear | `java-dependency-viewer.yaml` only opens explorer and checks one node | **JDK Libraries/Maven Dependencies/add-remove/error disappearance skipped** |
| Java Extension Pack | Configure Classpath details | Verify source paths, output path, referenced libraries configuration | `java-extension-pack.yaml` only checks command triggers and page appears | **Configuration fields not verified** (webview limitation) |

## Gap Classification

### 1. Core Functionality Replaced with Disk Edits (3 cases)

These wiki steps require testing VSCode UI interactions but were bypassed with direct file modifications:

| Step | Required UI | Current Implementation |
|------|------------|----------------------|
| Basic #3: class snippet | `typeAndTriggerSnippet class` → generate class skeleton | `insertLineInFile` writes class body directly |
| Basic #4: Code Action | `navigateToError` → `applyCodeAction` → generate method | `insertLineInFile` writes `call()` directly |
| Basic #7: Organize Imports | Command Palette → `Organize Imports` | `insertLineInFile` writes import directly |

**Root cause**: `insertLineInFile` modifies the temp workspace, but Code Action/Organize Imports open the original file path, causing conflicts.

### 2. UI Interactions Skipped Entirely (3 cases)

| Step | What's Missing |
|------|---------------|
| Basic #8: Rename Symbol | No rename operation at all — needs F2 → type new name → verify references |
| Basic #5: Force Compilation | `Java: Force Java Compilation` command + Quick Pick selection not executed |
| Basic #9: New File via Explorer | Right-click → New File → type name flow not exercised |

### 3. Verification Too Weak / Auto-Pass (4 cases)

| Step | What Wiki Verifies | What YAML Verifies |
|------|-------------------|-------------------|
| Debugger: breakpoint | Breakpoint is hit, program output correct | Only `wait 5 seconds` — no check |
| Test Runner: results | Tests pass, CodeLens visible | Only `wait` — no deterministic check |
| Maven for Java: result | pom.xml changed, import added | Only applies action — no file check |
| Dependency Viewer: nodes | Sources, JDK libs, Maven deps all visible | Only opens view and checks one node |

### 4. Environment/Scope Differences (3 cases)

| Step | Wiki | YAML |
|------|------|------|
| Maven/Gradle Java 11 | Test with JDK 11 | Changed to JDK 25 (intentional upgrade) |
| Fresh import | Two repos (petclinic + gs-spring-boot) | Only petclinic |
| Single file | Create empty folder + Test.java | Uses existing App.java from simple-app |

## Priority for Fixing

| Priority | Items | Effort |
|----------|-------|--------|
| 🔴 High | Rename Symbol, Code Action (real UI), Organize Imports (real command) | Medium — needs fixing temp workspace path issue |
| 🟡 Medium | Debugger breakpoint verification, Test Runner result verification | Low — add `waitForBreakpointHit()` / `getTestResults()` checks |
| 🟢 Low | Dependency Viewer full nodes, Extension Pack fields, second fresh-import repo | Low — add more tree item checks |
| ⚪ Won't fix | Explorer right-click New File (unstable), Force Compilation Quick Pick (inconsistent) | — |
