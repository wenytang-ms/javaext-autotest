import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { _electron } from "@playwright/test";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";

vi.mock("@vscode/test-electron", () => ({
  downloadAndUnzipVSCode: vi.fn(),
  resolveCliArgsFromVSCodeExecutablePath: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execFileSync: vi.fn(), execSync: vi.fn() }));
vi.mock("@playwright/test", () => ({ _electron: { launch: vi.fn() } }));

let root: string;
let actualLanguage: string;
const page = {
  locator: vi.fn(() => ({ waitFor: vi.fn(async () => {}) })),
  waitForTimeout: vi.fn(async () => {}),
};

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-driver-config-test-"));
  actualLanguage = "zh-cn";
  page.locator.mockImplementation(() => ({ waitFor: vi.fn(async () => {}) }));
  page.waitForTimeout.mockImplementation(async () => {});
  vi.mocked(downloadAndUnzipVSCode).mockResolvedValue(path.join(root, "Code.exe"));
  vi.mocked(resolveCliArgsFromVSCodeExecutablePath).mockReturnValue([
    "test-cli", `--user-data-dir=${path.join(root, "shared-user-data")}`,
    `--extensions-dir=${path.join(root, "shared-extensions")}`,
  ]);
  vi.mocked(execFileSync).mockImplementation((_cli, args) => {
    const extensionsDir = (args as string[]).find(arg => arg.startsWith("--extensions-dir="))!.slice("--extensions-dir=".length);
    const directory = path.join(extensionsDir, "language.pack-1.0.0");
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, "package.json"), JSON.stringify({
      publisher: "language", name: "pack", version: "1.0.0",
      contributes: { localizations: [{ languageId: "zh-cn", translations: [{ id: "vscode", path: "translation.json" }] }] },
    }));
    fs.writeFileSync(path.join(directory, "translation.json"), "{}");
    return Buffer.from("installed");
  });
  vi.mocked(_electron.launch).mockImplementation(async options => {
    const runtimePath = options!.env!.AUTOTEST_RUNTIME_OUTPUT;
    if (runtimePath) fs.writeFileSync(runtimePath, JSON.stringify({ language: actualLanguage }));
    return {
      process: () => ({ pid: undefined }),
      firstWindow: async () => page,
      evaluate: async () => {},
      close: async () => {},
    } as Awaited<ReturnType<typeof _electron.launch>>;
  });
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("configured Driver startup", () => {
  it("applies settings in isolated directories and validates actual language without evidence or a command slot", async () => {
    const shared = path.join(root, "shared-user-data");
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "sentinel.txt"), "keep");
    const driver = new VscodeDriver({
      locale: "ZH-CN", extensions: ["language.pack"],
      settings: { "editor.fontSize": 17, "telemetry.telemetryLevel": "all" },
    });
    await driver.launch();
    const userData = driver.getUserDataDir()!;
    const extensions = driver.getExtensionsDir()!;
    expect(userData).not.toBe(shared);
    expect(extensions).not.toBe(path.join(root, "shared-extensions"));
    const launch = vi.mocked(_electron.launch).mock.calls[0][0]!;
    expect(launch.args).toContain("--locale=zh-cn");
    expect(launch.env).not.toHaveProperty("AUTOTEST_PROBE_OUTPUT");
    expect(driver.getProbeSnapshotPath()).toBeNull();
    expect(driver.getActualLocale()).toBe("zh-cn");
    expect(driver["keybindingsByCommand"]).toEqual([]);
    const registry = JSON.parse(fs.readFileSync(path.join(userData, "languagepacks.json"), "utf8"));
    expect(registry["zh-cn"].translations.vscode).toBe(path.join(extensions, "language.pack-1.0.0", "translation.json"));
    const settings = JSON.parse(fs.readFileSync(path.join(userData, "User", "settings.json"), "utf8"));
    expect(settings["editor.fontSize"]).toBe(17);
    expect(settings["telemetry.telemetryLevel"]).toBe("off");
    expect(fs.readFileSync(path.join(shared, "sentinel.txt"), "utf8")).toBe("keep");
    expect(vi.mocked(execFileSync).mock.calls[0][1]).toContain(`--extensions-dir=${extensions}`);
    await driver.close();
    expect(fs.existsSync(userData)).toBe(false);
    expect(fs.existsSync(shared)).toBe(true);
  });

  it("fails when the requested language falls back to English and cleans the owned environment", async () => {
    actualLanguage = "en";
    const driver = new VscodeDriver({ locale: "zh-cn", extensions: ["language.pack"] });
    await expect(driver.launch()).rejects.toThrow("Requested locale zh-cn, but VS Code reports en");
    expect(driver.getActualLocale()).toBe("en");
    const userData = driver.getUserDataDir()!;
    await driver.close();
    expect(fs.existsSync(userData)).toBe(false);
  });

  it("stops on required extension installation failure before Electron starts", async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("installation rejected"); });
    const driver = new VscodeDriver({ configuredEnvironment: true, extensions: ["required.extension"] });
    await expect(driver.launch()).rejects.toThrow("Failed to install required extension required.extension");
    expect(_electron.launch).not.toHaveBeenCalled();
    const userData = driver.getUserDataDir()!;
    await driver.close();
    expect(fs.existsSync(userData)).toBe(false);
  });

  it("preserves legacy installation warnings and does not add locale or runtime validation", async () => {
    vi.mocked(execFileSync).mockImplementation(() => { throw new Error("legacy install failure"); });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const driver = new VscodeDriver({ extensions: ["legacy.extension"] });
    await driver.launch();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("legacy install failure"));
    const launch = vi.mocked(_electron.launch).mock.calls[0][0]!;
    expect(launch.args!.some(arg => arg.startsWith("--locale="))).toBe(false);
    expect(launch.env).not.toHaveProperty("AUTOTEST_RUNTIME_OUTPUT");
    expect(driver.getActualLocale()).toBeNull();
    await driver.close();
  });
});
