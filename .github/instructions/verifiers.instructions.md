---
applyTo: "src/{operators/stepVerifier,types}.ts"
---

# Verifier Instructions

`StepVerifier` runs deterministic checks and is the only pass/fail authority for test step verification. LLM analysis is diagnostic only.

## Adding a verifier

1. Add the verification field type in `src/types.ts`.
2. Add a private verifier method in `src/operators/stepVerifier.ts`.
3. Call the verifier from `verify()` in a sensible order.
4. Return precise failure reasons with expected and observed values.
5. Poll when VS Code, Java LS, terminal, or test state updates asynchronously.
6. Document the field in `README.md` and `docs/architecture.md`.
7. Add or update a representative test plan when the verifier is user-facing.

## Rules

- Prefer direct state checks over screenshots or visual inference.
- Use Driver methods instead of duplicating low-level Playwright selectors when possible.
- Fail fast with a useful reason.
- Do not use LLM output to mark a step passed.
- Do not silently ignore invalid verifier input.
- For workspace files, support `~/`, `${workspaceFolder}`, and `${workspaceParent}` consistently.
- For LS-driven file edits, prefer filesystem checks over editor-buffer checks.

## Existing verifier categories

- `verifyFile`
- `verifyNotification`
- `verifyEditor`
- `verifyProblems`
- `verifyCompletion`
- `verifyQuickInput`
- `verifyDialog`
- `verifyTreeItem`
- `verifyEditorTab`
- `verifyOutputChannel`
- `verifyTerminal`
