import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import type { A11yNode } from "../../types.js";

/**
 * Sink installed by the test runner around each step. When set, driver
 * operations can call `subScreenshot(label)` mid-action to capture an
 * intermediate UI state (e.g. context menu open, overflow menu open,
 * menu item focused). When unset (`null`), `subScreenshot` is a no-op.
 *
 * The runner owns the file-naming convention; the driver only forwards
 * a human-readable label so operations don't need to know about counters
 * or output paths.
 */
export type SubScreenshotSink = (label: string) => Promise<void>;

interface DriverContext {
  getPage(): Page;
  subScreenshot?(label: string): Promise<void>;
}

export interface SnapshotOperations {
  snapshot(): Promise<A11yNode>;
  domSnapshot(): Promise<string>;
  screenshot(outputPath?: string): Promise<Buffer>;
  /**
   * Install a sub-screenshot sink, or pass `null` to clear it.
   * Returns the previous sink so callers can save/restore if needed.
   */
  setSubScreenshotSink(sink: SubScreenshotSink | null): SubScreenshotSink | null;
  /**
   * Capture an intermediate UI state from inside a compound driver
   * operation. No-op when no sink is installed, so individual operations
   * can sprinkle calls freely without worrying about whether they're
   * being driven from a test runner or an ad-hoc script.
   */
  subScreenshot(label: string): Promise<void>;
}

// Module-level sink keeps the API surface on `VscodeDriver` clean — operations
// are mixed into the prototype via `Object.assign`, so per-instance state
// would need extra plumbing. Tests run a single driver instance at a time
// so a module-scoped sink is safe.
let currentSubSink: SubScreenshotSink | null = null;

export const snapshotOperations: SnapshotOperations = {
  async snapshot(this: DriverContext): Promise<A11yNode> {
    const page = this.getPage();
    const tree = await (page as any).accessibility?.snapshot?.();
    return (tree as A11yNode) ?? { role: "window", name: "empty" };
  },

  async domSnapshot(this: DriverContext): Promise<string> {
    const page = this.getPage();
    return await page.evaluate(() => document.documentElement.outerHTML);
  },

  async screenshot(this: DriverContext, outputPath?: string): Promise<Buffer> {
    const page = this.getPage();
    const buffer = await page.screenshot({ fullPage: false });
    if (outputPath) {
      fs.writeFileSync(outputPath, buffer);
    }
    return buffer;
  },

  setSubScreenshotSink(this: DriverContext, sink: SubScreenshotSink | null): SubScreenshotSink | null {
    const previous = currentSubSink;
    currentSubSink = sink;
    return previous;
  },

  async subScreenshot(this: DriverContext, label: string): Promise<void> {
    if (!currentSubSink) return;
    try {
      await currentSubSink(label);
    } catch {
      // Sub-screenshots are diagnostic only — never let a capture failure
      // mask the real action error. Swallow silently.
    }
  },
};
