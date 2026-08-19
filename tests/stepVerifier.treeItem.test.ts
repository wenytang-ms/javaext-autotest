import { describe, expect, it, vi } from "vitest";
import type { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { StepVerifier } from "../src/operators/stepVerifier.js";

describe("StepVerifier tree items", () => {
  it("verifies a tree-item count at a specific level", async () => {
    const waitForTreeItemCount = vi.fn().mockResolvedValue(true);
    const verifier = new StepVerifier({
      waitForTreeItemCount,
    } as unknown as VscodeDriver);

    const result = await verifier.verify({
      id: "verify-root-count",
      action: "wait 1 seconds",
      verifyTreeItem: {
        name: "simple",
        exact: true,
        count: 1,
        level: 1,
        inView: "Java Projects",
      },
      timeout: 5,
    });

    expect(result).toEqual({ passed: true });
    expect(waitForTreeItemCount).toHaveBeenCalledWith(
      "simple",
      1,
      5_000,
      true,
      "Java Projects",
      1,
    );
  });

  it("rejects invalid tree levels", async () => {
    const verifier = new StepVerifier({} as VscodeDriver);

    const result = await verifier.verify({
      id: "verify-invalid-level",
      action: "wait 1 seconds",
      verifyTreeItem: {
        name: "simple",
        level: 0,
      },
    });

    expect(result).toEqual({
      passed: false,
      reason: "Tree item level must be a positive integer, got 0",
    });
  });
});
