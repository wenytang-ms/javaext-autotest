import * as fs from "node:fs";
import { VscodeDriver } from "../../src/drivers/vscodeDriver.js";

const capture = process.env.VSCODE_CONFIG_TEST_CAPTURE;
if (!capture) throw new Error("VSCODE_CONFIG_TEST_CAPTURE is required");

VscodeDriver.prototype.launch = async function () {
  fs.appendFileSync(capture, `${JSON.stringify(this["options"])}\n`);
};
VscodeDriver.prototype.close = async function () {};
VscodeDriver.prototype.wait = async function () {};
VscodeDriver.prototype.getActualLocale = function () { return this["options"].locale ?? null; };
VscodeDriver.prototype.screenshot = async function (file) {
  const buffer = Buffer.from("fixture screenshot");
  if (file) fs.writeFileSync(file, buffer);
  return buffer;
};
