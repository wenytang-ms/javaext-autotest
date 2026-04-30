import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import type { A11yNode } from "../../types.js";

const DEFAULT_TIMEOUT = 5000;

interface DriverContext {
  getPage(): Page;
}

export interface SnapshotOperations {
  snapshot(): Promise<A11yNode>;
  domSnapshot(): Promise<string>;
  screenshot(outputPath?: string): Promise<Buffer>;
  clickByRole(role: string, name: string): Promise<void>;
  clickByText(text: string): Promise<void>;
}

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

  async clickByRole(this: DriverContext, role: string, name: string): Promise<void> {
    const page = this.getPage();
    const el = page.getByRole(role as any, { name });
    await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await el.click();
  },

  async clickByText(this: DriverContext, text: string): Promise<void> {
    const page = this.getPage();
    const el = page.getByText(text).first();
    await el.waitFor({ state: "visible", timeout: DEFAULT_TIMEOUT });
    await el.click();
  },
};
