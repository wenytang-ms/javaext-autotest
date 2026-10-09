import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root: string;
let plans: string;
let results: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-cli-logging-"));
  plans = path.join(root, "plans");
  results = path.join(root, "results");
  fs.mkdirSync(plans);
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function writePlan(name: string, logging = ""): string {
  const file = path.join(plans, `${name}.yaml`);
  fs.writeFileSync(file, `name: "${name}"\n${logging}setup:\n  extension: "publisher.extension"\nsteps:\n  - id: ready\n    action: wait\n`);
  return file;
}

function cli(args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--import", pathToFileURL(path.join(repository, "tests", "fixtures", "loggingDriver.ts")).href,
    path.join(repository, "src", "cli", "index.ts"), ...args,
  ], { cwd: repository, encoding: "utf8", timeout: 30_000 });
}

describe("CLI configured logging", () => {
  it.each([
    { flags: ["--logs"], yaml: "", logDirectory: () => path.join(results, "logs") },
    { flags: ["--log-output", "custom"], yaml: "", logDirectory: () => path.resolve(repository, "custom") },
    { flags: [], yaml: "logging:\n  enabled: true\n  outputDir: custom\n", logDirectory: () => path.join(plans, "custom") },
  ])("captures logs for $flags / YAML configuration without changing legacy failure reports", ({ flags, yaml, logDirectory }) => {
    const resolvedFlags = flags[0] === "--log-output" ? ["--log-output", path.join(root, "custom")] : flags;
    const destination = flags[0] === "--log-output" ? path.join(root, "custom") : logDirectory();
    const result = cli(["run", writePlan("failure", yaml), "--output", results, "--no-llm", ...resolvedFlags]);
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(1);
    const log = fs.readFileSync(path.join(destination, "autotest.log"), "utf8");
    expect(log).toContain("fixture stdout api-key=<redacted>");
    expect(log).toContain("fixture stderr");
    expect(log).toContain("ECONNREFUSED");
    expect(log).not.toContain("fixture-log-placeholder");
    expect(result.stdout).toContain("fixture-log-placeholder");
    const fatal = JSON.parse(fs.readFileSync(path.join(destination, "runner-failure.log"), "utf8"));
    expect(fatal.name).toBe("AggregateError");
    expect(fatal.errors[0]).toMatchObject({ code: "ECONNREFUSED", address: "::1", port: 443 });
    expect(fs.readFileSync(path.join(destination, "runner-launch.log"), "utf8")).toContain("resolve-vscode");
    expect(fs.existsSync(path.join(destination, "environment.json"))).toBe(true);
    const report = JSON.parse(fs.readFileSync(path.join(results, "results.json"), "utf8"));
    expect(report.crashed).toBe(true);
    expect(report.crashReason).toBe("");
    expect(report.analysis).toBeUndefined();
    expect(report.evidence).toBeUndefined();
  }, 40_000);

  it.each([false, true])("keeps file logging off by default or by explicit override (override=%s)", override => {
    const result = cli([
      "run", writePlan("disabled", override ? "logging:\n  enabled: true\n" : ""),
      "--output", results, "--no-llm", ...(override ? ["--no-logs"] : []),
    ]);
    expect(result.status).toBe(1);
    expect(fs.existsSync(path.join(results, "logs"))).toBe(false);
    expect(result.stdout).toContain("fixture stdout");
  }, 40_000);

  it("routes run-all CLI logs to distinct per-plan directories", () => {
    writePlan("first");
    writePlan("second");
    const logs = path.join(root, "all-logs");
    const result = cli(["run-all", plans, "--output", results, "--no-llm", "--log-output", logs]);
    expect(result.status, result.stderr).toBe(1);
    for (const name of ["first", "second"]) {
      expect(fs.existsSync(path.join(logs, name, "autotest.log"))).toBe(true);
      expect(fs.existsSync(path.join(logs, name, "runner-failure.log"))).toBe(true);
      expect(fs.existsSync(path.join(results, name, "results.json"))).toBe(true);
    }
  }, 40_000);

  it("reports contradictory logging flags explicitly", () => {
    const result = cli(["run", writePlan("invalid"), "--no-logs", "--log-output", path.join(root, "logs")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--no-logs cannot be combined with --log-output");
  }, 40_000);
});
