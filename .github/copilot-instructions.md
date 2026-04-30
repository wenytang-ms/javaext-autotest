# Copilot Instructions for javaext-autotest

This repository is an AI-assisted VS Code extension E2E testing framework. Keep test plans declarative, keep action parsing deterministic, and isolate VS Code UI automation details inside the Driver layer.

## Architecture boundaries

- `src/operators/planParser.ts` parses YAML and resolves setup paths.
- `src/operators/testRunner.ts` orchestrates launch, step execution, screenshots, reports, and optional LLM failure analysis.
- `src/operators/actionResolver.ts` owns the action DSL and maps action strings to `VscodeDriver` methods.
- `src/operators/stepVerifier.ts` owns deterministic verification and is the only pass/fail authority.
- `src/drivers/vscodeDriver.ts` owns VS Code lifecycle, workspace isolation, process cleanup, and shared Driver state.
- `src/drivers/operations/*.ts` contains function-specific Driver operation mixins.
- `src/operators/llmClient.ts` is diagnostic only; LLM output must not decide pass/fail.

## Required design rules

- Do not put Playwright UI automation directly in `ActionResolver` or `TestRunner`.
- Do not parse action strings inside `VscodeDriver` or operation modules.
- Prefer VS Code commands, command IDs, and accessibility roles before CSS selectors.
- Avoid hard-coded coordinates and timing-only fixes.
- Required actions must fail loudly with useful errors. Only explicitly named `try*` methods may silently no-op.
- Preserve the public `VscodeDriver` API unless the breaking change is intentional and documented.
- Keep documentation in English and update it when behavior changes.

## Validation

Run `npm run build` after TypeScript changes.

For action, verifier, setup, or plan changes, validate relevant plans:

```powershell
npx autotest validate test-plans\<plan>.yaml
```

For broad DSL or parser changes, validate all plans:

```powershell
Get-ChildItem test-plans -Filter *.yaml | ForEach-Object { npx autotest validate $_.FullName }
```

## Reference documents

- `AGENTS.md` has detailed AI-agent guidance for this repository.
- `CONTRIBUTING.md` has contributor workflows and extension checklists.
- `docs/architecture.md` explains the current system design.
