import * as fs from "node:fs";
import * as path from "node:path";
import type { VscodeEnvironmentConfig } from "../types.js";

const CONFIG_KEYS = [
  "vscodeVersion", "locale", "extensions", "vsix", "preRelease", "settings", "workspaceSettings",
];

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function normalizeVscodeLocale(value: unknown): string {
  if (typeof value !== "string" || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value)) {
    throw new Error("VS Code locale must be a language tag such as en or zh-cn");
  }
  const normalized = value.toLowerCase();
  return normalized.startsWith("en-") ? "en" : normalized;
}

export function parseVscodeEnvironment(value: unknown): VscodeEnvironmentConfig {
  const raw = object(value, "VS Code configuration");
  if (raw.vscodeVersion !== undefined && raw.vscodeVersion !== "stable" && raw.vscodeVersion !== "insiders") {
    throw new Error("VS Code vscodeVersion must be stable or insiders");
  }
  if (raw.preRelease !== undefined && typeof raw.preRelease !== "boolean") {
    throw new Error("VS Code preRelease must be a boolean");
  }
  const lists: Pick<VscodeEnvironmentConfig, "extensions" | "vsix"> = {};
  for (const key of ["extensions", "vsix"] as const) {
    const entries = raw[key];
    if (entries !== undefined) {
      if (!Array.isArray(entries) || entries.some(entry => typeof entry !== "string" || !entry.trim() || entry.includes("\0"))) {
        throw new Error(`VS Code ${key} must be an array of non-empty strings`);
      }
      lists[key] = entries;
    }
  }
  return {
    ...(raw.vscodeVersion === undefined ? {} : { vscodeVersion: raw.vscodeVersion as VscodeEnvironmentConfig["vscodeVersion"] }),
    ...(raw.locale === undefined ? {} : { locale: normalizeVscodeLocale(raw.locale) }),
    ...(raw.preRelease === undefined ? {} : { preRelease: raw.preRelease as boolean }),
    ...lists,
    ...(raw.settings === undefined ? {} : { settings: object(raw.settings, "VS Code settings") }),
    ...(raw.workspaceSettings === undefined ? {} : { workspaceSettings: object(raw.workspaceSettings, "VS Code workspaceSettings") }),
  };
}

export function loadVscodeConfig(filePath: string): VscodeEnvironmentConfig {
  const absolutePath = path.resolve(filePath);
  const raw = object(JSON.parse(fs.readFileSync(absolutePath, "utf8")), "VS Code configuration");
  const unknown = Object.keys(raw).find(key => key !== "schemaVersion" && !CONFIG_KEYS.includes(key));
  if (unknown) throw new Error(`Unknown VS Code configuration option: ${unknown}`);
  if (raw.schemaVersion !== 1) throw new Error("VS Code configuration schemaVersion must be 1");
  const config = parseVscodeEnvironment(raw);
  return {
    ...config,
    ...(config.vsix ? { vsix: config.vsix.map(file => path.resolve(path.dirname(absolutePath), file)) } : {}),
  };
}

export function mergeVscodeEnvironment(
  defaults: VscodeEnvironmentConfig,
  overrides: VscodeEnvironmentConfig,
): VscodeEnvironmentConfig {
  const merged = { ...defaults, ...overrides };
  for (const key of ["extensions", "vsix"] as const) {
    if (defaults[key] !== undefined || overrides[key] !== undefined) {
      const entries = [...(defaults[key] ?? []), ...(overrides[key] ?? [])];
      merged[key] = [...new Map(entries.map(entry => [
        key === "extensions" ? entry.toLowerCase() : entry, entry,
      ])).values()];
    }
  }
  for (const key of ["settings", "workspaceSettings"] as const) {
    if (defaults[key] !== undefined || overrides[key] !== undefined) {
      merged[key] = { ...defaults[key], ...overrides[key] };
    }
  }
  return merged;
}
