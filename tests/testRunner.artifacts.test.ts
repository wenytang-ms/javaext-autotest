import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TestRunner, type TestRunnerOptions } from "../src/operators/testRunner.js";
import { LLMClient } from "../src/operators/llmClient.js";
import type { ArtifactCollectionManifest, ArtifactSource, EvidenceBundleManifest, ProbeSnapshot, TestPlan } from "../src/types.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-run-artifacts-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const sources: ArtifactSource[] = [
  { id: "diagnostics", root: "workspace", include: [".autotest/**"], destination: "diagnostics/runtime", evidence: "tail" },
  { id: "ide", root: "userData", include: ["logs/**"], destination: "logs/ide", evidence: "tail" },
];

function createRunner(options: TestRunnerOptions = {}) {
  const outputDir = path.join(root, "results");
  const workspace = path.join(root, "runtime-workspace");
  const userData = path.join(root, "runtime-user-data");
  const probePath = path.join(userData, "probe.json");
  fs.mkdirSync(path.join(workspace, ".autotest"), { recursive: true });
  fs.mkdirSync(path.join(userData, "logs", "session"), { recursive: true });
  const diagnostic = path.join(workspace, ".autotest", "compiler.log");
  const ideLog = path.join(userData, "logs", "session", "extension.log");
  fs.writeFileSync(diagnostic, "compiler started\napi-key=fake-runtime-key\n");
  fs.writeFileSync(ideLog, "extension started\n");
  const probe: ProbeSnapshot = {
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    vscode: { version: "fixture", appName: "Fixture", appHost: "desktop", uiKind: 1 },
    process: { platform: process.platform, arch: process.arch, nodeVersion: process.version, execPath: process.execPath },
    workspaceFolders: [workspace], diagnostics: [], extensions: [],
  };
  fs.writeFileSync(probePath, JSON.stringify(probe));
  const plan: TestPlan = { name: "Artifacts", setup: { extension: "" }, steps: [{ id: "ready", action: "wait" }] };
  const runner = new TestRunner(plan, { outputDir, noLLM: true, artifacts: { sources }, ...options });
  const driver = runner["driver"];
  const events: string[] = [];
  vi.spyOn(driver, "launch").mockResolvedValue();
  vi.spyOn(driver, "wait").mockResolvedValue();
  vi.spyOn(driver, "getWorkspacePath").mockReturnValue(workspace);
  vi.spyOn(driver, "getUserDataDir").mockReturnValue(userData);
  vi.spyOn(driver, "getProbeSnapshotPath").mockReturnValue(probePath);
  vi.spyOn(driver, "refreshProbeSnapshot").mockImplementation(async () => { events.push("probe"); });
  vi.spyOn(driver, "screenshot").mockImplementation(async file => {
    const contents = Buffer.from("fixture screenshot");
    fs.writeFileSync(file!, contents);
    return contents;
  });
  vi.spyOn(runner["actionResolver"], "resolve").mockResolvedValue(true);
  vi.spyOn(driver, "close").mockImplementation(async options => {
    events.push("shutdown");
    fs.appendFileSync(diagnostic, "compiler flushed on shutdown\n");
    fs.appendFileSync(ideLog, "extension flushed on shutdown\n");
    await options?.beforeWorkspaceCleanup?.();
    events.push("cleanup");
    fs.rmSync(workspace, { recursive: true, force: true });
  });
  return { runner, driver, outputDir, workspace, userData, diagnostic, events };
}

describe("TestRunner artifact integration", () => {
  it.each(["legacy", "evidence-only"] as const)("archives flushed runtime files before cleanup in %s mode", async analysisMode => {
    const { runner, outputDir, workspace, events } = createRunner({ analysisMode });
    const report = await runner.run();
    expect(report.summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 });
    expect(report.artifacts).toMatchObject({ status: "complete", files: 2, manifest: "artifacts/manifest.json" });
    expect(events).toEqual(analysisMode === "legacy" ? ["shutdown", "cleanup"] : ["probe", "shutdown", "cleanup"]);
    expect(fs.existsSync(workspace)).toBe(false);
    const manifest: ArtifactCollectionManifest = JSON.parse(fs.readFileSync(path.join(outputDir, report.artifacts!.manifest), "utf8"));
    for (const source of manifest.sources) {
      expect(source.files).toHaveLength(1);
      const text = fs.readFileSync(path.join(outputDir, source.files[0].path), "utf8");
      expect(text).toContain("flushed on shutdown");
      expect(text).not.toContain("fake-runtime-key");
    }
    if (analysisMode === "legacy") {
      expect(report.evidence).toBeUndefined();
      expect(report.analysis).toBeUndefined();
    } else {
      expect(report.evidence?.logs.map(log => log.kind)).toEqual(["diagnostics", "ide"]);
      expect(report.evidence?.environment.javaVersion).toBeUndefined();
      const evidence: EvidenceBundleManifest = JSON.parse(fs.readFileSync(path.join(outputDir, report.analysis!.evidenceManifest!), "utf8"));
      expect(evidence.artifactCollection?.files).toBe(2);
      expect(evidence.artifacts.filter(file => file.type === "log")).toHaveLength(2);
      for (const log of report.evidence!.logs) expect(fs.readFileSync(path.join(outputDir, log.artifactPath!), "utf8")).toContain(log.tail);
    }
  });

  it("collects on startup failure and preserves the original crash and exit-policy inputs", async () => {
    const { runner, driver, outputDir } = createRunner({ analysisMode: "evidence-only" });
    vi.mocked(driver.launch).mockRejectedValue(new Error("controlled startup failure"));
    const report = await runner.run();
    expect(report.crashed).toBe(true);
    expect(report.crashReason).toBe("controlled startup failure");
    expect(report.summary.total).toBe(0);
    expect(report.artifacts).toMatchObject({ status: "complete", files: 2 });
    expect(fs.existsSync(path.join(outputDir, "results.json"))).toBe(true);
  });

  it("does not replace test success or failure with collection status", async () => {
    const { runner, driver, outputDir } = createRunner();
    vi.mocked(driver.launch).mockImplementation(async () => {
      const outside = path.join(root, "outside");
      fs.mkdirSync(outside);
      fs.symlinkSync(outside, path.join(outputDir, "diagnostics"), process.platform === "win32" ? "junction" : "dir");
    });
    const report = await runner.run();
    expect(report.summary.passed).toBe(1);
    expect(report.crashed).toBeUndefined();
    expect(report.artifacts?.status).toBe("partial");
    expect(report.artifacts?.collectionErrors?.join()).toContain("symbolic link");
    expect(JSON.parse(fs.readFileSync(path.join(outputDir, "results.json"), "utf8")).summary.passed).toBe(1);
  });

  it("retains all archived files but caps LLM log evidence independently", async () => {
    const { runner, workspace, outputDir } = createRunner({ analysisMode: "case" });
    for (let index = 0; index < 25; index++) {
      fs.writeFileSync(path.join(workspace, ".autotest", `log-${String(index).padStart(2, "0")}.log`),
        "x".repeat(150_000) + "\nfinal evidence marker\n");
    }
    const llm = new LLMClient({ endpoint: "https://example.test", apiKey: "test-key" });
    const analyze = vi.spyOn(llm, "analyzeCase").mockRejectedValue(new Error("controlled model failure"));
    runner["llm"] = llm;
    const report = await runner.run();
    expect(report.artifacts?.files).toBe(27);
    expect(report.evidence!.logs.length).toBeLessThanOrEqual(20);
    expect(report.evidence!.logs.some(log => log.kind === "ide")).toBe(true);
    expect(report.evidence!.logs.reduce((sum, log) => sum + Buffer.byteLength(log.tail), 0)).toBeLessThanOrEqual(256 * 1024);
    for (const log of report.evidence!.logs) expect(Buffer.byteLength(log.tail)).toBeLessThanOrEqual(64 * 1024);
    expect(report.evidence!.artifactEvidenceOmitted).toBeGreaterThan(0);
    const input = analyze.mock.calls[0][0];
    expect(input.report.evidence?.artifactCollection?.files).toBe(27);
    expect(JSON.stringify(input.evidenceManifest)).not.toContain("final evidence marker");
    const largeLog = report.evidence!.logs.find(log => log.tailTruncated)!;
    expect(fs.readFileSync(path.join(outputDir, largeLog.artifactPath!), "utf8").length).toBeGreaterThan(150_000);
    expect(report.summary.passed).toBe(1);
    expect(report.analysis?.error).toContain("controlled model failure");
  });

  it("keeps Unicode tail evidence within byte limits even when the read starts inside a code point", async () => {
    const { runner, workspace } = createRunner({ analysisMode: "evidence-only" });
    fs.writeFileSync(path.join(workspace, ".autotest", "unicode.log"), "\u{1f642}".repeat(20_000) + "z");
    const report = await runner.run();
    const log = report.evidence!.logs.find(log => log.sourcePath.endsWith("unicode.log"))!;
    expect(log.tailTruncated).toBe(true);
    expect(log.tail.endsWith("z")).toBe(true);
    expect(Buffer.byteLength(log.tail)).toBeLessThanOrEqual(64 * 1024);
    expect(report.evidence!.logs.reduce((sum, entry) => sum + Buffer.byteLength(entry.tail), 0)).toBeLessThanOrEqual(256 * 1024);
  });

  it("does not discover undeclared Java or extension logs in generic mode", async () => {
    const { runner, userData } = createRunner({ analysisMode: "evidence-only" });
    const javaLog = path.join(userData, "User", "workspaceStorage", "id", "redhat.java", "jdt_ws", ".metadata", ".log");
    fs.mkdirSync(path.dirname(javaLog), { recursive: true });
    fs.writeFileSync(javaLog, "undeclared Java sentinel");
    const report = await runner.run();
    expect(report.evidence?.logs.some(log => log.kind === "jdtls")).toBe(false);
    expect(JSON.stringify(report.evidence)).not.toContain("undeclared Java sentinel");
  });

  it("shares one finalization between signal cleanup and the normal finally path", async () => {
    const { runner, driver } = createRunner({ analysisMode: "evidence-only" });
    let release: () => void = () => {};
    let started: () => void = () => {};
    const actionStarted = new Promise<void>(resolve => { started = resolve; });
    const actionGate = new Promise<void>(resolve => { release = resolve; });
    vi.mocked(runner["actionResolver"].resolve).mockImplementation(async () => {
      started();
      await actionGate;
      return true;
    });
    const run = runner.run();
    await actionStarted;
    await Promise.all([runner.cleanup(), runner.cleanup()]);
    release();
    await run;
    expect(driver.close).toHaveBeenCalledTimes(1);
    expect(driver.refreshProbeSnapshot).toHaveBeenCalledTimes(1);
    expect(runner["artifactSummary"]?.files).toBe(2);
  });

  it("keeps disabled artifact configuration out of legacy reports and files", async () => {
    const { runner, driver, outputDir } = createRunner({ artifacts: { enabled: false } });
    const report = await runner.run();
    expect(report.artifacts).toBeUndefined();
    expect(report.analysis).toBeUndefined();
    expect(fs.existsSync(path.join(outputDir, "artifacts"))).toBe(false);
    expect(driver.close).toHaveBeenCalledWith();
  });
});
