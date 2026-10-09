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
const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function temporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-log-diagnostics-"));
  directories.push(directory);
  return directory;
}

describe("configured startup and component logs", () => {
  it.each([false, true])("records real version-resolution stages only when explicitly enabled (%s)", async enabled => {
    const error = new AggregateError([Object.assign(new Error("connection rejected"), { code: "ECONNREFUSED" })], "");
    vi.mocked(downloadAndUnzipVSCode).mockRejectedValue(error);
    const driver = new VscodeDriver({ vscodeVersion: "stable", enableEvidenceProbe: true, enableLaunchDiagnostics: enabled });
    await expect(driver.launch()).rejects.toBe(error);
    expect(driver.getLaunchDiagnostics()).toEqual(enabled ? [{
      capturedAt: expect.any(String), stage: "resolve-vscode", details: { requestedVersion: "stable" },
    }] : []);
  });

  it("saves configured startup, failure, VS Code and JDT logs alongside evidence-manifest copies", async () => {
    const root = temporaryDirectory();
    const userData = path.join(root, "user-data");
    const destination = path.join(root, "configured-logs");
    const results = path.join(root, "results");
    const vscodeLog = path.join(userData, "logs", "session", "window1", "exthost", "exthost.log");
    const jdtLog = path.join(userData, "User", "workspaceStorage", "workspace", "redhat.java", "jdt_ws", ".metadata", ".log");
    for (const file of [vscodeLog, jdtLog]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, "component failure\napi-key=component-placeholder\n");
    }
    const error = new AggregateError([Object.assign(new Error("api-key=error-placeholder"), { code: "ECONNRESET" })], "");
    vi.mocked(downloadAndUnzipVSCode).mockRejectedValue(error);
    const driver = new VscodeDriver({ vscodeVersion: "stable", enableLaunchDiagnostics: true });
    await expect(driver.launch()).rejects.toBe(error);
    vi.spyOn(driver, "getUserDataDir").mockReturnValue(userData);
    const collector = new EvidenceCollector(driver, results, destination);
    collector.recordRunnerFailure(error);
    const evidence = collector.collectRunEvidence();
    const manifestPath = collector.writeBundle({
      name: "Log bundle", setup: { extension: "" }, steps: [{ id: "ready", action: "wait" }],
    }, [], evidence, true);
    expect(evidence.logs.map(log => log.kind)).toEqual(["jdtls", "vscode", "runner-launch", "runner-failure"]);
    for (const name of ["jdtls-1.log", "vscode-1.log", "runner-launch.log", "runner-failure.log"]) {
      const saved = fs.readFileSync(path.join(destination, name), "utf8");
      expect(fs.readFileSync(path.join(results, "evidence", "logs", name), "utf8")).toBe(saved);
      expect(saved).not.toContain("component-placeholder");
      expect(saved).not.toContain("error-placeholder");
    }
    const manifest = JSON.parse(fs.readFileSync(path.join(results, manifestPath!), "utf8"));
    expect(manifest.artifacts.filter((artifact: { type: string }) => artifact.type === "log")).toHaveLength(4);
    collector.resetRunnerFailure();
    expect(collector.collectRunEvidence().logs.map(log => log.kind)).not.toContain("runner-failure");
  });

  it("bounds component file count and retained log bytes", () => {
    const root = temporaryDirectory();
    const logRoot = path.join(root, "user-data", "logs");
    fs.mkdirSync(logRoot, { recursive: true });
    for (let index = 0; index < 25; index++) {
      fs.writeFileSync(path.join(logRoot, `component-${String(index).padStart(2, "0")}.log`), "x".repeat(100_000));
    }
    const driver = new VscodeDriver();
    vi.spyOn(driver, "getUserDataDir").mockReturnValue(path.dirname(logRoot));
    const evidence = new EvidenceCollector(driver, null, path.join(root, "logs")).collectRunEvidence();
    expect(evidence.logs).toHaveLength(20);
    expect(evidence.logs[0].sourcePath).toContain("component-05.log");
    for (const [index, log] of evidence.logs.entries()) {
      expect(log.tail.length).toBeLessThanOrEqual(64 * 1024);
      expect(log.artifactPath).toBe(`vscode-${index + 1}.log`);
    }
  });

  it("bounds aggregate failures and cyclic causes without dumping arbitrary fields", () => {
    const failure = new AggregateError([], "");
    Object.assign(failure, { password: "arbitrary-placeholder" });
    failure.errors.push(...Array(10).fill(failure));
    const output = formatErrorEvidence(failure);
    expect(output).toContain('"errorsTruncated": 2');
    expect(output).toContain("<error entry limit>");
    expect(output).not.toContain("arbitrary-placeholder");
    expect(output.length).toBeLessThanOrEqual(64 * 1024);
  });
});
