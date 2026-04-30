# Contributing

This project uses declarative YAML plans plus a stable VS Code Driver API. Contributions should preserve that architecture: test plans stay readable, action parsing stays deterministic, and VS Code UI details stay inside Driver operations.

## Development setup

```bash
npm install
npm run build
npx autotest validate test-plans/java-maven.yaml
```

Useful commands:

```bash
# Build TypeScript
npm run build

# Run unit tests if present
npm test

# Validate one plan
npx autotest validate test-plans/java-maven.yaml

# Run one plan
npx autotest run test-plans/java-maven.yaml
```

```powershell
# Validate all plans
Get-ChildItem test-plans -Filter *.yaml | ForEach-Object { npx autotest validate $_.FullName }
```

## Design principles

1. Prefer deterministic behavior over AI interpretation.
2. Keep pass/fail decisions inside `StepVerifier`.
3. Keep action syntax inside `ActionResolver`.
4. Keep VS Code automation details inside `VscodeDriver` or Driver operation modules.
5. Prefer VS Code commands, command IDs, and accessibility roles before CSS selectors.
6. Avoid hard-coded coordinates and timing-only solutions.
7. Make required failures explicit; only `try*` methods should silently no-op.
8. Preserve the public `VscodeDriver` API unless a breaking change is intentional and documented.

## Adding a new action

Add new user-facing action syntax in `src/operators/actionResolver.ts`.

Checklist:

1. Add an anchored regex pattern to `buildPatterns()`.
2. Put specific patterns before generic patterns.
3. Route to a Driver method; do not implement Playwright logic in `ActionResolver`.
4. Use quoted argument parsing for multiple free-text arguments.
5. Document the action in `README.md` and `AGENTS.md`.
6. Add or update at least one test plan if the action is user-facing.
7. Run `npm run build` and validate affected plans.

Preferred pattern:

```typescript
{
  regex: /^myAction\s+(.+)$/i,
  handler: async (m) => { await d.myAction(m[1].trim()); },
}
```

Avoid broad patterns such as:

```typescript
/myAction (.*)/i
```

They match partial strings, hide typos, and make future actions harder to add safely.

## Adding a Driver operation

Driver operations belong in `src/drivers/operations` when they do not require private Driver fields. Keep `src/drivers/vscodeDriver.ts` focused on lifecycle, workspace setup, shared state, and operations that still need private helpers.

Checklist:

1. Choose or create a functional module, for example `commandOperations.ts` or `dialogOperations.ts`.
2. Define an exported interface for the methods.
3. Define a local `DriverContext` interface for the public Driver methods the operation needs.
4. Implement methods in an exported operation object.
5. Import the interface and object in `vscodeDriver.ts`.
6. Extend the exported `VscodeDriver` interface.
7. Add the operation object to `Object.assign(VscodeDriver.prototype, ...)`.
8. Run `npm run build`.

Template:

```typescript
import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette(label: string): Promise<void>;
}

export interface ExampleOperations {
  doSomething(name: string): Promise<void>;
}

export const exampleOperations: ExampleOperations = {
  async doSomething(this: DriverContext, name: string): Promise<void> {
    const page = this.getPage();
    await page.getByRole("button", { name }).click();
  },
};
```

Then wire it in `vscodeDriver.ts`:

```typescript
import { exampleOperations, type ExampleOperations } from "./operations/exampleOperations.js";

export interface VscodeDriver
  extends CommandOperations,
    DialogOperations,
    ExampleOperations {}

Object.assign(
  VscodeDriver.prototype,
  commandOperations,
  dialogOperations,
  exampleOperations,
);
```

Do not access `private` fields from an operation module. If you need private state, expose a narrow public helper or keep the method in `vscodeDriver.ts`.

## Adding a verifier

Verification fields are deterministic checks in `StepVerifier`.

Checklist:

1. Add the field type to `src/types.ts`.
2. Add a private verifier method in `src/operators/stepVerifier.ts`.
3. Call it from `verify()` in a sensible order.
4. Return `{ passed: false, reason }` with expected and actual details.
5. Poll if the state is asynchronous.
6. Document the field in `README.md` and `docs/architecture.md`.
7. Add or update a test plan that uses the verifier.

Verifiers should use Driver methods. They should not duplicate low-level Playwright selectors unless the check is truly verifier-specific.

## Adding setup fields

Setup fields affect launch and workspace preparation, so they usually touch multiple files.

Checklist:

1. Add the field to `src/types.ts`.
2. Parse and resolve paths in `src/operators/planParser.ts` if needed.
3. Pass the field through `TestRunner` into `VscodeDriverOptions`.
4. Implement launch or setup behavior in `VscodeDriver`.
5. Document the field in `README.md`.
6. Validate a plan that uses the field.

Path rules:

- Setup paths are resolved relative to the test plan file.
- `~/` in runtime actions and verifiers means the runtime workspace root.
- `${workspaceFolder}` and `${workspaceParent}` are resolved at runtime.

## Writing test plans

Use deterministic checks whenever possible:

```yaml
- id: "verify-import"
  action: "run command File: Save All"
  verifyFile:
    path: "~/src/main/java/App.java"
    contains: "import java.util.List;"
```

Important guidelines:

- Use `insertLineInFile` for Java code changes that the language server must analyze.
- Use `verifyFile` after language-server edits such as organize imports or code actions.
- Use `expandTreeItem` for idempotent expansion and `click <name> tree item` only when toggling is acceptable.
- Quote tree/context/file arguments that contain spaces.
- Avoid static waits unless there is no observable state to poll.

## Documentation expectations

Update documentation when behavior changes:

| Change | Docs to update |
|--------|----------------|
| New or changed action | `README.md`, `AGENTS.md` |
| Driver architecture change | `docs/architecture.md`, optionally `README.md` |
| Contributor workflow change | `CONTRIBUTING.md` |
| New setup field or verifier | `README.md`, `docs/architecture.md` |

Documentation should be in English and should describe current behavior, not planned behavior.

## Validation before submitting

At minimum, run:

```bash
npm run build
```

For action, verifier, setup, or plan changes, also validate relevant plans:

```bash
npx autotest validate test-plans/<plan>.yaml
```

For broad DSL or parser changes, validate all plans:

```powershell
Get-ChildItem test-plans -Filter *.yaml | ForEach-Object { npx autotest validate $_.FullName }
```

If you change runtime behavior, run at least one representative plan when feasible.

## Pull request checklist

- The change follows the architecture boundaries.
- New action syntax is anchored and documented.
- New Driver operations are in the right operation module or intentionally left in `vscodeDriver.ts`.
- Deterministic verifiers include useful failure reasons.
- Test plans use workspace-aware paths.
- `npm run build` passes.
- Relevant test plans validate.
