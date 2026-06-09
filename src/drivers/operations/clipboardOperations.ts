/**
 * ClipboardOperations — read/write the OS clipboard via Electron's main-process
 * `clipboard` module.
 *
 * Why not `navigator.clipboard.readText()` from the renderer?
 *   • In Playwright/Electron, browser clipboard APIs require explicit permission
 *     grants AND a user gesture in the active frame. Headless CI runs frequently
 *     fail both conditions.
 *   • The Electron main process `clipboard` module has no such restrictions; it
 *     is a thin wrapper over the native OS clipboard and works headless.
 *
 * We get to the main process via the same `app.evaluate(...)` channel already
 * used by `vscodeDriver.ts` to mock `dialog.showMessageBox`.
 */

import type { ElectronApplication } from "@playwright/test";

interface DriverContext {
  getElectronApp(): ElectronApplication | null;
}

export interface ClipboardOperations {
  /** Read the current OS clipboard text. Empty string when clipboard is empty. */
  readClipboard(): Promise<string>;
  /** Write text to the OS clipboard. Useful for seeding a known baseline. */
  writeClipboard(text: string): Promise<void>;
}

export const clipboardOperations: ClipboardOperations = {
  async readClipboard(this: DriverContext): Promise<string> {
    const app = this.getElectronApp();
    if (!app) {
      throw new Error("VscodeDriver not launched. Call launch() first.");
    }
    return await app.evaluate(({ clipboard }) => clipboard.readText());
  },

  async writeClipboard(this: DriverContext, text: string): Promise<void> {
    const app = this.getElectronApp();
    if (!app) {
      throw new Error("VscodeDriver not launched. Call launch() first.");
    }
    await app.evaluate(({ clipboard }, t: string) => clipboard.writeText(t), text);
  },
};
