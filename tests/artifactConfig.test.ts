import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadArtifactConfig, mergeArtifactOptions, parseArtifactOptions } from "../src/operators/artifactConfig.js";
import { loadTestPlan } from "../src/operators/planParser.js";
import { TestRunner } from "../src/operators/testRunner.js";
import type { ArtifactSource, TestPlan } from "../src/types.js";

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-artifact-config-")); });
afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

const source: ArtifactSource = { id: "logs", root: "workspace", include: ["**/*.log"], destination: "logs/custom" };
const plan: TestPlan = { name: "Artifacts", setup: { extension: "" }, steps: [{ id: "ready", action: "wait" }] };

describe("artifact configuration", () => {
  it("is opt-in and does not enable probes, logging or case analysis", () => {
    expect(parseArtifactOptions(undefined)).toBeUndefined();
    const legacy = new TestRunner(plan, { noLLM: true });
    expect(legacy["artifactOptions"]).toBeUndefined();
    const enabled = new TestRunner(plan, { noLLM: true, outputDir: root, artifacts: { sources: [source] } });
    expect(enabled["artifactOptions"]?.sources).toEqual([source]);
    expect(enabled["analysisMode"]).toBe("legacy");
    expect(enabled["logDirectory"]).toBeNull();
    expect(enabled["driver"]["options"].enableEvidenceProbe).toBe(false);
    expect(fs.readdirSync(root)).toEqual([]);
  });

  it("requires an output directory only when artifacts are enabled", () => {
    expect(() => new TestRunner(plan, { artifacts: {} })).toThrow("outputDir");
    expect(() => new TestRunner({ ...plan, artifacts: {} }, { artifacts: { enabled: false }, noLLM: true })).not.toThrow();
  });

  it("resolves plan and shared-file paths at their own base directories", () => {
    const configDir = path.join(root, "shared");
    const planDir = path.join(root, "plans");
    fs.mkdirSync(configDir);
    fs.mkdirSync(planDir);
    const config = path.join(configDir, "artifacts.yaml");
    fs.writeFileSync(config, "artifacts:\n  sources:\n    - id: external\n      root: {path: ../external}\n      include: ['*.log']\n      destination: attachments/external\n");
    expect(loadArtifactConfig(config).sources?.[0].root).toEqual({ path: path.join(root, "external") });
    const yaml = path.join(planDir, "plan.yaml");
    fs.writeFileSync(yaml, "name: Paths\nartifacts:\n  sources:\n    - id: local\n      root: {path: ./local}\n      include: ['*.log']\n      destination: attachments/local\nsetup:\n  extension: publisher.extension\nsteps:\n  - action: wait\n");
    const loaded = loadTestPlan(yaml);
    expect(loaded.artifacts?.sources?.[0].root).toEqual({ path: path.join(planDir, "local") });
    const runner = new TestRunner(loaded, { outputDir: path.join(root, "results"), artifactsConfig: config, noLLM: true });
    expect(runner["artifactOptions"]?.sources?.map(entry => entry.id)).toEqual(["local"]);
    const override = new TestRunner(loaded, {
      outputDir: path.join(root, "results"), artifactsConfig: config, artifacts: { enabled: false }, noLLM: true,
    });
    expect(override["artifactOptions"]).toBeUndefined();
  });

  it("merges scalar and limit fields but replaces source arrays, including an empty array", () => {
    const merged = mergeArtifactOptions(
      { enabled: true, sources: [source], limits: { maxFiles: 10, maxTotalBytes: 100 } },
      { limits: { maxFiles: 2 }, sources: [] },
      { enabled: false },
    );
    expect(merged).toEqual({ enabled: false, sources: [], limits: { maxFiles: 2, maxTotalBytes: 100 } });
  });

  it("normalizes Windows globs while keeping environment roots unresolved", () => {
    const parsed = parseArtifactOptions({ sources: [{
      ...source, root: { env: "RUN_LOGS", path: "nested\\logs" },
      include: ["**\\*.log"], destination: "logs\\custom",
    }] });
    expect(parsed?.sources?.[0]).toEqual({
      ...source, root: { env: "RUN_LOGS", path: "nested/logs" }, include: ["**/*.log"],
    });
  });

  it.each([
    null, true, [], "logs", { level: "debug" }, { enabled: "true" }, { sources: {} },
    { limits: { maxFiles: 0 } }, { limits: { maxFileBytes: -1 } },
    { limits: { maxTotalBytes: 1.5 } }, { limits: { maxFiles: Infinity } },
    { limits: { maxDepth: 2 } },
  ])("rejects invalid top-level options (%j)", value => {
    expect(() => parseArtifactOptions(value)).toThrow();
  });

  it.each([
    { id: "" }, { id: "../logs" }, { root: "home" }, { root: { env: "BAD-NAME" } },
    { root: { env: "HOME", path: "../other" } }, { root: { path: "" } },
    { root: { path: "logs", extra: true } }, { include: [] }, { include: ["/logs/**"] },
    { include: ["C:\\logs\\*"] }, { include: ["../logs/*"] }, { include: ["!*.log"] },
    { include: ["**\0"] }, { exclude: [4] }, { destination: "../outside" },
    { destination: "logs//custom" }, { destination: "evidence/logs" },
    { destination: "screenshots" }, { destination: "results.json" },
    { destination: "logs:stream" }, { destination: "logs/*" }, { phase: "before" },
    { optional: "true" }, { platforms: ["windows"] }, { platforms: [] },
    { modifiedSince: "yesterday" }, { format: "auto" }, { evidence: true },
    { format: "binary", evidence: "tail" }, { command: "cat logs" },
  ])("rejects invalid source fields (%j)", override => {
    expect(() => parseArtifactOptions({ sources: [{ ...source, ...override }] })).toThrow();
  });

  it("rejects duplicate ids and overlapping destinations before running", () => {
    expect(() => parseArtifactOptions({ sources: [source, { ...source, destination: "other" }] })).toThrow("Duplicate");
    expect(() => parseArtifactOptions({ sources: [source, { ...source, id: "other", destination: "LOGS/custom/child" }] })).toThrow("overlaps");
  });

  it("rejects shared files with misspelled or missing artifacts sections", () => {
    const file = path.join(root, "bad.yaml");
    fs.writeFileSync(file, "artifact: {enabled: true}");
    expect(() => loadArtifactConfig(file)).toThrow("Unknown");
    fs.writeFileSync(file, "{}");
    expect(() => loadArtifactConfig(file)).toThrow("artifacts section");
  });
});
