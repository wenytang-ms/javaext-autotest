import * as fs from "node:fs";
import * as path from "node:path";
import { VscodeDriver } from "../../src/drivers/vscodeDriver.js";
import type { ProbeSnapshot } from "../../src/types.js";

const root = process.env.ARTIFACT_TEST_RUNTIME_ROOT;
if (!root) throw new Error("ARTIFACT_TEST_RUNTIME_ROOT is required by this CLI test fixture");
const workspace = path.join(root, "workspace");
const userData = path.join(root, "user-data");
const diagnostic = path.join(workspace, ".autotest", "diagnostic.log");
const ideLog = path.join(userData, "logs", "session", "extension.log");
const probePath = path.join(userData, "probe.json");

VscodeDriver.prototype.launch = async function () {
  fs.mkdirSync(path.dirname(diagnostic), { recursive: true });
  fs.mkdirSync(path.dirname(ideLog), { recursive: true });
  fs.writeFileSync(diagnostic, "runtime diagnostic\napi-key=fake-cli-artifact-key\n");
  fs.writeFileSync(ideLog, "extension log\n");
  const probe: ProbeSnapshot = {
    schemaVersion: 1, capturedAt: new Date().toISOString(),
    vscode: { version: "fixture", appName: "Fixture", appHost: "desktop", uiKind: 1 },
    process: { platform: process.platform, arch: process.arch, nodeVersion: process.version, execPath: process.execPath },
    workspaceFolders: [workspace], diagnostics: [], extensions: [],
  };
  fs.writeFileSync(probePath, JSON.stringify(probe));
  if (process.env.ARTIFACT_TEST_MODE === "launch-failure") throw new Error("controlled CLI launch failure");
  if (process.env.ARTIFACT_TEST_MODE === "cancel") {
    queueMicrotask(() => { process.emit("SIGTERM"); });
    await new Promise(() => {});
  }
};
VscodeDriver.prototype.close = async function (options = {}) {
  fs.appendFileSync(diagnostic, "flushed before workspace cleanup\n");
  fs.appendFileSync(ideLog, "flushed before workspace cleanup\n");
  await options.beforeWorkspaceCleanup?.();
  fs.rmSync(workspace, { recursive: true, force: true });
};
VscodeDriver.prototype.getWorkspacePath = function () { return workspace; };
VscodeDriver.prototype.getUserDataDir = function () { return userData; };
VscodeDriver.prototype.getProbeSnapshotPath = function () { return probePath; };
VscodeDriver.prototype.refreshProbeSnapshot = async function () {};
VscodeDriver.prototype.wait = async function () {};
VscodeDriver.prototype.screenshot = async function (file) {
  const buffer = Buffer.from("fixture screenshot");
  if (file) fs.writeFileSync(file, buffer);
  return buffer;
};
