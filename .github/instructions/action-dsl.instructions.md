---
applyTo: "src/operators/actionResolver.ts"
---

# Action DSL Instructions

`ActionResolver` is the only place that defines user-facing action syntax. It maps action strings to `VscodeDriver` methods and must not contain low-level Playwright UI automation.

## Rules

- Use anchored regexes: `^...$`.
- Put specific patterns before generic patterns.
- Keep syntax English-only.
- Route handlers to Driver methods.
- Trim captured arguments before passing them to Driver methods when whitespace is not meaningful.
- Use `parseActionArgs()` for actions with multiple free-text arguments.
- Keep fallback behavior as Command Palette execution for unmatched actions.
- Do not add ambiguous aliases that hide user intent.

## Preferred pattern

```typescript
{
  regex: /^myAction\s+(.+)$/i,
  handler: async (m) => { await d.myAction(m[1].trim()); },
}
```

## Multiple free-text arguments

Use quoted arguments instead of ad-hoc `split(" ")` logic:

```yaml
action: 'contextMenu "Maven Dependencies" "Add JAR"'
action: 'clickTreeItemAction "Lifecycle" "Run"'
```

## Behavior conventions

- `click <name> tree item` may toggle.
- `expandTreeItem <name>` must be idempotent and leave the item expanded.
- `applyCodeAction <label>` must fail if the requested label is not found.
- `triggerCompletionAt <position>` must honor the requested position or fail with a useful message.

Update `README.md` and `AGENTS.md` when action syntax changes.
