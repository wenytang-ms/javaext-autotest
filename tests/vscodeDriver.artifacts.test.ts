import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from "@vscode/test-electron";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";

vi.mock("@vscode/test-electron", () => ({
  downloadAndUnzipVSCode: vi.fn(),
  resolveCliArgsFromVSCodeExecutablePath: vi.fn(),
}));

let root: string;
beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-artifact-lifecycle-")); });
afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("Driver artifact lifecycle boundary", () => {
  it("exposes actual user-data paths even when extension preparation fails before Electron launch", async () => {
    const userData = path.join(root, "actual-user-data");
    const extensions = path.join(root, "actual-extensions");
    vi.mocked(downloadAndUnzipVSCode).mockResolvedValue(path.join(root, "Code.exe"));
    vi.mocked(resolveCliArgsFromVSCodeExecutablePath).mockReturnValue([
      "unused-cli", `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
    ]);
    const driver = new VscodeDriver({
      userDataDir: path.join(root, "unused-user-data"),
      localExtensions: [path.join(root, "missing-extension")],
    });
    await expect(driver.launch()).rejects.toThrow();
    expect(driver.getUserDataDir()).toBe(userData);
    expect(driver.getExtensionsDir()).toBe(extensions);
    await driver.close();
  });

  it("runs collection after shutdown and before actual temporary workspace deletion", async () => {
    const workspace = path.join(root, "owned-workspace");
    fs.mkdirSync(workspace);
    const file = path.join(workspace, "diagnostic.log");
    fs.writeFileSync(file, "started\n");
    const events: string[] = [];
    const driver = new VscodeDriver();
    driver["tempWorkspaceDir"] = workspace;
    driver["closeApplication"] = async () => {
      events.push("shutdown");
      fs.appendFileSync(file, "flushed on shutdown\n");
    };
    await driver.close({ beforeWorkspaceCleanup: () => {
      events.push("collect");
      expect(fs.readFileSync(file, "utf8")).toContain("flushed on shutdown");
    } });
    events.push("closed");
    expect(events).toEqual(["shutdown", "collect", "closed"]);
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("still cleans its workspace when collection throws, without swallowing the error", async () => {
    const workspace = path.join(root, "owned-workspace");
    fs.mkdirSync(workspace);
    const driver = new VscodeDriver();
    driver["tempWorkspaceDir"] = workspace;
    await expect(driver.close({ beforeWorkspaceCleanup: () => { throw new Error("controlled collection failure"); } }))
      .rejects.toThrow("controlled collection failure");
    expect(fs.existsSync(workspace)).toBe(false);
  });

  it("preserves close() without arguments and cleans the same owned workspace", async () => {
    const workspace = path.join(root, "owned-workspace");
    fs.mkdirSync(workspace);
    const driver = new VscodeDriver();
    driver["tempWorkspaceDir"] = workspace;
    await driver.close();
    expect(fs.existsSync(workspace)).toBe(false);
    expect(driver["tempWorkspaceDir"]).toBeNull();
  });
});
