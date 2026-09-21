import { afterEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
import * as path from "node:path";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { StepVerifier } from "../src/operators/stepVerifier.js";
import type { TestStep, VerificationEvidence } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function evidence(): VerificationEvidence {
  return { status: "not-run", checks: [] };
}

describe("StepVerifier evidence", () => {
  it("records the final polled values rather than re-reading changing state", async () => {
    const driver = new VscodeDriver();
    const counts = vi.spyOn(driver, "getProblemsCount")
      .mockResolvedValueOnce({ errors: 2, warnings: 1 })
      .mockResolvedValueOnce({ errors: 0, warnings: 1 })
      .mockResolvedValue({ errors: 5, warnings: 0 });
    vi.spyOn(driver, "wait").mockResolvedValue();
    const trace = evidence();

    await expect(new StepVerifier(driver).verify({
      id: "diagnostics", action: "wait", verifyProblems: { errors: 0 },
    }, trace)).resolves.toEqual({ passed: true });

    expect(counts).toHaveBeenCalledTimes(2);
    expect(trace).toEqual({
      status: "pass",
      checks: [{
        verifier: "verifyProblems",
        expected: { errors: 0 },
        status: "pass",
        startedAt: expect.any(String),
        observedAt: expect.any(String),
        completedAt: expect.any(String),
        actual: { errors: 0, warnings: 1 },
        truncated: undefined,
      }],
    });
  });

  it("distinguishes missing assertions, skipped checks, and checks blocked by an earlier failure", async () => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "getNotifications").mockResolvedValue(["unrelated"]);
    const editor = vi.spyOn(driver, "editorContains");
    const verifier = new StepVerifier(driver);
    const missing = evidence();
    await verifier.verify({ id: "text-only", action: "wait", verify: "ready" }, missing);
    expect(missing).toEqual({ status: "not-configured", checks: [] });

    const skipped = evidence();
    await verifier.verify({
      id: "unsupported-criterion", action: "wait", verifyEditor: { fileName: "App.java" },
    }, skipped);
    expect(skipped.status).toBe("not-configured");
    expect(skipped.checks[0]?.status).toBe("skipped");

    const failed = evidence();
    await expect(verifier.verify({
      id: "fail-fast", action: "wait", verifyNotification: "expected",
      verifyEditor: { contains: "never checked" },
    }, failed)).resolves.toEqual({
      passed: false, reason: 'Notification not found: "expected". Got: [unrelated]',
    });
    expect(failed.status).toBe("fail");
    expect(failed.checks.map((check) => check.status)).toEqual(["fail", "not-run"]);
    expect(failed.checks[0]?.actual).toEqual({ notifications: ["unrelated"] });
    expect(failed.checks[1]?.observedAt).toBeUndefined();
    expect(editor).not.toHaveBeenCalled();
  });

  it("retains observations and the original error when a verifier throws", async () => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "getWebviewText")
      .mockResolvedValueOnce("Loading")
      .mockRejectedValueOnce(new Error("webview closed"));
    vi.spyOn(driver, "wait").mockResolvedValue();
    const trace = evidence();

    await expect(new StepVerifier(driver).verify({
      id: "webview", action: "wait", verifyWebview: { contains: "Ready" },
    }, trace)).rejects.toThrow("webview closed");

    expect(trace.status).toBe("error");
    expect(trace.checks[0]).toMatchObject({
      status: "error", reason: "webview closed", actual: { text: "Loading" },
    });
  });

  it("uses one file read for assertions, hash, and bounded content", async () => {
    const driver = new VscodeDriver();
    const content = "public class App {}\n" + "x".repeat(5000);
    vi.spyOn(driver, "getWorkspacePath").mockReturnValue(path.resolve("workspace"));
    vi.spyOn(driver, "resolveWorkspacePlaceholders").mockReturnValue(path.resolve("workspace", "App.java"));
    vi.spyOn(driver, "fileExists").mockResolvedValue(true);
    const read = vi.spyOn(driver, "readFile").mockResolvedValue(content);
    const contains = vi.spyOn(driver, "fileContains");
    const trace = evidence();

    await expect(new StepVerifier(driver).verify({
      id: "file", action: "saveFile",
      verifyFile: { path: "~/App.java", contains: "class App", matches: "public class" },
    }, trace)).resolves.toEqual({ passed: true });

    expect(read).toHaveBeenCalledTimes(1);
    expect(contains).not.toHaveBeenCalled();
    expect(trace.checks[0]?.actual).toMatchObject({
      exists: true, containsMatched: true, regexMatched: true,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentLength: content.length,
      content: content.slice(0, 4096),
    });
    expect(trace.checks[0]?.truncated).toEqual(["content"]);
  });

  it("captures completion items before cleanup, including the timeout read", async () => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "triggerCompletion").mockResolvedValue([]);
    vi.spyOn(driver, "isCompletionVisible").mockResolvedValue(true);
    vi.spyOn(driver, "readCompletionItems").mockResolvedValue(["String", "System"]);
    vi.spyOn(driver, "wait").mockResolvedValue();
    const trace = evidence();
    const dismiss = vi.spyOn(driver, "dismissCompletion").mockImplementation(async () => {
      expect(trace.checks[0]?.actual).toEqual({ items: ["String", "System"] });
    });
    const verifier = new StepVerifier(driver);
    await expect(verifier.verify({
      id: "completion", action: "triggerCompletion", timeout: 0,
      verifyCompletion: { contains: ["Missing"] },
    }, trace)).resolves.toMatchObject({ passed: false });
    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(trace.status).toBe("fail");

    await expect(verifier.verify({
      id: "completion-pass", action: "triggerCompletion",
      verifyCompletion: { contains: ["String"] },
    }, trace)).resolves.toEqual({ passed: true });
    expect(trace.status).toBe("pass");
  });

  it("bounds arrays without changing the condition evaluated against the complete input", async () => {
    const driver = new VscodeDriver();
    const notifications = Array.from({ length: 101 }, (_, index) => `notification-${index}`);
    vi.spyOn(driver, "getNotifications").mockResolvedValue(notifications);
    const trace = evidence();
    await expect(new StepVerifier(driver).verify({
      id: "notifications", action: "wait", verifyNotification: "notification-100",
    }, trace)).resolves.toEqual({ passed: true });
    expect(trace.checks[0]?.actual?.notifications).toHaveLength(100);
    expect(trace.checks[0]?.truncated).toEqual(["notifications"]);
  });

  it("also bounds the total text in an array observation", async () => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "getNotifications").mockResolvedValue([
      "x".repeat(3000), "y".repeat(3000), "Ready",
    ]);
    const trace = evidence();
    await expect(new StepVerifier(driver).verify({
      id: "long-notifications", action: "wait", verifyNotification: "Ready",
    }, trace)).resolves.toEqual({ passed: true });
    expect(trace.checks[0]?.actual?.notifications).toEqual([
      "x".repeat(3000), "y".repeat(1096),
    ]);
    expect(trace.checks[0]?.truncated).toEqual(["notifications"]);
  });

  it.each([
    { field: { verifyEditor: { contains: "App" } }, expected: { containsMatched: true } },
    { field: { verifyQuickInput: { noError: true } }, expected: { message: "" } },
    { field: { verifyDialog: { contains: "Confirm" } }, expected: { visible: true, message: "Confirm" } },
    { field: { verifyTreeItem: { name: "App", count: 2 } }, expected: { countConditionMet: true } },
    { field: { verifyTreeItem: { name: "App" } }, expected: { appeared: true } },
    { field: { verifyTreeItem: { name: "App", visible: false } }, expected: { disappeared: true } },
    { field: { verifyEditorTab: { title: "App.java" } }, expected: { appeared: true } },
    { field: { verifyWebview: { contains: "Ready" } }, expected: { text: "Ready" } },
    { field: { verifyOutputChannel: { channel: "Build", contains: "SUCCESS" } }, expected: { channel: "Build", text: "SUCCESS" } },
    { field: { verifyTerminal: { contains: "SUCCESS" } }, expected: { text: "SUCCESS" } },
    { field: { verifyClipboard: { exact: "copied" } }, expected: { text: "copied" } },
  ])("records observed values for $field", async ({ field, expected }) => {
    const driver = new VscodeDriver();
    vi.spyOn(driver, "editorContains").mockResolvedValue(true);
    vi.spyOn(driver, "getQuickInputValidationMessage").mockResolvedValue("");
    vi.spyOn(driver, "isDialogVisible").mockResolvedValue(true);
    vi.spyOn(driver, "getDialogMessage").mockResolvedValue("Confirm");
    vi.spyOn(driver, "waitForTreeItemCount").mockResolvedValue(true);
    vi.spyOn(driver, "waitForTreeItem").mockResolvedValue(true);
    vi.spyOn(driver, "waitForTreeItemGone").mockResolvedValue(true);
    vi.spyOn(driver, "waitForEditorTab").mockResolvedValue(true);
    vi.spyOn(driver, "getWebviewText").mockResolvedValue("Ready");
    vi.spyOn(driver, "getOutputChannelText").mockResolvedValue("SUCCESS");
    vi.spyOn(driver, "getTerminalText").mockResolvedValue("SUCCESS");
    vi.spyOn(driver, "readClipboard").mockResolvedValue("copied");
    const trace = evidence();
    const step: TestStep = { id: "check", action: "wait", ...field };

    await expect(new StepVerifier(driver).verify(step, trace)).resolves.toEqual({ passed: true });
    expect(trace.checks[0]?.actual).toEqual(expected);
    expect(trace.checks[0]?.status).toBe("pass");
  });
});
