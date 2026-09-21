import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TestRunner } from "../src/operators/testRunner.js";
import { LLMClient } from "../src/operators/llmClient.js";
import type { AnalysisMode, EvidenceBundleManifest, TestPlan, TestReport, TestStep } from "../src/types.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createRunner(step: TestStep, mode: AnalysisMode = "evidence-only") {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-runner-evidence-"));
  temporaryDirectories.push(outputDir);
  const plan: TestPlan = { name: "Evidence regression", setup: { extension: "" }, steps: [step] };
  const runner = new TestRunner(plan, { outputDir, analysisMode: mode, noLLM: true });
  const driver = runner["driver"];
  vi.spyOn(driver, "launch").mockResolvedValue();
  vi.spyOn(driver, "close").mockResolvedValue();
  vi.spyOn(driver, "wait").mockResolvedValue();
  vi.spyOn(driver, "refreshProbeSnapshot").mockResolvedValue();
  vi.spyOn(driver, "getProblemsCount").mockResolvedValue({ errors: 0, warnings: 0 });
  vi.spyOn(driver, "getProblems").mockResolvedValue([]);
  vi.spyOn(runner["actionResolver"], "resolve").mockResolvedValue(true);
  vi.spyOn(driver, "screenshot").mockImplementation(async (filePath) => {
    const contents = Buffer.from(path.basename(filePath!));
    fs.writeFileSync(filePath!, contents);
    return contents;
  });
  if (runner["evidenceCollector"]) {
    vi.spyOn(runner["evidenceCollector"], "collectRunEvidence").mockReturnValue({
      capturedAt: new Date().toISOString(),
      environment: { platform: process.platform, arch: process.arch, nodeVersion: process.version },
      installedExtensions: [], bundledArtifacts: [], logs: [],
    });
  }
  return { runner, driver, outputDir };
}

function configureLlm(runner: TestRunner) {
  const llm = new LLMClient({ endpoint: "https://example.test", apiKey: "test-key" });
  runner["llm"] = llm;
  return llm;
}

describe("TestRunner evidence chain", () => {
  it("retains action-time screenshots and supplies verified state and observations to the step LLM", async () => {
    const { runner, driver, outputDir } = createRunner({
      id: "settle", action: "wait", verify: "Problems contains no errors",
      verifyProblems: { errors: 0 },
    });
    let state = "Loading";
    vi.mocked(driver.screenshot).mockImplementation(async (filePath) => {
      const contents = Buffer.from(state);
      fs.writeFileSync(filePath!, contents);
      return contents;
    });
    vi.mocked(driver.getProblemsCount)
      .mockResolvedValueOnce({ errors: 1, warnings: 0 })
      .mockImplementation(async () => {
        state = "Ready";
        return { errors: 0, warnings: 0 };
      });
    const verify = vi.spyOn(configureLlm(runner), "verifyStep")
      .mockResolvedValue({ passed: true, confidence: 0.9, reasoning: "Verified state is ready" });

    const report = await runner.run();
    const result = report.results[0]!;
    const args = verify.mock.calls[0]!;
    expect(Buffer.from(args[1], "base64").toString()).toBe("Loading");
    expect(Buffer.from(args[4]!.afterVerificationBase64!, "base64").toString()).toBe("Ready");
    expect(args[4]?.verification.checks[0]?.actual).toEqual({ errors: 0, warnings: 0 });
    expect(result.screenshots?.map((entry) => entry.phase)).toEqual(["before", "after", "verified"]);
    expect(result.verification?.status).toBe("pass");
    expect(result.attempts?.[0]?.verification).toEqual(result.verification);
    expect(result.status).toBe("pass");
    const persisted: TestReport = JSON.parse(fs.readFileSync(path.join(outputDir, "results.json"), "utf8"));
    expect(persisted.results[0]?.verification).toEqual(result.verification);
    expect(result.screenshots?.every((entry) => fs.existsSync(path.join(outputDir, entry.path)))).toBe(true);
  });

  it("preserves legacy screenshot count, report fields, and LLM input", async () => {
    const { runner, driver } = createRunner({
      id: "legacy", action: "wait", verify: "ready", verifyProblems: { errors: 0 },
    }, "legacy");
    const verify = vi.spyOn(configureLlm(runner), "verifyStep")
      .mockResolvedValue({ passed: true, confidence: 1, reasoning: "Ready" });
    const report = await runner.run();
    expect(driver.screenshot).toHaveBeenCalledTimes(2);
    expect(verify.mock.calls[0]?.[4]).toBeUndefined();
    expect(report.results[0]).toEqual({
      stepId: "legacy", action: "wait", status: "pass", reason: undefined,
      duration: expect.any(Number), screenshot: expect.stringContaining("_after.png"),
    });
    expect(report.analysis).toBeUndefined();
    expect(report.evidence).toBeUndefined();
  });

  it("keeps failed-attempt diagnostics and screenshot identities after a successful retry", async () => {
    const { runner, driver, outputDir } = createRunner({
      id: "retry", action: "wait", retries: 1, verifyNotification: "Ready",
    });
    vi.spyOn(driver, "getNotifications")
      .mockResolvedValueOnce(["Loading"])
      .mockResolvedValueOnce(["Ready api-key=private-test-value"]);

    const report = await runner.run();
    const result = report.results[0]!;
    expect(result.status).toBe("pass");
    expect(result.attempts?.map((entry) => entry.status)).toEqual(["fail", "pass"]);
    expect(result.attempts?.[0]?.verification?.checks[0]?.actual).toEqual({ notifications: ["Loading"] });
    expect(result.verification?.checks[0]?.actual).toEqual({ notifications: ["Ready api-key=<redacted>"] });
    const failurePath = result.attempts![0]!.evidence!.artifactPath!;
    expect(fs.existsSync(path.join(outputDir, failurePath))).toBe(true);
    const manifest: EvidenceBundleManifest = JSON.parse(fs.readFileSync(
      path.join(outputDir, "evidence", "manifest.json"), "utf8",
    ));
    expect(manifest.artifacts).toContainEqual(expect.objectContaining({
      type: "diagnostics", path: failurePath, stepId: "retry", attempt: 1,
    }));
    for (const attempt of result.attempts!) {
      for (const screenshot of attempt.screenshots!) {
        expect(manifest.artifacts).toContainEqual(expect.objectContaining({
          path: screenshot.path, stepId: "retry", attempt: attempt.attempt, phase: screenshot.phase,
        }));
      }
    }
    const selected = runner["collectCaseScreenshots"](report.results).map((entry) => entry.label);
    expect(selected).toEqual([
      path.basename(result.attempts![0]!.screenshots![0]!.path),
      path.basename(result.attempts![0]!.screenshots![2]!.path),
      path.basename(result.attempts![1]!.screenshots![2]!.path),
    ]);
    for (const file of ["results.json", path.join("evidence", "execution.json")]) {
      expect(fs.readFileSync(path.join(outputDir, file), "utf8")).not.toContain("private-test-value");
    }
  });

  it("does not overwrite diagnostics when every attempt fails", async () => {
    const { runner, driver, outputDir } = createRunner({
      id: "all-fail", action: "wait", retries: 1, verifyNotification: "Ready",
    });
    vi.spyOn(driver, "getNotifications").mockResolvedValue(["Loading"]);
    vi.mocked(driver.getProblemsCount)
      .mockResolvedValueOnce({ errors: 1, warnings: 0 })
      .mockResolvedValueOnce({ errors: 2, warnings: 0 });
    const report = await runner.run();
    const attempts = report.results[0]!.attempts!;
    const paths = attempts.map((entry) => entry.evidence!.artifactPath!);
    expect(new Set(paths).size).toBe(2);
    const contents = paths.map((file) => JSON.parse(fs.readFileSync(path.join(outputDir, file), "utf8")));
    expect(contents.map((entry) => entry.problemCounts.errors)).toEqual([1, 2]);
  });

  it("records screenshot and model failures without changing the deterministic verdict", async () => {
    const { runner, driver, outputDir } = createRunner({
      id: "unavailable", action: "wait", verify: "Ready", verifyProblems: { errors: 0 },
    });
    vi.mocked(driver.screenshot).mockImplementation(async (filePath) => {
      if (filePath!.endsWith("_verified.png")) throw new Error("capture unavailable");
      fs.writeFileSync(filePath!, "png");
      return Buffer.from("png");
    });
    vi.spyOn(configureLlm(runner), "verifyStep").mockRejectedValue(new Error("invalid model JSON"));

    const report = await runner.run();
    const result = report.results[0]!;
    expect(result.status).toBe("pass");
    expect(result.llmVerification).toBeUndefined();
    expect(result.collectionErrors).toEqual([
      "Screenshot verified failed: capture unavailable",
      "LLM verification unavailable: invalid model JSON",
    ]);
    expect(result.screenshots?.map((entry) => entry.phase)).toEqual(["before", "after"]);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "evidence", "manifest.json"), "utf8"));
    expect(manifest.collectionErrors).toEqual(expect.arrayContaining(result.collectionErrors!));
  });

  it("marks an action error as not verified, rather than an assertion pass", async () => {
    const { runner } = createRunner({
      id: "action-error", action: "open file Missing.java", verifyProblems: { errors: 0 },
    });
    vi.mocked(runner["actionResolver"].resolve).mockRejectedValue(new Error("action failed"));
    const report = await runner.run();
    expect(report.results[0]?.status).toBe("error");
    expect(report.results[0]?.verification).toEqual({ status: "not-run", checks: [] });
    expect(report.results[0]?.screenshots?.map((entry) => entry.phase)).toEqual(["before", "error"]);
  });

  it("retains sub-screenshots and their attempt metadata", async () => {
    const { runner, driver, outputDir } = createRunner({ id: "menu", action: "wait" });
    vi.mocked(runner["actionResolver"].resolve).mockImplementation(async () => {
      await driver.subScreenshot("menu open");
      return true;
    });
    const report = await runner.run();
    expect(report.results[0]?.screenshots?.map((entry) => entry.phase)).toEqual([
      "before", "sub", "after", "verified",
    ]);
    const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, "evidence", "manifest.json"), "utf8"));
    expect(manifest.artifacts).toContainEqual(expect.objectContaining({
      phase: "sub", stepId: "menu", attempt: 1,
    }));
  });
});
