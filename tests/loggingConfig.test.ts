import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTestPlan } from "../src/operators/planParser.js";
import { TestRunner } from "../src/operators/testRunner.js";
import { parseLoggingOptions } from "../src/operators/runLogging.js";
import type { TestPlan } from "../src/types.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-logging-config-")); });
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

const plan: TestPlan = { name: "Logging config", setup: { extension: "" }, steps: [{ id: "ready", action: "wait" }] };

describe("logging configuration", () => {
  it("keeps logging, diagnostic probes and legacy analysis unchanged when absent", () => {
    const runner = new TestRunner(plan, { noLLM: true });
    expect(runner["logDirectory"]).toBeNull();
    expect(runner["diagnosticCollector"]).toBeNull();
    expect(runner["evidenceCollector"]).toBeNull();
    expect(runner["driver"]["options"].enableEvidenceProbe).toBe(false);
    expect(runner["driver"]["options"].enableLaunchDiagnostics).toBe(false);
  });

  it("enables standalone logs without switching the analysis pipeline", () => {
    const runner = new TestRunner(plan, { noLLM: true, outputDir: root, logging: {} });
    expect(runner["logDirectory"]).toBe(path.join(root, "logs"));
    expect(runner["analysisMode"]).toBe("legacy");
    expect(runner["evidenceCollector"]).toBeNull();
    expect(runner["diagnosticCollector"]).not.toBeNull();
    expect(runner["driver"]["options"].enableEvidenceProbe).toBe(true);
    expect(runner["driver"]["options"].enableLaunchDiagnostics).toBe(true);
  });

  it("resolves YAML log paths relative to the plan and lets SDK options override them", () => {
    const file = path.join(root, "plan.yaml");
    fs.writeFileSync(file, 'name: Logging YAML\nlogging:\n  outputDir: "./custom-logs"\nsetup:\n  extension: "publisher.extension"\nsteps:\n  - action: wait\n');
    const loaded = loadTestPlan(file);
    expect(loaded.logging?.outputDir).toBe(path.join(root, "custom-logs"));
    expect(new TestRunner(loaded, { noLLM: true })["logDirectory"]).toBe(path.join(root, "custom-logs"));
    expect(new TestRunner(loaded, { noLLM: true, logging: { enabled: false } })["logDirectory"]).toBeNull();
    const override = path.join(root, "override");
    expect(new TestRunner(loaded, { noLLM: true, logging: { outputDir: override } })["logDirectory"]).toBe(override);
  });

  it("does not enable configured logs just because evidence mode is active", () => {
    const runner = new TestRunner(plan, { noLLM: true, analysisMode: "evidence-only" });
    expect(runner["evidenceCollector"]).not.toBeNull();
    expect(runner["logDirectory"]).toBeNull();
    expect(runner["driver"]["options"].enableLaunchDiagnostics).toBe(false);
  });

  it.each([false, true])("preserves successful legacy reports with logging enabled=%s", async enabled => {
    const outputDir = path.join(root, "results");
    const logDirectory = path.join(root, "logs");
    const runner = new TestRunner(plan, {
      outputDir, noLLM: true, logging: { enabled, outputDir: logDirectory },
    });
    const driver = runner["driver"];
    vi.spyOn(driver, "launch").mockImplementation(async () => { process.stdout.write("successful launch\n"); });
    vi.spyOn(driver, "wait").mockResolvedValue();
    vi.spyOn(driver, "close").mockResolvedValue();
    vi.spyOn(driver, "refreshProbeSnapshot").mockResolvedValue();
    vi.spyOn(runner["actionResolver"], "resolve").mockResolvedValue(true);
    vi.spyOn(driver, "screenshot").mockImplementation(async file => {
      const buffer = Buffer.from("test screenshot");
      fs.writeFileSync(file!, buffer);
      return buffer;
    });
    const report = await runner.run();
    expect(report.summary).toEqual({ total: 1, passed: 1, failed: 0, skipped: 0, errors: 0 });
    expect(report.crashed).toBeUndefined();
    expect(report.evidence).toBeUndefined();
    expect(report.analysis).toBeUndefined();
    expect(report.results[0].verification).toBeUndefined();
    expect(fs.existsSync(path.join(logDirectory, "autotest.log"))).toBe(enabled);
    if (enabled) expect(fs.readFileSync(path.join(logDirectory, "autotest.log"), "utf8")).toContain("successful launch");
  });

  it.each([null, true, [], "logs", { enabled: "true" }, { outputDir: "" }, { outputDir: " " }, { outputDir: 42 }, { level: "debug" }])(
    "rejects invalid configuration instead of silently falling back (%j)",
    config => { expect(() => parseLoggingOptions(config)).toThrow(); },
  );
});
