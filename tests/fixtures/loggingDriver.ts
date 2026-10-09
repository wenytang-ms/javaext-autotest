import { VscodeDriver } from "../../src/drivers/vscodeDriver.js";

VscodeDriver.prototype.launch = async function () {
  process.stdout.write("fixture stdout api-key=fixture-log-placeholder\n");
  process.stderr.write("fixture stderr\n");
  throw new AggregateError([
    Object.assign(new Error("fixture connection rejected"), { code: "ECONNREFUSED", address: "::1", port: 443 }),
  ], "");
};
VscodeDriver.prototype.close = async function () {};
VscodeDriver.prototype.refreshProbeSnapshot = async function () {};
VscodeDriver.prototype.getLaunchDiagnostics = function () {
  return [{ capturedAt: new Date().toISOString(), stage: "resolve-vscode", details: { requestedVersion: "stable" } }];
};
