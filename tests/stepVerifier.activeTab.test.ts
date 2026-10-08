import { afterEach, describe, expect, it, vi } from "vitest";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { StepVerifier } from "../src/operators/stepVerifier.js";

afterEach(() => vi.restoreAllMocks());

describe("active editor tab verification", () => {
  it("requires the matching tab to become active", async () => {
    const driver = new VscodeDriver();
    const wait = vi.spyOn(driver, "waitForEditorTab").mockResolvedValue(true);
    const result = await new StepVerifier(driver).verify({
      id: "base", action: "wait 0 seconds", timeout: 9,
      verifyEditorTab: { title: "Base.java", active: true },
    });
    expect(result.passed).toBe(true);
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith("Base.java", 9_000, true);
  });

  it("fails when a background tab never becomes active", async () => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "waitForEditorTab").mockResolvedValue(false);
    const result = await new StepVerifier(driver).verify({
      id: "base", action: "wait 0 seconds",
      verifyEditorTab: { title: "Base.java", active: true },
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain('Editor tab "Base.java" did not become active');
  });

  it("keeps the existing tab-presence call unchanged by default", async () => {
    const driver = new VscodeDriver();
    const wait = vi.spyOn(driver, "waitForEditorTab").mockResolvedValue(true);
    await new StepVerifier(driver).verify({
      id: "base", action: "wait 0 seconds", verifyEditorTab: { title: "Base.java" },
    });
    expect(wait).toHaveBeenCalledOnce();
    expect(wait).toHaveBeenCalledWith("Base.java", 15_000);
  });
});
