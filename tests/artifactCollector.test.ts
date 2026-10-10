import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactCollector, summarizeArtifacts } from "../src/operators/artifactCollector.js";
import type { ArtifactCollectionManifest, ArtifactOptions, ArtifactSource } from "../src/types.js";

let root: string;
let input: string;
let output: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-artifacts-"));
  input = path.join(root, "input with spaces");
  output = path.join(root, "case output");
  fs.mkdirSync(input);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

function write(relative: string, data: string | Buffer): string {
  const file = path.join(input, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
  return file;
}

function source(overrides: Partial<ArtifactSource> = {}): ArtifactSource {
  return { id: "custom", root: { path: input }, include: ["**/*"], destination: "attachments/custom", ...overrides };
}

function collector(overrides: Partial<ArtifactSource> = {}, options: Omit<ArtifactOptions, "sources"> = {}): ArtifactCollector {
  return new ArtifactCollector(output, { ...options, sources: [source(overrides)] });
}

function readManifest(): ArtifactCollectionManifest {
  return JSON.parse(fs.readFileSync(path.join(output, "artifacts", "manifest.json"), "utf8"));
}

describe("generic artifact collection", () => {
  it("archives full files and hidden paths, preserves directories, redacts text and honors globs", () => {
    write("nested/.metadata/.log", "api-key=fake-archive-key\n" + "x".repeat(150_000));
    write("nested/event.json", '{"password":"fake-archive-password","ok":true}');
    write("nested/ignored.log", "excluded");
    write("unselected.txt", "not selected");
    const manifest = collector({
      include: ["nested\\**\\{*.log,*.json,.log}"], exclude: ["**/ignored.log"], evidence: "tail",
    }).collect();
    expect(manifest.status).toBe("complete");
    expect(manifest.sources[0].files.map(file => file.sourcePath)).toEqual(["nested/.metadata/.log", "nested/event.json"]);
    const log = manifest.sources[0].files[0];
    const archived = fs.readFileSync(path.join(output, log.path), "utf8");
    expect(archived).toContain("api-key=<redacted>");
    expect(archived.endsWith("x".repeat(150_000))).toBe(true);
    expect(archived).not.toContain("fake-archive-key");
    expect(log.sizeBytes).toBeGreaterThan(64 * 1024);
    expect(log.storedBytes).toBe(Buffer.byteLength(archived));
    expect(log.redacted).toBe(true);
    expect(JSON.parse(fs.readFileSync(path.join(output, manifest.sources[0].files[1].path), "utf8"))).toEqual({
      password: "<redacted>", ok: true,
    });
    expect(readManifest()).toEqual(manifest);
  });

  it("supports actual runtime roots and explicit environment subdirectories", () => {
    write(".autotest/compiler.log", "compiler output");
    write("logs/session/extension.log", "extension output");
    write("external/display.log", "display output");
    vi.stubEnv("ARTIFACT_TEST_ROOT", input);
    const sources = [
      source({ id: "workspace", root: "workspace", include: [".autotest/**"], destination: "diagnostics/workspace" }),
      source({ id: "ide", root: "userData", include: ["logs/**"], destination: "logs/ide" }),
      source({ id: "display", root: { env: "ARTIFACT_TEST_ROOT", path: "external" }, destination: "logs/display" }),
    ];
    const manifest = new ArtifactCollector(output, { sources }).collect({ workspace: input, userData: input });
    expect(manifest.sources.map(entry => entry.files.length)).toEqual([1, 1, 1]);
    expect(manifest.status).toBe("complete");
    expect(JSON.stringify(manifest)).not.toContain(input);
  });

  it.each(["logs/session/event.log", "logs\\session\\event.log", "logs/session/*.log"])(
    "traverses directory prefixes for nested literal and non-globstar patterns (%s)",
    pattern => {
      write("logs/session/event.log", "selected");
      write("logs/unselected.log", "not selected");
      const manifest = collector({ include: [pattern] }).collect();
      expect(manifest.status).toBe("complete");
      expect(manifest.sources[0].files.map(file => file.sourcePath)).toEqual(["logs/session/event.log"]);
    },
  );

  it("keeps optional absence visible and fails required missing sources without inventing files", () => {
    const optional = collector({ include: ["missing.log"], optional: true }).collect();
    expect(optional.status).toBe("complete");
    expect(optional.sources[0]).toMatchObject({ status: "missing", files: [], errors: [] });
    const requiredOutput = path.join(root, "required");
    const required = new ArtifactCollector(requiredOutput, { sources: [source({ root: "workspace" })] }).collect();
    expect(required.status).toBe("failed");
    expect(required.sources[0].errors).toContain("Source directory is unavailable");
  });

  it("does not collect off-platform sources", () => {
    write("event.log", "event");
    const platforms: ArtifactSource["platforms"] = [process.platform === "win32" ? "linux" : "win32"];
    const manifest = collector({ platforms }).collect();
    expect(manifest.status).toBe("complete");
    expect(manifest.sources[0].status).toBe("skipped");
    expect(manifest.sources[0].files).toEqual([]);
  });

  it("defers external writers and supplements archives after their files exist", () => {
    const runner = collector({ phase: "collect" });
    runner.beginRun(new Date(), "Deferred");
    expect(runner.collect({}, "run")).toMatchObject({ status: "partial", sources: [{ status: "deferred" }] });
    write("console.log", "final console output");
    const final = collector({ phase: "collect" }).collect();
    expect(final.status).toBe("complete");
    expect(final.sources[0].files).toHaveLength(1);
    expect(final.runStartedAt).toBeTruthy();
  });

  it("uses the persisted run start for native reports and refuses unrelated historical reports", () => {
    const old = write("old.crash", "old");
    const fresh = write("new.crash", "new");
    const started = new Date(Date.now() - 10_000);
    fs.utimesSync(old, new Date(started.getTime() - 20_000), new Date(started.getTime() - 20_000));
    fs.utimesSync(fresh, new Date(started.getTime() + 1_000), new Date(started.getTime() + 1_000));
    const runner = collector({ include: ["*.crash"], modifiedSince: "run-start", phase: "collect" });
    runner.beginRun(started, "Crash window");
    runner.collect({}, "run");
    const manifest = collector({ include: ["*.crash"], modifiedSince: "run-start", phase: "collect" }).collect();
    expect(manifest.sources[0].files.map(file => file.sourcePath)).toEqual(["new.crash"]);
    const neverStarted = new ArtifactCollector(path.join(root, "never-started"), {
      sources: [source({ modifiedSince: "run-start", optional: true })],
    }).collect();
    expect(neverStarted.sources[0]).toMatchObject({ status: "missing", files: [], reason: expect.stringContaining("Run start") });
  });

  it.each([
    { limits: { maxFiles: 2 }, count: 2, omitted: 1, error: "maxFiles" },
    { limits: { maxFileBytes: 3 }, count: 1, omitted: 2, error: "maxFileBytes" },
    { limits: { maxTotalBytes: 8 }, count: 2, omitted: 1, error: "maxTotalBytes" },
  ])("enforces exact configured limits and records omissions ($error)", ({ limits, count, omitted, error }) => {
    write("a.log", "1234");
    write("b.log", "5678");
    write("c.log", "9");
    const manifest = collector({}, { limits }).collect();
    expect(manifest.status).toBe("partial");
    expect(manifest.sources[0].files).toHaveLength(count);
    expect(manifest.sources[0].matchedFiles).toBe(3);
    expect(manifest.sources[0].omittedFiles).toBe(omitted);
    expect(manifest.sources[0].errors.join("\n")).toContain(error);
    for (const file of manifest.sources[0].files) expect(fs.statSync(path.join(output, file.path)).size).toBe(file.storedBytes);
  });

  it("makes binary copying explicit and never marks it as LLM evidence", () => {
    const data = Buffer.from([0, 255, 1, 254]);
    write("report.bin", data);
    const invalid = collector().collect();
    expect(invalid.status).toBe("failed");
    expect(invalid.sources[0].errors.join()).toContain("binary");
    const binary = new ArtifactCollector(path.join(root, "binary"), {
      sources: [source({ format: "binary" })],
    }).collect();
    const file = binary.sources[0].files[0];
    expect(file).toMatchObject({ format: "binary", redacted: false });
    expect(file.evidence).toBeUndefined();
    expect(fs.readFileSync(path.join(root, "binary", file.path))).toEqual(data);
  });

  it("rejects malformed UTF-8 instead of silently reinterpreting it as text or binary", () => {
    write("invalid.log", Buffer.from([0xff, 0xfe]));
    const manifest = collector().collect();
    expect(manifest.status).toBe("failed");
    expect(manifest.sources[0].errors.join()).toContain("encoded data");
  });

  it("is incremental and immutable, including after the runtime workspace is removed", () => {
    write("first.log", "original snapshot");
    const sources = [source({ root: "workspace" })];
    const first = new ArtifactCollector(output, { sources }).collect({ workspace: input });
    const file = { ...first.sources[0].files[0] };
    write("first.log", "later changes must not replace the evidence");
    write("second.log", "new attachment");
    const second = new ArtifactCollector(output, { sources }).collect({ workspace: input });
    expect(second.sources[0].files).toHaveLength(2);
    expect(second.sources[0].files[0]).toEqual(file);
    expect(fs.readFileSync(path.join(output, file.path), "utf8")).toBe("original snapshot");
    fs.rmSync(input, { recursive: true, force: true });
    const afterClose = new ArtifactCollector(output, { sources }).collect();
    expect(afterClose.status).toBe("complete");
    expect(afterClose.sources[0].files).toHaveLength(2);
  });

  it.each([false, true])("preserves runtime omissions after cleanup instead of reporting a complete archive (optional: %s)", optional => {
    write("a.log", "first");
    write("b.log", "second");
    const sources = [source({ root: "workspace", optional })];
    const first = new ArtifactCollector(output, { sources, limits: { maxFiles: 1 } }).collect({ workspace: input });
    expect(first.status).toBe("partial");
    expect(first.sources[0].omittedFiles).toBe(1);
    const unavailable = new ArtifactCollector(output, { sources, limits: { maxFiles: 1 } }).collect();
    expect(unavailable.status).toBe("partial");
    expect(unavailable.sources[0]).toEqual(first.sources[0]);
    const retried = new ArtifactCollector(output, { sources, limits: { maxFiles: 2 } }).collect({ workspace: input });
    expect(retried.status).toBe("complete");
    expect(retried.sources[0].files).toHaveLength(2);
    expect(retried.sources[0].omittedFiles).toBe(0);
    expect(retried.sources[0].errors).toEqual([]);
  });

  it("does not hide archive validation failures behind optional runtime absence", () => {
    write("event.log", "original");
    const sources = [source({ root: "workspace", optional: true })];
    const first = new ArtifactCollector(output, { sources }).collect({ workspace: input });
    fs.writeFileSync(path.join(output, first.sources[0].files[0].path), "tampered");
    const afterCleanup = new ArtifactCollector(output, { sources }).collect();
    expect(afterCleanup.status).toBe("failed");
    expect(afterCleanup.sources[0].files).toEqual([]);
    expect(afterCleanup.sources[0].errors.join()).toContain("Invalid archived file");
    expect(afterCleanup.sources[0].errors.join()).toContain("changed after collection");
  });

  it("does not overwrite existing runner or consumer files", () => {
    write("event.log", "new");
    const existing = path.join(output, "attachments", "custom", "event.log");
    fs.mkdirSync(path.dirname(existing), { recursive: true });
    fs.writeFileSync(existing, "owned by someone else");
    const manifest = collector().collect();
    expect(manifest.status).toBe("failed");
    expect(manifest.sources[0].errors.join()).toContain("unowned");
    expect(fs.readFileSync(existing, "utf8")).toBe("owned by someone else");
  });

  it.each(["**/*", "producer/event.log"])("collects output-root producer files without recursively collecting its own archives (%s)", include => {
    const producer = path.join(output, "producer", "event.log");
    fs.mkdirSync(path.dirname(producer), { recursive: true });
    fs.writeFileSync(producer, "producer output");
    const options = { sources: [source({ root: "output", include: [include] })] };
    const first = new ArtifactCollector(output, options).collect();
    const repeated = new ArtifactCollector(output, options).collect();
    expect(first.sources[0].files).toHaveLength(1);
    expect(repeated.sources[0].files).toHaveLength(1);
    expect(repeated.sources[0].files[0].sourcePath).toBe("producer/event.log");
  });

  it("never follows directory links or writes through destination links", () => {
    const outside = path.join(root, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "private.log"), "outside sentinel");
    fs.symlinkSync(outside, path.join(input, "linked"), process.platform === "win32" ? "junction" : "dir");
    const sourceLink = collector().collect();
    expect(sourceLink.sources[0].files).toEqual([]);
    expect(sourceLink.sources[0].errors.join()).toContain("Symbolic link");
    expect(JSON.stringify(sourceLink)).not.toContain("outside sentinel");
    write("real.log", "real");
    const otherOutput = path.join(root, "linked-output");
    fs.mkdirSync(otherOutput);
    fs.symlinkSync(outside, path.join(otherOutput, "attachments"), process.platform === "win32" ? "junction" : "dir");
    const destinationLink = new ArtifactCollector(otherOutput, {
      sources: [source({ include: ["real.log"] })],
    }).collect();
    expect(destinationLink.status).toBe("failed");
    expect(destinationLink.sources[0].errors.join()).toContain("symbolic link");
    expect(fs.readdirSync(outside)).toEqual(["private.log"]);
  });

  it("refuses a corrupt or traversal-bearing previous manifest without touching external paths", () => {
    write("event.log", "event");
    collector().collect();
    const manifest = readManifest();
    manifest.sources[0].files[0].path = "../../outside.log";
    fs.writeFileSync(path.join(output, "artifacts", "manifest.json"), JSON.stringify(manifest));
    expect(() => collector()).toThrow("Invalid artifact manifest");
  });

  it("makes archived-file tampering and source-definition changes visible", () => {
    write("event.log", "original");
    const initial = collector().collect();
    fs.writeFileSync(path.join(output, initial.sources[0].files[0].path), "changed");
    const tampered = collector().collect();
    expect(tampered.status).toBe("failed");
    expect(tampered.sources[0].errors.join()).toContain("unowned");
    expect(tampered.sources[0].errors.join()).toContain("Invalid archived file");
    expect(tampered.sources[0].files).toEqual([]);
    const renamed = collector({ include: ["different.log"] }).collect();
    expect(renamed.sources[0].errors.join()).toContain("configuration changed");
  });

  it("records per-file I/O errors, continues other files, and leaves no temporary files", () => {
    write("a/event.log", "first");
    write("b.log", "second");
    const blockedParent = path.join(output, "attachments", "custom", "a");
    fs.mkdirSync(path.dirname(blockedParent), { recursive: true });
    fs.writeFileSync(blockedParent, "not a directory");
    const manifest = collector().collect();
    expect(manifest.status).toBe("partial");
    expect(manifest.sources[0].files.map(file => file.sourcePath)).toEqual(["b.log"]);
    expect(summarizeArtifacts(manifest).collectionErrors?.join()).toContain("Artifact parent is not a directory");
    expect(fs.readdirSync(path.join(output, "attachments", "custom"))).toEqual(["a", "b.log"]);
  });
});
