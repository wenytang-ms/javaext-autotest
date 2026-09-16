import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { TestReport } from "../src/types.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let outputDir: string;
let reportPath: string;

beforeEach(() => {
  outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-cli-summary-"));
  const caseDir = path.join(outputDir, "failed-case");
  fs.mkdirSync(caseDir);
  reportPath = path.join(caseDir, "results.json");
  const report: TestReport = {
    planName: "Failed case",
    startTime: "2026-09-15T00:00:00.000Z",
    endTime: "2026-09-15T00:00:01.000Z",
    duration: 1_000,
    results: [{
      stepId: "ready",
      action: "wait",
      status: "error",
      reason: "Runtime initialization timed out",
      duration: 1_000,
    }],
    summary: { total: 1, passed: 0, failed: 0, errors: 1, skipped: 0 },
  };
  fs.writeFileSync(reportPath, JSON.stringify(report));
});

afterEach(() => {
  fs.rmSync(outputDir, { recursive: true, force: true });
});

describe("analyze CLI summary output", () => {
  it.each([
    { mode: "case", reportOnly: true, exitCode: 0, heading: "## AI Analysis — TL;DR" },
    { mode: "case", reportOnly: false, exitCode: 1, heading: "## AI Analysis — TL;DR" },
    { mode: "legacy", reportOnly: true, exitCode: 0, heading: "## E2E Test Results" },
  ])("writes the $mode layout without changing report-only=$reportOnly exit behavior", ({ mode, reportOnly, exitCode, heading }) => {
    const original = fs.readFileSync(reportPath, "utf8");
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      path.join(root, "src", "cli", "index.ts"),
      "analyze", outputDir,
      "--analysis-mode", mode,
      "--no-llm",
      ...(reportOnly ? ["--report-only"] : []),
    ], { cwd: root, encoding: "utf8", timeout: 20_000 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(exitCode);
    const markdown = fs.readFileSync(path.join(outputDir, "summary.md"), "utf8");
    expect(markdown.startsWith(heading)).toBe(true);
    expect(markdown).toContain("Runtime initialization timed out");
    expect(fs.readFileSync(reportPath, "utf8")).toBe(original);
  }, 30_000);

  it("reuses an existing case diagnosis and preserves full recorded errors without making LLM calls", () => {
    const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as TestReport;
    const fullReason = `${"Long diagnostic context. ".repeat(12)}COMPLETE_REASON_END`;
    report.results[0].reason = fullReason;
    report.analysis = {
      schemaVersion: 1,
      mode: "case",
      case: {
        schemaVersion: 1,
        kind: "failure-root-cause",
        assessment: "inconclusive",
        summary: "Saved diagnosis survives aggregate unavailability.",
        earliestDivergence: { stepId: "ready", observation: "Runtime did not become ready." },
        rootCauses: [],
        falsePassRisks: [],
        evidenceGaps: ["No startup trace was captured."],
        confidence: 0.4,
      },
    };
    fs.writeFileSync(reportPath, JSON.stringify(report));
    const result = spawnSync(process.execPath, [
      "--import", "tsx",
      path.join(root, "src", "cli", "index.ts"),
      "analyze", outputDir,
      "--analysis-mode", "case",
      "--no-llm",
      "--report-only",
    ], { cwd: root, encoding: "utf8", timeout: 20_000 });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr || result.stdout).toBe(0);
    const markdown = fs.readFileSync(path.join(outputDir, "summary.md"), "utf8");
    expect(markdown).toContain("Saved diagnosis survives aggregate unavailability.");
    expect(markdown).toContain("No startup trace was captured.");
    expect(markdown).toContain(fullReason);
    expect(markdown).toContain("Raw execution failures");
  }, 30_000);
});
