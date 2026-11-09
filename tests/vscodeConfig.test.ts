import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import yaml from "js-yaml";
import { loadTestPlan, validateTestPlanFile } from "../src/operators/planParser.js";
import { loadVscodeConfig } from "../src/operators/vscodeConfig.js";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-vscode-config-test-"));
  fs.mkdirSync(path.join(root, "plans"));
  fs.mkdirSync(path.join(root, "configs"));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function config(name: string, value: unknown): string {
  const file = path.join(root, "configs", `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
}

function plan(setup: Record<string, unknown> = {}): string {
  const file = path.join(root, "plans", "case.yaml");
  fs.writeFileSync(file, yaml.dump({
    name: "Configuration case", setup: { extension: "publisher.test", ...setup },
    steps: [{ id: "ready", action: "wait 0 seconds" }],
  }));
  return file;
}

describe("opt-in VS Code environment configuration", () => {
  it("keeps legacy defaults and ignores config files that were not referenced", () => {
    config("vscode", { invalid: true });
    const setup = loadTestPlan(plan()).setup;
    expect(setup.vscodeVersion).toBe("insiders");
    expect(setup).not.toHaveProperty("vscodeConfig");
    expect(setup).not.toHaveProperty("locale");
  });

  it("merges settings by key, combines extensions, and resolves VSIX paths at their source", () => {
    const file = config("zh", {
      schemaVersion: 1, locale: "ZH-CN", vscodeVersion: "stable", preRelease: true,
      extensions: ["language.pack", "publisher.shared"], vsix: ["base.vsix"],
      settings: { "editor.fontSize": 17, "editor.codeActionsOnSave": { first: "explicit" } },
      workspaceSettings: { "editor.tabSize": 3 },
    });
    const setup = loadTestPlan(plan({
      vscodeConfig: "../configs/zh.json",
      extensions: ["publisher.shared", "publisher.extra"], vsix: ["plan.vsix"],
      preRelease: false,
      settings: { "editor.codeActionsOnSave": { second: "never" } },
      workspaceSettings: { "files.autoSave": "off" },
    })).setup;
    expect(setup.vscodeConfig).toBe(file);
    expect(setup.locale).toBe("zh-cn");
    expect(setup.vscodeVersion).toBe("stable");
    expect(setup.preRelease).toBe(false);
    expect(setup.extensions).toEqual(["language.pack", "publisher.shared", "publisher.extra"]);
    expect(setup.vsix).toEqual([path.join(root, "configs", "base.vsix"), path.join(root, "plans", "plan.vsix")]);
    expect(setup.settings).toEqual({ "editor.fontSize": 17, "editor.codeActionsOnSave": { second: "never" } });
    expect(setup.workspaceSettings).toEqual({ "editor.tabSize": 3, "files.autoSave": "off" });
  });

  it("replaces the shared reference via CLI/SDK options while retaining plan overrides", () => {
    config("original", { schemaVersion: 1, locale: "zh-cn", settings: { "editor.fontSize": 10 } });
    const replacement = config("replacement", {
      schemaVersion: 1, locale: "fr", vscodeVersion: "stable", settings: { "editor.fontSize": 20 },
    });

    const file = plan({ vscodeConfig: "../configs/original.json", vscodeVersion: "insiders" });
    const setup = loadTestPlan(file, { vscodeConfig: replacement, locale: "EN" }).setup;
    expect(setup.vscodeConfig).toBe(replacement);
    expect(setup.locale).toBe("en");
    expect(setup.vscodeVersion).toBe("insiders");
    expect(setup.settings).toEqual({ "editor.fontSize": 20 });
  });

  it("normalizes built-in English locales and deduplicates case-insensitive extension IDs", () => {
    config("en", { schemaVersion: 1, locale: "en-US", extensions: ["Publisher.Shared"] });
    const setup = loadTestPlan(plan({
      vscodeConfig: "../configs/en.json", extensions: ["publisher.shared"],
    })).setup;
    expect(setup.locale).toBe("en");
    expect(setup.extensions).toEqual(["publisher.shared"]);
  });

  it.each([
    [{ schemaVersion: 2 }, "schemaVersion"],
    [{ schemaVersion: 1, launchArgs: [] }, "Unknown"],
    [{ schemaVersion: 1, locale: "zh_CN" }, "locale"],
    [{ schemaVersion: 1, locale: "" }, "locale"],
    [{ schemaVersion: 1, extensions: [false] }, "extensions"],
    [{ schemaVersion: 1, settings: [] }, "settings"],
    [{ schemaVersion: 1, preRelease: "false" }, "preRelease"],
    [{ schemaVersion: 1, vscodeVersion: "latest" }, "vscodeVersion"],
  ])("rejects malformed referenced configuration %j during validation", (value, error) => {
    const file = config("bad", value);
    const result = validateTestPlanFile(plan({ vscodeConfig: file }));
    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain(error);
  });

  it("rejects missing files, invalid JSON, and invalid locale overrides before launch", () => {
    expect(validateTestPlanFile(plan({ vscodeConfig: "../missing.json" })).valid).toBe(false);
    const bad = config("invalid-json", {});
    fs.writeFileSync(bad, "{broken");
    expect(() => loadVscodeConfig(bad)).toThrow();
    expect(validateTestPlanFile(plan(), { locale: "--disable-extensions" }).valid).toBe(false);
  });
});
