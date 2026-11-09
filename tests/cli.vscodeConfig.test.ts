import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import yaml from "js-yaml";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let root: string;
let plans: string;
let capture: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-cli-vscode-config-"));
  plans = path.join(root, "plans");
  capture = path.join(root, "capture.jsonl");
  fs.mkdirSync(plans);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function cli(args: string[]) {
  return spawnSync(process.execPath, [
    "--import", "tsx", "--import", pathToFileURL(path.join(repository, "tests", "fixtures", "configDriver.ts")).href,
    path.join(repository, "src", "cli", "index.ts"), ...args,
  ], {
    cwd: repository, encoding: "utf8", timeout: 30_000,
    env: { ...process.env, VSCODE_CONFIG_TEST_CAPTURE: capture },
  });
}

function plan(name: string, setup: Record<string, unknown> = {}): string {
  const file = path.join(plans, `${name}.yaml`);
  fs.writeFileSync(file, yaml.dump({
    name, setup: { extension: "publisher.test", ...setup },
    steps: [{ id: "ready", action: "wait 0 seconds" }],
  }));
  return file;
}

function config(name: string, value: unknown): string {
  const file = path.join(root, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("shared environment CLI forwarding", () => {
  it("replaces the plan reference, applies locale override, and retains plan setting precedence", () => {
    const original = config("original", { schemaVersion: 1, settings: { original: true } });
    const replacement = config("replacement", {
      schemaVersion: 1, vscodeVersion: "stable", locale: "zh-cn",
      settings: { shared: true, "editor.fontSize": 17 },
    });
    const file = plan("case", { vscodeConfig: original, settings: { "editor.fontSize": 20 } });
    const result = cli([
      "run", file, "--vscode-config", replacement, "--locale", "EN-US",
      "--output", path.join(root, "results"), "--no-llm",
    ]);
    expect(result.status, result.stderr).toBe(0);
    const options = JSON.parse(fs.readFileSync(capture, "utf8").trim());
    expect(options).toMatchObject({
      vscodeVersion: "stable", locale: "en", configuredEnvironment: true,
      settings: { shared: true, "editor.fontSize": 20 },
    });
    expect(options.settings).not.toHaveProperty("original");
  }, 40_000);

  it("applies the same shared configuration to each run-all plan", () => {
    plan("first");
    plan("second");
    const file = config("shared", { schemaVersion: 1, vscodeVersion: "stable", settings: { "editor.tabSize": 3 } });
    const result = cli(["run-all", plans, "--vscode-config", file, "--output", path.join(root, "results"), "--no-llm"]);
    expect(result.status, result.stderr).toBe(0);
    const captured = fs.readFileSync(capture, "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(captured).toHaveLength(2);
    for (const options of captured) {
      expect(options).toMatchObject({
        configuredEnvironment: true, vscodeVersion: "stable", settings: { "editor.tabSize": 3 },
      });
      expect(options).not.toHaveProperty("locale");
    }
  }, 40_000);

  it("rejects invalid referenced configuration in validate and run before Driver launch", () => {
    const file = config("invalid", { schemaVersion: 1, language: "zh-cn" });
    const scenario = plan("invalid", { vscodeConfig: file });
    for (const args of [["validate", scenario], ["run", scenario, "--no-llm"]]) {
      const result = cli(args);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown VS Code configuration option: language");
    }
    expect(fs.existsSync(capture)).toBe(false);
  }, 40_000);
});
