import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";
import type { ArtifactCollectionManifest, ArtifactSource, TestReport } from "../src/types.js";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root: string;
let results: string;
let plans: string;
let staging: string;
let config: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-cli-artifacts-"));
  results = path.join(root, "case results");
  plans = path.join(root, "plans");
  staging = path.join(root, "staging");
  config = path.join(root, "artifacts.yaml");
  fs.mkdirSync(plans);
  fs.mkdirSync(staging);
  const sources: ArtifactSource[] = [
    { id: "runtime", root: "workspace", include: [".autotest/**"], destination: "diagnostics/runtime", evidence: "tail" },
    { id: "ide", root: "userData", include: ["logs/**"], destination: "logs/ide" },
    { id: "external", root: { path: "./staging" }, include: ["**/*"], destination: "diagnostics/ci", phase: "collect", optional: true },
  ];
  fs.writeFileSync(config, yaml.dump({ artifacts: { sources } }));
});
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

function cli(args: string[], mode = "") {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--import", pathToFileURL(path.join(repository, "tests", "fixtures", "artifactDriver.ts")).href,
    path.join(repository, "src", "cli", "index.ts"), ...args,
  ], {
    cwd: repository, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, ARTIFACT_TEST_RUNTIME_ROOT: path.join(root, "runtime"), ARTIFACT_TEST_MODE: mode },
  });
}

function plan(name = "case", artifacts?: unknown): string {
  const file = path.join(plans, `${name}.yaml`);
  fs.writeFileSync(file, yaml.dump({
    name, ...(artifacts ? { artifacts } : {}), setup: { extension: "publisher.extension" },
    steps: [{ id: "ready", action: "wait 0 seconds" }],
  }));
  return file;
}

function manifest(output = results): ArtifactCollectionManifest {
  return JSON.parse(fs.readFileSync(path.join(output, "artifacts", "manifest.json"), "utf8"));
}

describe("CLI artifact lifecycle", () => {
  it("runs with shared config, then collects external files without changing reports or evidence", () => {
    const run = cli(["run", plan(), "--output", results, "--artifacts-config", config, "--no-llm", "--analysis-mode", "evidence-only"]);
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    const reportPath = path.join(results, "results.json");
    const before = fs.readFileSync(reportPath);
    const report: TestReport = JSON.parse(before.toString());
    expect(report.artifacts?.files).toBe(2);
    expect(report.evidence?.logs[0].tail).toContain("flushed before workspace cleanup");
    const evidencePath = path.join(results, report.analysis!.evidenceManifest!);
    const evidenceBefore = fs.readFileSync(evidencePath);
    expect(fs.existsSync(path.join(root, "runtime", "workspace"))).toBe(false);
    fs.writeFileSync(path.join(staging, "console.log"), "finished console log");
    const collected = cli(["collect", "--output", results, "--artifacts-config", config]);
    expect(collected.status, collected.stderr).toBe(0);
    expect(manifest().sources.reduce((sum, source) => sum + source.files.length, 0)).toBe(3);
    expect(fs.readFileSync(reportPath)).toEqual(before);
    expect(fs.readFileSync(evidencePath)).toEqual(evidenceBefore);
    expect(cli(["collect", "--output", results, "--artifacts-config", config]).status).toBe(0);
    expect(manifest().sources.reduce((sum, source) => sum + source.files.length, 0)).toBe(3);
  }, 40_000);

  it.each(["launch-failure", "cancel"])("archives runtime files on %s and preserves the original exit status", mode => {
    const run = cli(["run", plan(), "--output", results, "--artifacts-config", config, "--no-llm"], mode);
    expect(run.error).toBeUndefined();
    expect(run.status, run.stderr).toBe(mode === "cancel" ? 130 : 1);
    expect(manifest().sources.reduce((sum, source) => sum + source.files.length, 0)).toBe(2);
    if (mode === "launch-failure") {
      const report: TestReport = JSON.parse(fs.readFileSync(path.join(results, "results.json"), "utf8"));
      expect(report.crashed).toBe(true);
      expect(report.crashReason).toBe("controlled CLI launch failure");
    }
  }, 40_000);

  it("keeps logging enabled independently when artifacts are explicitly disabled", () => {
    const run = cli(["run", plan(), "--output", results, "--artifacts-config", config, "--no-artifacts", "--logs", "--no-llm"]);
    expect(run.status, run.stderr).toBe(0);
    expect(fs.existsSync(path.join(results, "artifacts"))).toBe(false);
    expect(fs.existsSync(path.join(results, "logs", "autotest.log"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(results, "results.json"), "utf8")).artifacts).toBeUndefined();
  }, 40_000);

  it("isolates shared artifact sources in every run-all case", () => {
    plan("first");
    plan("second");
    const run = cli(["run-all", plans, "--output", results, "--artifacts-config", config, "--no-llm"]);
    expect(run.status, run.stderr).toBe(0);
    for (const name of ["first", "second"]) {
      const output = path.join(results, name);
      expect(manifest(output).sources.reduce((sum, source) => sum + source.files.length, 0)).toBe(2);
      expect(fs.existsSync(path.join(output, "results.json"))).toBe(true);
    }
  }, 40_000);

  it("allows plan sources to replace shared defaults and supports collect --plan", () => {
    const file = plan("override", { sources: [{
      id: "own", root: "workspace", include: [".autotest/**"], destination: "attachments/own",
    }] });
    const run = cli(["run", file, "--output", results, "--artifacts-config", config, "--no-llm"]);
    expect(run.status, run.stderr).toBe(0);
    expect(manifest().sources.map(source => source.id)).toEqual(["own"]);
    const collect = cli(["collect", "--output", results, "--plan", file]);
    expect(collect.status, collect.stderr).toBe(0);
    expect(manifest().sources[0].files).toHaveLength(1);
  }, 40_000);

  it("can collect external setup outputs when no AutoTest run ever started", () => {
    fs.writeFileSync(path.join(staging, "preparation.log"), "preparation failed before launch");
    fs.writeFileSync(config, yaml.dump({ artifacts: { sources: [{
      id: "preparation", root: { path: "./staging" }, include: ["*.log"], destination: "diagnostics/preparation",
    }] } }));
    const result = cli(["collect", "--output", results, "--artifacts-config", config]);
    expect(result.status, result.stderr).toBe(0);
    expect(manifest().sources[0].files).toHaveLength(1);
    expect(manifest().runStartedAt).toBeUndefined();
    expect(fs.existsSync(path.join(results, "results.json"))).toBe(false);
  }, 40_000);

  it("fails explicitly on required missing sources without creating a successful test report", () => {
    fs.writeFileSync(config, yaml.dump({ artifacts: { sources: [{
      id: "required", root: { path: "./missing" }, include: ["*.log"], destination: "diagnostics/missing",
    }] } }));
    const result = cli(["collect", "--output", results, "--artifacts-config", config]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Source directory is unavailable");
    expect(manifest().status).toBe("failed");
    expect(fs.existsSync(path.join(results, "results.json"))).toBe(false);
  }, 40_000);

  it("rejects malformed config before running a plan", () => {
    fs.writeFileSync(config, "artifacts: {unknown: true}");
    const result = cli(["run", plan(), "--output", results, "--artifacts-config", config, "--no-llm"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unknown artifacts option");
    expect(fs.existsSync(path.join(root, "runtime", "workspace"))).toBe(false);
  }, 40_000);
});
