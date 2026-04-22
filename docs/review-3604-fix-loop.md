# Process Review: Issue #3604 Fix Loop

## Overview

We attempted a full autotest validation loop for [eclipse.jdt.ls #3604](https://github.com/eclipse-jdtls/eclipse.jdt.ls/issues/3604) (annotation completion proposes invalid choices). The loop was: **find issue → design test plan → run autotest to confirm bug → analyze root cause → implement fix → rebuild → rerun to confirm fix**.

The loop completed end-to-end. The initial runs had a critical gap in completion capture (reading word-based completions instead of LS completions), but after fixing the autotest framework, the before/after comparison is now fully validated with correct LS completions.

### Final Before/After Comparison

| Run | Extension | Completion Items | Test Result |
|-----|-----------|-----------------|-------------|
| **Before** (run3) | Marketplace (unpatched) | `[Bar, class]` | ❌ FAIL — missing `true`/`false` |
| **After** (run4) | Dev build (patched jdt.ls) | `[true, false]` | ✅ PASS — 6/6 |

The screenshots clearly show the difference:
- **Before**: Suggest widget shows `Bar` (TYPE_REF) and `class` (keyword) — invalid for boolean annotation attribute
- **After**: Suggest widget shows `true` and `false` — correct boolean literals

## What Went Well

| Phase | Details |
|-------|---------|
| **Issue selection** | Searched 4 repos, ranked candidates by autotest suitability — efficient |
| **Test plan design** | YAML plan was well-structured: waitForLS → open file → insert code → trigger completion |
| **Framework enhancement** | Added `excludes` field to `CompletionVerification` — reusable for future tests |
| **Artifact management** | Screenshots and results.json saved for both runs, easy to compare |

## Critical Problem: Completion Capture

### Symptom

Both Run 1 (marketplace extension, no fix) and Run 2 (dev extension, with fix) returned the same type of completions:

```
Got: [src\, main\, java\, org\, sample, Bar.java, target, pom.xml, Bar, class...]
```

These are **word-based completions** (file names, package path segments, words from the document), NOT Java Language Server completions.

### Root Cause

`triggerCompletion()` in `vscodeDriver.ts` (line ~918):

```typescript
async triggerCompletion(): Promise<string[]> {
  await page.keyboard.press(TRIGGER_SUGGEST_KEY);      // Ctrl+Space
  await page.locator(SUGGEST_WIDGET_SELECTOR)
    .waitFor({ state: "visible", timeout: ... });       // Widget appears with word completions
  const items = await page.locator(".monaco-list-row .label-name")
    .allTextContents();                                  // Read immediately → word completions!
  return items;
}
```

The problem: VSCode's suggest widget shows word-based completions **instantly**, while Java LS completions arrive **asynchronously** (1–5 seconds later). The code reads items as soon as the widget is visible, capturing only word completions.

### Impact

- **Run 1 "bug confirmed"** — Failed because `true` wasn't in word completions, not because JDT returned wrong methods
- **Run 2 "fix confirmed"** — Passed because word completions never contain `equals`/`hashCode` — our fix was irrelevant

### Fix

`triggerCompletion()` needs a **stabilization wait**: after the widget appears, poll the item list until it stops changing (indicating all completion providers have responded), then read.

## What Was Unnecessary or Over-Invested

| Item | Issue |
|------|-------|
| **140-line Java fix** | For validating the autotest framework, a 10-line filter would suffice. The full JLS §9.7.1 implementation with backward source scanning was over-engineered for the demo purpose |
| **Deep root cause trace** | Used explore agent to trace the entire completion code path. Useful for understanding, but overkill for "validate autotest works" |
| **Rubber-duck review of Java fix** | Reviewed code quality of the fix, but missed the fundamental issue (test can't capture LS completions) |

## Build Phase: 6 Failures Before Success

The build phase was the most time-consuming part, with this failure chain:

1. `mvnw` direct build → target platform artifact unresolvable
2. `gulp dev_server` → npm not installed in vscode-java
3. `npm install` + `gulp dev_server` → offline mode, P2 cache empty
4. `mvnw` online → 4.39-I-builds URL doesn't exist (stale reference)
5. Fixed target platform URL → core built, but `server/` directory missing
6. `gulp build_server` → success, then needed `npm run compile` for TypeScript

**Lesson**: Should have verified the build→load→autotest pipeline **before** implementing any fix.

## Optimization Proposal

### For Future Fix Loops

```
Phase 0: Validate toolchain (do this ONCE, before any issue)
  ├─ Can we build vscode-java with local jdt.ls? (gulp build_server)
  ├─ Does extensionDevelopmentPath load correctly in autotest?
  ├─ Does triggerCompletion capture LS completions? (not just word completions)
  └─ Document the working build + test commands

Phase 1: Select issue + design test plan
Phase 2: Run test plan with marketplace extension → confirm bug (before)
Phase 3: Implement minimal fix
Phase 4: Rebuild + run test plan with dev extension → confirm fix (after)
```

### For Autotest Framework

1. **Fix `triggerCompletion()` stabilization** — Poll items until they stop changing before returning
2. **Add completion source filtering** — Option to capture only LS completions (by icon type) vs word completions
3. **Add `waitForCompletion` option** — Explicit wait time after widget appears, configurable per step
4. **Build system documentation** — Document the vscode-java build commands and common failure modes

## Files Modified During This Loop

| File | Change |
|------|--------|
| `javaext-autotest/src/types.ts` | Added `excludes?: string[]` to CompletionVerification |
| `javaext-autotest/src/operators/stepVerifier.ts` | Implemented excludes check in verifyCompletion() |
| `javaext-autotest/test-plans/java-annotation-completion-bug.yaml` | Test plan for #3604 |
| `eclipse.jdt.ls/.../CompletionProposalRequestor.java` | Annotation context filter (the actual fix) |
| `eclipse.jdt.ls/.../org.eclipse.jdt.ls.tp.target` | Fixed stale P2 repo URL |

## Artifacts

- `files/run1-bug-confirmed/` — results.json + 12 screenshots (marketplace extension, word-based capture — superseded)
- `files/run2-fix-confirmed/` — results.json + 12 screenshots (dev extension, word-based capture — superseded)
- `files/run3-before-fixed-capture/` — results.json + 12 screenshots (**correct LS capture**, marketplace, FAIL: `[Bar, class]`)
- `files/run4-after-fixed-capture/` — results.json + 12 screenshots (**correct LS capture**, dev build with fix, PASS: `[true, false]`)
- `test-plans/java-annotation-completion-bug.yaml` — Test plan (dev build)
- `test-plans/annotation-completion-before.yaml` — Test plan (marketplace)
