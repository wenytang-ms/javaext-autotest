import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { Minimatch } from "minimatch";
import type {
  ArtifactCollectionManifest, ArtifactCollectionSummary, ArtifactOptions,
  ArtifactRuntimeRoot, ArtifactSource, ArtifactSourceResult, CollectedArtifactFile,
} from "../types.js";
import { parseArtifactOptions } from "./artifactConfig.js";
import { sanitizeEvidence } from "./evidenceCollector.js";

export const ARTIFACT_MANIFEST_PATH = "artifacts/manifest.json";
export const DEFAULT_ARTIFACT_LIMITS = {
  maxFiles: 1000,
  maxFileBytes: 50 * 1024 * 1024,
  maxTotalBytes: 200 * 1024 * 1024,
};
const MAX_SOURCE_ERRORS = 20;

export type ArtifactRuntimePaths = Partial<Record<ArtifactRuntimeRoot, string | null>>;

function portable(value: string): string {
  return value.replaceAll("\\", "/");
}

function pathKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function safeFilePath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0")
    && !path.posix.isAbsolute(value) && !path.win32.isAbsolute(value)
    && !value.includes("\\") && !value.includes(":")
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
}

function number(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isManifest(value: unknown): value is ArtifactCollectionManifest {
  if (!record(value) || value.schemaVersion !== 1 || !Array.isArray(value.sources)
    || typeof value.generatedAt !== "string"
    || !["complete", "partial", "failed"].includes(String(value.status))
    || (value.runStartedAt !== undefined && (typeof value.runStartedAt !== "string" || !Number.isFinite(Date.parse(value.runStartedAt))))
    || (value.planName !== undefined && typeof value.planName !== "string")) return false;
  const ids = new Set<string>();
  const destinations = new Set<string>();
  for (const source of value.sources) {
    if (!record(source) || typeof source.id !== "string" || ids.has(source.id)
      || typeof source.configHash !== "string" || !/^[a-f0-9]{64}$/.test(source.configHash)
      || !["collected", "missing", "deferred", "skipped", "partial", "error"].includes(String(source.status))
      || !number(source.matchedFiles) || !number(source.omittedFiles) || !Array.isArray(source.files)
      || !Array.isArray(source.errors) || source.errors.some(error => typeof error !== "string")
      || (source.reason !== undefined && typeof source.reason !== "string")
      || (source.optional !== undefined && typeof source.optional !== "boolean")
      || (source.errorsTruncated !== undefined && !number(source.errorsTruncated))) return false;
    ids.add(source.id);
    for (const file of source.files) {
      if (!record(file) || !safeFilePath(file.path) || !safeFilePath(file.sourcePath)
        || /^(?:artifacts|evidence|analysis|screenshots|results\.json)(?:\/|$)/i.test(file.path)
        || destinations.has(pathKey(file.path)) || !number(file.sizeBytes) || !number(file.storedBytes)
        || typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)
        || (file.format !== "text" && file.format !== "binary") || typeof file.redacted !== "boolean"
        || (file.evidence !== undefined && file.evidence !== "tail")
        || (file.format === "binary" && file.evidence !== undefined)) return false;
      destinations.add(pathKey(file.path));
    }
  }
  return true;
}

function hash(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

function hashFile(file: string): string {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const digest = createHash("sha256");
  const chunk = Buffer.alloc(64 * 1024);
  try {
    let length: number;
    while ((length = fs.readSync(descriptor, chunk)) > 0) digest.update(chunk.subarray(0, length));
    return digest.digest("hex");
  } finally {
    fs.closeSync(descriptor);
  }
}

class FileLimitError extends Error {}

function readBoundedFile(file: string, limit: number): Buffer {
  const descriptor = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    if (!fs.fstatSync(descriptor).isFile()) throw new Error("Not a regular file");
    while (true) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, limit - size + 1));
      const length = fs.readSync(descriptor, chunk);
      if (length === 0) return Buffer.concat(chunks, size);
      size += length;
      if (size > limit) throw new FileLimitError(`File exceeds maxFileBytes (${limit})`);
      chunks.push(chunk.subarray(0, length));
    }
  } finally {
    fs.closeSync(descriptor);
  }
}

export function summarizeArtifacts(manifest: ArtifactCollectionManifest): ArtifactCollectionSummary {
  const files = manifest.sources.flatMap(source => source.files);
  const errors = manifest.sources.flatMap(source => [
    ...source.errors.map(error => `${source.id}: ${error}`),
    ...(source.errorsTruncated ? [`${source.id}: ${source.errorsTruncated} additional collection errors`] : []),
  ]);
  return {
    manifest: ARTIFACT_MANIFEST_PATH,
    status: manifest.status,
    files: files.length,
    storedBytes: files.reduce((sum, file) => sum + file.storedBytes, 0),
    sources: manifest.sources.map(source => ({
      id: source.id, status: source.status, files: source.files.length, omittedFiles: source.omittedFiles,
    })),
    ...(errors.length ? { collectionErrors: errors } : {}),
  };
}

export class ArtifactCollector {
  private readonly outputDir: string;
  private readonly sources: ArtifactSource[];
  private readonly limits: typeof DEFAULT_ARTIFACT_LIMITS;
  private manifest: ArtifactCollectionManifest;

  constructor(outputDir: string, options: ArtifactOptions) {
    const parsed = parseArtifactOptions(options);
    if (!parsed || parsed.enabled === false) throw new Error("Artifact collection is not enabled");
    fs.mkdirSync(outputDir, { recursive: true });
    this.outputDir = fs.realpathSync.native(outputDir);
    this.sources = parsed.sources ?? [];
    this.limits = { ...DEFAULT_ARTIFACT_LIMITS, ...parsed.limits };
    const manifestPath = this.securePath(ARTIFACT_MANIFEST_PATH);
    if (fs.existsSync(manifestPath)) {
      const existing: unknown = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (!isManifest(existing)) throw new Error(`Invalid artifact manifest: ${manifestPath}`);
      this.manifest = existing;
    } else {
      this.manifest = { schemaVersion: 1, generatedAt: new Date().toISOString(), status: "complete", sources: [] };
    }
  }

  beginRun(startedAt: Date, planName: string): void {
    if (this.manifest.sources.length) throw new Error("A new run must initialize its output directory before artifact collection");
    this.manifest.runStartedAt = startedAt.toISOString();
    this.manifest.planName = sanitizeEvidence(planName);
    this.save();
  }

  getSummary(): ArtifactCollectionSummary {
    return summarizeArtifacts(this.manifest);
  }

  collect(runtimePaths: ArtifactRuntimePaths = {}, phase: "run" | "collect" = "collect"): ArtifactCollectionManifest {
    const archiveErrors = new Map<string, Pick<ArtifactSourceResult, "errors" | "errorsTruncated">>();
    for (const previous of this.manifest.sources) {
      const valid: CollectedArtifactFile[] = [];
      const validationErrors: Pick<ArtifactSourceResult, "errors" | "errorsTruncated"> = { errors: [] };
      for (const file of previous.files) {
        try {
          const stored = this.securePath(file.path);
          if (fs.statSync(stored).size !== file.storedBytes || hashFile(stored) !== file.sha256) {
            throw new Error("Archived file changed after collection");
          }
          valid.push(file);
        } catch (error) {
          const message = `Invalid archived file ${file.path}: ${(error as Error).message}`;
          this.addError(previous, message);
          this.addError(validationErrors, message);
          previous.status = "partial";
        }
      }
      previous.files = valid;
      archiveErrors.set(previous.id, validationErrors);
    }
    for (const source of this.sources) {
      const previous = this.manifest.sources.find(result => result.id === source.id);
      const configHash = createHash("sha256").update(JSON.stringify(source)).digest("hex");
      if (previous && previous.configHash !== configHash) {
        this.addError(previous, "Source configuration changed; use a new source id to preserve archived evidence");
        previous.status = "partial";
        continue;
      }
      const result: ArtifactSourceResult = {
        id: source.id, configHash, status: previous?.status ?? "collected", files: previous?.files ?? [],
        matchedFiles: previous?.matchedFiles ?? 0, omittedFiles: previous?.omittedFiles ?? 0,
        errors: [...(previous?.errors ?? [])],
        ...(previous?.errorsTruncated ? { errorsTruncated: previous.errorsTruncated } : {}),
        ...(previous?.reason ? { reason: previous.reason } : {}),
        ...(source.optional ? { optional: true } : {}),
      };
      if (previous) this.manifest.sources.splice(this.manifest.sources.indexOf(previous), 1, result);
      else this.manifest.sources.push(result);

      if (source.platforms && !source.platforms.includes(process.platform as "win32" | "linux" | "darwin")) {
        result.status = "skipped";
        result.reason = `Not selected on ${process.platform}`;
        continue;
      }
      if (phase === "run" && source.phase === "collect") {
        result.status = "deferred";
        result.reason = "Collected by the post-run collect command";
        continue;
      }
      const root = this.resolveRoot(source, runtimePaths);
      if (!root || !fs.existsSync(root)) {
        if (result.files.length || result.errors.length || result.omittedFiles) continue;
        this.missing(result, source, "Source directory is unavailable");
        continue;
      }
      if (source.modifiedSince && !this.manifest.runStartedAt) {
        this.missing(result, source, "Run start is unavailable; refusing to select unrelated historical files");
        continue;
      }
      try {
        const canonicalRoot = fs.realpathSync.native(root);
        if (!fs.statSync(canonicalRoot).isDirectory()) throw new Error("Source root must be a directory");
        result.status = "collected";
        result.matchedFiles = 0;
        result.omittedFiles = 0;
        result.errors = [...(archiveErrors.get(source.id)?.errors ?? [])];
        delete result.reason;
        delete result.errorsTruncated;
        const errorsTruncated = archiveErrors.get(source.id)?.errorsTruncated;
        if (errorsTruncated) result.errorsTruncated = errorsTruncated;
        this.collectSource(source, canonicalRoot, result);
      } catch (error) {
        this.addError(result, (error as Error).message);
      }
      if (result.errors.length || result.omittedFiles) result.status = result.files.length ? "partial" : "error";
      else if (result.files.length === 0) this.missing(result, source, "No files matched the configured filters");
    }
    const incomplete = this.manifest.sources.some(source =>
      source.errors.length > 0 || source.omittedFiles > 0 || source.status === "deferred");
    const fileCount = this.manifest.sources.reduce((sum, source) => sum + source.files.length, 0);
    const hasErrors = this.manifest.sources.some(source => source.errors.length || source.omittedFiles);
    this.manifest.status = incomplete ? (fileCount || !hasErrors ? "partial" : "failed") : "complete";
    this.manifest.generatedAt = new Date().toISOString();
    this.save();
    return this.manifest;
  }

  private resolveRoot(source: ArtifactSource, paths: ArtifactRuntimePaths): string | null {
    if (typeof source.root === "string") {
      return source.root === "output" ? this.outputDir : paths[source.root] ?? null;
    }
    if ("env" in source.root) {
      const value = process.env[source.root.env];
      return value?.trim() ? path.resolve(value, source.root.path ?? "") : null;
    }
    return source.root.path;
  }

  private missing(result: ArtifactSourceResult, source: ArtifactSource, reason: string): void {
    result.status = "missing";
    result.reason = reason;
    if (!source.optional) this.addError(result, reason);
  }

  private addError(result: Pick<ArtifactSourceResult, "errors" | "errorsTruncated">, message: string): void {
    if (result.errors.length < MAX_SOURCE_ERRORS) result.errors.push(sanitizeEvidence(message).slice(0, 4096));
    else result.errorsTruncated = (result.errorsTruncated ?? 0) + 1;
  }

  private collectSource(source: ArtifactSource, root: string, result: ArtifactSourceResult): void {
    const matcherOptions = { dot: true, nocase: process.platform === "win32", nonegate: true, nocomment: true };
    const include = source.include.map(pattern => new Minimatch(pattern, matcherOptions));
    const exclude = (source.exclude ?? []).map(pattern => new Minimatch(pattern, matcherOptions));
    const destinations = this.sources.map(entry => path.resolve(this.outputDir, entry.destination));
    const selected = (relative: string) => include.some(pattern => pattern.match(relative))
      && !exclude.some(pattern => pattern.match(relative));
    const visit = (directory: string): void => {
      let entries: fs.Dirent[];
      try {
        if (fs.lstatSync(directory).isSymbolicLink() || !within(root, fs.realpathSync.native(directory))) {
          throw new Error("Directory is a symbolic link or escaped its source root");
        }
        entries = fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      } catch (error) {
        this.addError(result, `Cannot enumerate ${portable(path.relative(root, directory))}: ${(error as Error).message}`);
        return;
      }
      for (const entry of entries) {
        const file = path.join(directory, entry.name);
        const relative = portable(path.relative(root, file));
        if (within(path.join(this.outputDir, "artifacts"), file) || destinations.some(destination => within(destination, file))) continue;
        if (entry.isSymbolicLink()) {
          if (selected(relative) || include.some(pattern => pattern.match(relative, true))) {
            this.addError(result, `Symbolic link not followed: ${relative}`);
          }
          continue;
        }
        if (entry.isDirectory()) {
          if (!exclude.some(pattern => pattern.match(relative) || pattern.match(`${relative}/`))
            && include.some(pattern => pattern.match(relative, true))) visit(file);
        } else if (entry.isFile() && selected(relative)) {
          this.collectFile(source, root, file, relative, result);
        }
      }
    };
    visit(root);
  }

  private collectFile(source: ArtifactSource, root: string, file: string, relative: string, result: ArtifactSourceResult): void {
    try {
      if (!safeFilePath(relative)) throw new Error(`Unsafe source-relative filename: ${relative}`);
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || !within(root, fs.realpathSync.native(file))) throw new Error("Source is not a regular file within its root");
      if (source.modifiedSince && stat.mtimeMs < Date.parse(this.manifest.runStartedAt!)) return;
      result.matchedFiles++;
      const destination = `${source.destination}/${relative}`;
      const existing = result.files.find(entry => pathKey(entry.path) === pathKey(destination));
      if (existing) return; // Archived evidence is immutable, including on post-run collection.
      const allFiles = this.manifest.sources.flatMap(entry => entry.files);
      if (allFiles.length >= this.limits.maxFiles) {
        result.omittedFiles++;
        this.addError(result, `maxFiles (${this.limits.maxFiles}) omitted ${relative}`);
        return;
      }
      if (stat.size > this.limits.maxFileBytes) throw new FileLimitError(`File exceeds maxFileBytes (${this.limits.maxFileBytes})`);
      const input = readBoundedFile(file, this.limits.maxFileBytes);
      const format = source.format ?? "text";
      if (format === "text" && input.includes(0)) throw new Error("Text artifact contains NUL bytes; select format: binary explicitly");
      const stored = format === "binary" ? input
        : Buffer.from(sanitizeEvidence(new TextDecoder("utf-8", { fatal: true }).decode(input)));
      const totalBytes = allFiles.reduce((sum, entry) => sum + entry.storedBytes, 0);
      if (totalBytes + stored.length > this.limits.maxTotalBytes) {
        throw new FileLimitError(`File exceeds remaining maxTotalBytes (${this.limits.maxTotalBytes})`);
      }
      const target = this.securePath(destination, true);
      if (fs.existsSync(target)) throw new Error(`Refusing to overwrite an unowned output file: ${destination}`);
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, stored, { flag: "wx", mode: 0o600 });
        fs.copyFileSync(temporary, target, fs.constants.COPYFILE_EXCL);
      } finally {
        if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      }
      result.files.push({
        sourcePath: relative, path: destination, sizeBytes: input.length, storedBytes: stored.length,
        sha256: hash(stored), format, redacted: !input.equals(stored),
        ...(source.evidence === "tail" ? { evidence: "tail" } : {}),
      });
    } catch (error) {
      if (error instanceof FileLimitError) result.omittedFiles++;
      this.addError(result, `${relative}: ${(error as Error).message}`);
    }
  }

  private securePath(relative: string, createParents = false): string {
    if (!safeFilePath(relative)) throw new Error(`Unsafe artifact path: ${relative}`);
    const parts = relative.split("/");
    let current = this.outputDir;
    for (const [index, part] of parts.entries()) {
      current = path.join(current, part);
      let stat: fs.Stats | undefined;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (stat?.isSymbolicLink()) throw new Error(`Artifact path contains a symbolic link: ${relative}`);
      if (index < parts.length - 1) {
        if (stat && !stat.isDirectory()) throw new Error(`Artifact parent is not a directory: ${relative}`);
        if (!stat && createParents) fs.mkdirSync(current, { mode: 0o700 });
      } else if (stat && !stat.isFile()) {
        throw new Error(`Artifact destination is not a regular file: ${relative}`);
      }
      if (stat && !within(this.outputDir, fs.realpathSync.native(current))) {
        throw new Error(`Artifact path escaped the output directory: ${relative}`);
      }
    }
    return current;
  }

  private save(): void {
    const target = this.securePath(ARTIFACT_MANIFEST_PATH, true);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(this.manifest, null, 2), { flag: "wx", mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
