import { afterEach, describe, expect, it, vi } from "vitest";
import type { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { StepVerifier } from "../src/operators/stepVerifier.js";
import type { TestStep } from "../src/types.js";

describe("StepVerifier output channel", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("polls until the expected text appears", async () => {
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(0)
      .mockReturnValueOnce(1);
    const getOutputChannelText = vi.fn()
      .mockResolvedValueOnce("[info] configuring")
      .mockResolvedValueOnce("[info] Found 22 tasks");
    const wait = vi.fn().mockResolvedValue(undefined);
    const verifier = new StepVerifier({
      getOutputChannelText,
      wait,
    } as unknown as VscodeDriver);
    const step: TestStep = {
      id: "wait-for-tasks",
      action: "wait",
      timeout: 1,
      verifyOutputChannel: {
        channel: "Gradle for Java",
        contains: "Found 22 tasks",
      },
    };

    await expect(verifier.verify(step)).resolves.toEqual({ passed: true });
    expect(getOutputChannelText).toHaveBeenCalledTimes(2);
    expect(wait).toHaveBeenCalledTimes(1);
  });
});
