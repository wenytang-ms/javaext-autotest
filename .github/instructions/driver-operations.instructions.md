---
applyTo: "src/drivers/**/*.ts"
---

# Driver Operation Instructions

`VscodeDriver` is the public operation SDK used by `ActionResolver` and `StepVerifier`. Keep the public API stable and keep implementation details grouped by functional area.

## File responsibilities

- `src/drivers/vscodeDriver.ts` owns lifecycle, launch setup, workspace isolation, process cleanup, shared state, and private helpers.
- `src/drivers/operations/*.ts` owns function-specific Driver methods that can be implemented through public Driver helpers.

## Operation module pattern

Operation modules should expose an interface and an operation object:

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

Wire new operation groups in `vscodeDriver.ts`:

```typescript
export interface VscodeDriver extends ExampleOperations {}

Object.assign(VscodeDriver.prototype, exampleOperations);
```

## Rules

- Operation modules must not access `private` fields from `VscodeDriver`.
- Depend only on methods declared in the module-local `DriverContext`.
- Prefer commands and accessibility roles over CSS selectors.
- Use scoped CSS selectors only when VS Code exposes no better surface.
- Do not use hard-coded mouse coordinates.
- Required operations should throw with actionable messages.
- Optional no-op behavior must be obvious from the method name, for example `tryClickButton`.
- If an operation requires private state, add a narrow public helper or keep the method in `vscodeDriver.ts`.

Run `npm run build` after changing Driver methods or operation wiring.
