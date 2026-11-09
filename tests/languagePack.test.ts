import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { prepareLanguagePack } from "../src/drivers/languagePack.js";

let root: string;
let user: string;
let extensions: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-language-pack-test-"));
  user = path.join(root, "user");
  extensions = path.join(root, "extensions");
  fs.mkdirSync(user);
  fs.mkdirSync(extensions);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function install(name: string, translation = "translation.json"): string {
  const directory = path.join(extensions, name);
  fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
    publisher: "publisher", name, version: "1.0.0",
    contributes: { localizations: [{
      languageId: "zh-cn", localizedLanguageName: "Chinese",
      translations: [{ id: "vscode", path: translation }],
    }] },
  }));
  fs.writeFileSync(path.join(directory, "translation.json"), '{"contents":{}}');
  return directory;
}

describe("native language-pack preparation in an owned profile", () => {
  it("registers installed resources without modifying the translation and produces a stable cache key", () => {
    const directory = install("chinese");
    const translation = fs.readFileSync(path.join(directory, "translation.json"));
    prepareLanguagePack(user, extensions, "zh-cn");
    const first = fs.readFileSync(path.join(user, "languagepacks.json"));
    const registry = JSON.parse(first.toString());
    expect(registry["zh-cn"].translations.vscode).toBe(path.join(directory, "translation.json"));
    prepareLanguagePack(user, extensions, "zh-cn");
    expect(fs.readFileSync(path.join(user, "languagepacks.json"))).toEqual(first);
    expect(fs.readFileSync(path.join(directory, "translation.json"))).toEqual(translation);
  });

  it("requires a matching installed pack for non-English locales but none for English", () => {
    install("chinese");
    expect(() => prepareLanguagePack(user, extensions, "fr")).toThrow("No installed language pack provides VS Code locale fr");
    prepareLanguagePack(user, extensions, "en");
    expect(fs.existsSync(path.join(user, "languagepacks.json"))).toBe(false);
  });

  it("rejects missing translation resources and ambiguous language packs before writing the registry", () => {
    const missing = install("missing", "missing.json");
    expect(() => prepareLanguagePack(user, extensions, "zh-cn")).toThrow("missing.json");
    fs.rmSync(missing, { recursive: true, force: true });
    install("first");
    install("second");
    expect(() => prepareLanguagePack(user, extensions, "zh-cn")).toThrow("Multiple installed language packs");
    expect(fs.existsSync(path.join(user, "languagepacks.json"))).toBe(false);
  });
});
