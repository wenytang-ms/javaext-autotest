import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import type { ArtifactOptions, ArtifactRoot, ArtifactSource } from "../types.js";

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function knownKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new Error(`Unknown ${label} option: ${unknown}`);
}

function nonEmptyString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim() || value.includes("\0")) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function relativePath(value: unknown, label: string, pattern = false): string {
  const portable = nonEmptyString(value, label).replaceAll("\\", "/");
  if (path.posix.isAbsolute(portable) || path.win32.isAbsolute(portable)
    || portable.includes(":") || portable.split("/").some(part => part === ".." || part === ".")
    || portable.startsWith("~") || portable.startsWith("!") || portable.length > 4096
    || (!pattern && /[<>"|?*{}[\]]/.test(portable))) {
    throw new Error(`${label} must be a safe relative ${pattern ? "glob" : "path"} without traversal`);
  }
  if (portable.split("/").some(part => !part)) {
    throw new Error(`${label} must not contain empty path segments`);
  }
  return portable;
}

function patterns(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array of globs`);
  }
  return value.map((entry, index) => relativePath(entry, `${label}[${index}]`, true));
}

function root(value: unknown, baseDir: string, label: string): ArtifactRoot {
  if (value === "workspace" || value === "userData" || value === "output") return value;
  const descriptor = object(value, label);
  knownKeys(descriptor, ["path", "env"], label);
  if ("env" in descriptor) {
    const env = nonEmptyString(descriptor.env, `${label}.env`);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(env)) throw new Error(`${label}.env must be an environment variable name`);
    return {
      env,
      ...(descriptor.path === undefined ? {} : { path: relativePath(descriptor.path, `${label}.path`) }),
    };
  }
  return { path: path.resolve(baseDir, nonEmptyString(descriptor.path, `${label}.path`)) };
}

function source(value: unknown, baseDir: string, index: number): ArtifactSource {
  const label = `artifacts.sources[${index}]`;
  const raw = object(value, label);
  knownKeys(raw, [
    "id", "root", "include", "exclude", "destination", "phase", "platforms",
    "optional", "modifiedSince", "format", "evidence",
  ], label);
  const id = nonEmptyString(raw.id, `${label}.id`);
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) {
    throw new Error(`${label}.id must contain 1-64 letters, digits, hyphens or underscores`);
  }
  const destination = relativePath(raw.destination, `${label}.destination`);
  if (/^(?:artifacts|evidence|analysis|screenshots|results\.json)(?:\/|$)/i.test(destination)) {
    throw new Error(`${label}.destination overlaps a framework-owned output path`);
  }
  if (raw.optional !== undefined && typeof raw.optional !== "boolean") {
    throw new Error(`${label}.optional must be a boolean`);
  }
  if (raw.phase !== undefined && raw.phase !== "run" && raw.phase !== "collect") {
    throw new Error(`${label}.phase must be run or collect`);
  }
  if (raw.modifiedSince !== undefined && raw.modifiedSince !== "run-start") {
    throw new Error(`${label}.modifiedSince must be run-start`);
  }
  if (raw.format !== undefined && raw.format !== "text" && raw.format !== "binary") {
    throw new Error(`${label}.format must be text or binary`);
  }
  if (raw.evidence !== undefined && raw.evidence !== "none" && raw.evidence !== "tail") {
    throw new Error(`${label}.evidence must be none or tail`);
  }
  if (raw.format === "binary" && raw.evidence === "tail") {
    throw new Error(`${label}: binary files cannot be LLM evidence`);
  }
  let platforms: ArtifactSource["platforms"];
  if (raw.platforms !== undefined) {
    if (!Array.isArray(raw.platforms) || raw.platforms.length === 0
      || raw.platforms.some(platform => platform !== "win32" && platform !== "linux" && platform !== "darwin")) {
      throw new Error(`${label}.platforms must contain win32, linux and/or darwin`);
    }
    platforms = raw.platforms as ArtifactSource["platforms"];
  }
  return {
    id,
    root: root(raw.root, baseDir, `${label}.root`),
    include: patterns(raw.include, `${label}.include`),
    ...(raw.exclude === undefined ? {} : { exclude: patterns(raw.exclude, `${label}.exclude`, true) }),
    destination,
    ...(raw.phase === undefined ? {} : { phase: raw.phase }),
    ...(platforms ? { platforms } : {}),
    ...(typeof raw.optional === "boolean" ? { optional: raw.optional } : {}),
    ...(raw.modifiedSince === "run-start" ? { modifiedSince: raw.modifiedSince } : {}),
    ...(raw.format === "text" || raw.format === "binary" ? { format: raw.format } : {}),
    ...(raw.evidence === "none" || raw.evidence === "tail" ? { evidence: raw.evidence } : {}),
  };
}

export function parseArtifactOptions(raw: unknown, baseDir = process.cwd()): ArtifactOptions | undefined {
  if (raw === undefined) return undefined;
  const value = object(raw, "artifacts");
  knownKeys(value, ["enabled", "sources", "limits"], "artifacts");
  if (value.enabled !== undefined && typeof value.enabled !== "boolean") {
    throw new Error("artifacts.enabled must be a boolean");
  }
  let sources: ArtifactSource[] | undefined;
  if (value.sources !== undefined) {
    if (!Array.isArray(value.sources)) throw new Error("artifacts.sources must be an array");
    sources = value.sources.map((entry, index) => source(entry, baseDir, index));
    const ids = new Set<string>();
    for (const entry of sources) {
      if (ids.has(entry.id)) throw new Error(`Duplicate artifact source id: ${entry.id}`);
      ids.add(entry.id);
    }
    for (const [index, entry] of sources.entries()) {
      if (sources.slice(0, index).some(previous =>
        entry.destination.toLowerCase() === previous.destination.toLowerCase()
        || entry.destination.toLowerCase().startsWith(`${previous.destination.toLowerCase()}/`)
        || previous.destination.toLowerCase().startsWith(`${entry.destination.toLowerCase()}/`))) {
        throw new Error(`Artifact destination overlaps another source: ${entry.destination}`);
      }
    }
  }
  let limits: ArtifactOptions["limits"];
  if (value.limits !== undefined) {
    const rawLimits = object(value.limits, "artifacts.limits");
    knownKeys(rawLimits, ["maxFiles", "maxFileBytes", "maxTotalBytes"], "artifacts.limits");
    limits = {};
    for (const key of ["maxFiles", "maxFileBytes", "maxTotalBytes"] as const) {
      const limit = rawLimits[key];
      if (limit !== undefined) {
        if (typeof limit !== "number" || !Number.isSafeInteger(limit) || limit < 1) {
          throw new Error(`artifacts.limits.${key} must be a positive safe integer`);
        }
        limits[key] = limit;
      }
    }
  }
  return {
    ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
    ...(sources === undefined ? {} : { sources }),
    ...(limits === undefined ? {} : { limits }),
  };
}

export function loadArtifactConfig(filePath: string): ArtifactOptions {
  const absolutePath = path.resolve(nonEmptyString(filePath, "--artifacts-config"));
  const raw = object(yaml.load(fs.readFileSync(absolutePath, "utf8")), "Artifact configuration");
  knownKeys(raw, ["artifacts"], "artifact configuration");
  const options = parseArtifactOptions(raw.artifacts, path.dirname(absolutePath));
  if (!options) throw new Error("Artifact configuration must contain an artifacts section");
  return options;
}

/** Shared defaults < plan fields < SDK/CLI overrides; source arrays replace, never concatenate. */
export function mergeArtifactOptions(...values: Array<ArtifactOptions | undefined>): ArtifactOptions | undefined {
  let merged: ArtifactOptions | undefined;
  for (const value of values) {
    if (value === undefined) continue;
    merged = { ...merged, ...value, ...(value.limits ? { limits: { ...merged?.limits, ...value.limits } } : {}) };
  }
  return parseArtifactOptions(merged);
}
