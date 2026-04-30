---
applyTo: "test-plans/**/*.yaml"
---

# Test Plan Instructions

Test plans are declarative YAML files. They should describe user scenarios through stable action syntax and deterministic verification fields.

## Path rules

- Setup paths are resolved relative to the test plan file.
- `~/path` means the runtime workspace root.
- `${workspaceFolder}` means the runtime workspace root.
- `${workspaceParent}` means the parent directory of the runtime workspace.
- Prefer `~/` for workspace files because tests run in isolated temp workspaces or git worktrees.

## Editing rules

- Use `insertLineInFile` for Java code changes that the language server must analyze.
- Use `typeInEditor` only for text where language-server analysis is not required.
- After language-server edits such as code actions, organize imports, or rename, prefer `verifyFile` over `verifyEditor`.
- Use `run command File: Save All` before verifying file contents after LS-driven edits when needed.

## Action rules

- Use `expandTreeItem <name>` for idempotent tree expansion.
- Use `click <name> tree item` only when toggling is acceptable.
- Quote action arguments that contain spaces:

```yaml
action: 'contextMenu "Maven Dependencies" "Add JAR"'
```

- Prefer deterministic waits such as `waitForLanguageServer` or `waitForTestDiscovery` over static `wait <n> seconds`.
- Keep step IDs unique, descriptive, and kebab-case.

## Verification rules

- Add deterministic verification whenever possible.
- Use `verifyProblems` for compiler/problem expectations.
- Use `verifyFile` for generated or modified files.
- Use `verifyTerminal` or `verifyOutputChannel` for build/test command output.
- Keep `verify` as human/LLM context; it does not decide pass/fail by itself.
