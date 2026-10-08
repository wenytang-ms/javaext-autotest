import { afterEach, describe, expect, it, vi } from "vitest";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { ActionResolver } from "../src/operators/actionResolver.js";
import { TestRunner } from "../src/operators/testRunner.js";

afterEach(() => vi.restoreAllMocks());

describe("state-driven hover action", () => {
  it("parses quoted arguments and preserves the execution deadline", async () => {
    const driver = new VscodeDriver();
    const hover = vi.spyOn(driver, "hoverAndClickAction").mockResolvedValue();
    const context = { deadline: Date.now() + 10_000 };
    await new ActionResolver(driver).resolve(
      'hoverAndClickAction "greet" "Go to Super Implementation"', context,
    );
    expect(hover).toHaveBeenCalledOnce();
    expect(hover).toHaveBeenCalledWith("greet", "Go to Super Implementation", context);
  });

  it("rejects missing arguments before calling the driver", async () => {
    const driver = new VscodeDriver();
    const hover = vi.spyOn(driver, "hoverAndClickAction").mockResolvedValue();
    await expect(new ActionResolver(driver).resolve("hoverAndClickAction greet"))
      .rejects.toThrow("Expected 2 argument(s)");
    expect(hover).not.toHaveBeenCalled();
  });

  it("preserves legacy hover operation arguments", async () => {
    const driver = new VscodeDriver();
    const hover = vi.spyOn(driver, "hoverOnText").mockResolvedValue();
    const click = vi.spyOn(driver, "clickHoverAction").mockResolvedValue();
    const resolver = new ActionResolver(driver);
    await resolver.resolve("hoverOnText greet", { deadline: Date.now() + 10_000 });
    await resolver.resolve("clickHoverAction Go to Super Implementation");
    expect(hover).toHaveBeenCalledOnce();
    expect(hover).toHaveBeenCalledWith("greet");
    expect(click).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledWith("Go to Super Implementation");
  });

  it("passes the step execution budget from the runner", async () => {
    const runner = new TestRunner({
      name: "Hover deadline",
      setup: { extension: "" },
      steps: [{ id: "hover", action: 'hoverAndClickAction "greet" "Go to Super Implementation"', timeout: 7 }],
    }, { noLLM: true });
    const driver = runner["driver"];
    vi.spyOn(driver, "launch").mockResolvedValue();
    vi.spyOn(driver, "close").mockResolvedValue();
    vi.spyOn(driver, "wait").mockResolvedValue();
    const resolve = vi.spyOn(runner["actionResolver"], "resolve").mockResolvedValue(true);
    const before = Date.now();
    const report = await runner.run();
    expect(report.summary.passed).toBe(1);
    const deadline = resolve.mock.calls[0][1]?.deadline;
    expect(deadline).toBeGreaterThanOrEqual(before + 7_000);
    expect(deadline).toBeLessThanOrEqual(Date.now() + 7_000);
  });
});
