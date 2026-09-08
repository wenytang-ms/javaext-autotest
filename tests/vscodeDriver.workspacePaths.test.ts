import { beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { execSync } from "node:child_process";
import { VscodeDriver } from "../src/drivers/vscodeDriver.js";

vi.mock("@playwright/test", () => ({ _electron: {} }));
vi.mock("@vscode/test-electron", () => ({
  downloadAndUnzipVSCode: vi.fn(),
  resolveCliArgsFromVSCodeExecutablePath: vi.fn(),
}));
vi.mock("node:child_process", () => ({ execSync: vi.fn(), execFileSync: vi.fn() }));
vi.mock("node:os", () => ({ tmpdir: vi.fn() }));
vi.mock("node:fs", () => ({
  realpathSync: Object.assign(vi.fn(), { native: vi.fn() }),
  readdirSync: vi.fn(),
}));

describe("VscodeDriver canonical temporary paths", () => {
  const root = path.parse(process.cwd()).root;
  const alias = path.join(root, "Users", "TESTUS~1", "Temp");
  const canonical = path.join(root, "Users", "Test User", "Temp");
  const gitRoot = path.join(root, "projects", "example");
  const workspace = path.join(gitRoot, "fixtures", "java");

  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(os.tmpdir).mockReturnValue(alias);
    vi.mocked(fs.realpathSync.native).mockReturnValue(canonical);
    vi.mocked(fs.readdirSync).mockReturnValue([]);
    vi.mocked(execSync).mockReturnValue(gitRoot);
  });

  it("uses the canonical path for worktree creation, lookup, and placeholders", async () => {
    const driver = new VscodeDriver({ workspacePath: workspace });
    const openedWorkspace = await driver["createWorktree"](workspace);
    const worktree = driver["worktreeRoot"];

    expect(fs.realpathSync.native).toHaveBeenCalledWith(alias);
    expect(path.dirname(worktree!)).toBe(canonical);
    expect(execSync).toHaveBeenCalledWith(
      `git worktree add "${worktree}" HEAD --detach`,
      { cwd: gitRoot, stdio: "pipe" },
    );
    expect(openedWorkspace).toBe(path.join(worktree!, "fixtures", "java"));
    expect(driver.getWorkspacePath()).toBe(openedWorkspace);
    expect(driver.resolveWorkspacePlaceholders("${workspaceFolder}")).toBe(openedWorkspace);
    expect(driver.resolveWorkspacePlaceholders("${workspaceFolderUri}")).toBe(
      pathToFileURL(openedWorkspace!).toString(),
    );
  });

  it("preserves a temporary directory that is already canonical", () => {
    vi.mocked(os.tmpdir).mockReturnValue(canonical);
    const driver = new VscodeDriver();

    expect(driver["getTemporaryDirectory"]()).toBe(canonical);
    expect(fs.realpathSync.native).toHaveBeenCalledWith(canonical);
  });

  it("surfaces path resolution failures instead of using an inconsistent alias", async () => {
    const error = new Error("Temporary directory cannot be resolved");
    vi.mocked(fs.realpathSync.native).mockImplementation(() => { throw error; });
    const driver = new VscodeDriver({ workspacePath: workspace });

    await expect(driver["createWorktree"](workspace)).rejects.toThrow(error);
    expect(driver.getWorkspacePath()).toBeNull();
    expect(execSync).toHaveBeenCalledTimes(1);
  });
});
