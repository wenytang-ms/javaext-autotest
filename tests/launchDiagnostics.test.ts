import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode } from "@vscode/test-electron";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { EvidenceCollector, formatErrorEvidence } from "../src/operators/evidenceCollector.js";

vi.mock("@vscode/test-electron", () => ({
  downloadAndUnzipVSCode: vi.fn(),
  resolveCliArgsFromVSCodeExecutablePath: vi.fn(),
}));

afterEach(() => vi.resetAllMocks());

describe("opt-in launch diagnostics", () => {
  it.each([false, true])("records version-resolution failures only with evidence enabled (%s)", async (enabled) => {
    const failure = Object.assign(new Error(""), { code: "ECONNRESET", statusCode: 502 });
    vi.mocked(downloadAndUnzipVSCode).mockRejectedValue(failure);
    const driver = new VscodeDriver({ vscodeVersion: "stable", enableEvidenceProbe: enabled });
    await expect(driver.launch()).rejects.toBe(failure);
    expect(driver.getLaunchDiagnostics()).toEqual(enabled ? [{
      capturedAt: expect.any(String),
      stage: "resolve-vscode",
      details: { requestedVersion: "stable" },
    }] : []);
  });

  it("preserves launch stage, empty-message errors and nested causes in uploaded evidence", async () => {
    const cause = Object.assign(new Error("api-key=diagnostic-test-placeholder"), { code: "ECONNRESET" });
    const failure = Object.assign(new Error("", { cause }), { statusCode: 502 });
    vi.mocked(downloadAndUnzipVSCode).mockRejectedValue(failure);
    const driver = new VscodeDriver({ vscodeVersion: "stable", enableEvidenceProbe: true });
    await expect(driver.launch()).rejects.toBe(failure);
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-launch-evidence-"));
    try {
      const collector = new EvidenceCollector(driver, directory);
      collector.recordRunnerFailure(failure);
      const evidence = collector.collectRunEvidence();
      const manifest = collector.writeBundle({
        name: "Startup regression", setup: { extension: "" }, steps: [{ id: "ready", action: "wait" }],
      }, [], evidence, true);
      const logs = evidence.logs.map(log => log.tail).join("\n");
      expect(logs).toContain("resolve-vscode");
      expect(logs).toContain("ECONNRESET");
      expect(logs).toContain('"statusCode": 502');
      expect(logs).toContain('"stack":');
      expect(logs).not.toContain("diagnostic-test-placeholder");
      expect(JSON.parse(fs.readFileSync(path.join(directory, manifest!), "utf8")).artifacts)
        .toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "log", label: "runner-launch" }),
          expect.objectContaining({ type: "log", label: "runner-failure" }),
        ]));
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("bounds cyclic causes and accepts non-Error failures without dumping arbitrary fields", () => {
    const failure: { message: string; cause?: unknown; password: string } = {
      message: "failure", password: "unrelated-test-placeholder",
    };
    failure.cause = failure;
    const output = formatErrorEvidence(failure);
    expect(output).toContain("<cause depth limit>");
    expect(output).not.toContain("unrelated-test-placeholder");
    expect(formatErrorEvidence("startup failed")).toContain("startup failed");
  });

  it("preserves bounded aggregate connection errors when the outer message is empty", () => {
    const connection = Object.assign(new Error("connect ECONNREFUSED api-key=aggregate-test-placeholder"), {
      code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 443,
    });
    const output = formatErrorEvidence(new AggregateError(Array(10).fill(connection), ""));
    const details = JSON.parse(output);
    expect(details.name).toBe("AggregateError");
    expect(details.message).toBe("");
    expect(details.errors).toHaveLength(8);
    expect(details.errors[0]).toMatchObject({ code: "ECONNREFUSED", syscall: "connect", address: "::1", port: 443 });
    expect(details.errorsTruncated).toBe(2);
    expect(output).not.toContain("aggregate-test-placeholder");
  });

  it("bounds wide cyclic aggregate errors", () => {
    const failure = new AggregateError([], "");
    failure.errors.push(...Array(8).fill(failure));
    const output = formatErrorEvidence(failure);
    expect(output).toContain("<error entry limit>");
    expect(output).toContain("<cause depth limit>");
    expect(output.length).toBeLessThanOrEqual(64 * 1024);
  });
});
