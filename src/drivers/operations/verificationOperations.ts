import type { Page } from "@playwright/test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Diagnostic } from "../../types.js";

interface DriverContext {
  getPage(): Page;
  getWorkspacePath(): string | null;
  openFile(filePath: string): Promise<void>;
  runCommandFromPalette(label: string): Promise<void>;
}

export interface VerificationOperations {
  isElementVisible(role: string, name: string): Promise<boolean>;
  getElementText(role: string, name: string): Promise<string>;
  getWebviewText(): Promise<string>;
  clickInWebview(selector: string): Promise<void>;
  getProblems(): Promise<Diagnostic[]>;
  fileExists(filePath: string): Promise<boolean>;
  fileContains(filePath: string, text: string): Promise<boolean>;
  readFile(filePath: string): Promise<string>;
  insertLineInFile(relativePath: string, lineNumber: number, text: string): Promise<void>;
  revertFile(): Promise<void>;
  deleteFile(relativePath: string): Promise<void>;
}

export const verificationOperations: VerificationOperations = {
  async isElementVisible(this: DriverContext, role: string, name: string): Promise<boolean> {
    const page = this.getPage();
    return page.getByRole(role as any, { name }).isVisible();
  },

  async getElementText(this: DriverContext, role: string, name: string): Promise<string> {
    const page = this.getPage();
    return (await page.getByRole(role as any, { name }).textContent()) ?? "";
  },

  async getWebviewText(this: DriverContext): Promise<string> {
    const page = this.getPage();
    await page.locator("iframe.webview").last().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});

    const texts: string[] = [];
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
      if (text.trim()) {
        texts.push(text.replace(/\u00A0/g, " ").trim());
      }
    }
    return texts.join("\n");
  },

  /**
   * Click an element inside a VS Code webview iframe.
   *
   * Iterates every non-main frame, returns on the first frame whose
   * `selector` resolves to a visible element. Throws if no frame
   * contains the selector — so callers get a hard error instead of
   * a silent no-op (the same class of silent-pass we fixed for the
   * command palette in 0.6.9).
   */
  async clickInWebview(this: DriverContext, selector: string): Promise<void> {
    const page = this.getPage();
    await page.locator("iframe.webview").last().waitFor({ state: "attached", timeout: 10_000 }).catch(() => {});

    let lastErr: unknown = null;
    for (const frame of page.frames()) {
      if (frame === page.mainFrame()) continue;
      try {
        const loc = frame.locator(selector).first();
        if ((await loc.count()) > 0) {
          await loc.click({ timeout: 5_000 });
          console.log(`   🖱️  clicked "${selector}" in webview frame`);
          return;
        }
      } catch (e) {
        lastErr = e;
      }
    }

    throw new Error(
      `clickInWebview: selector "${selector}" not found in any webview iframe` +
        (lastErr ? ` (last error: ${(lastErr as Error).message})` : "")
    );
  },

  async getProblems(this: DriverContext): Promise<Diagnostic[]> {
    const page = this.getPage();
    const problems = await page.evaluate(() => {
      const items = document.querySelectorAll(".markers-panel .monaco-list-row");
      return Array.from(items).map((el) => ({
        severity: "error" as const,
        message: el.textContent ?? "",
      }));
    });
    return problems;
  },

  async fileExists(_filePath: string): Promise<boolean> {
    return fs.existsSync(_filePath);
  },

  async fileContains(_filePath: string, text: string): Promise<boolean> {
    if (!fs.existsSync(_filePath)) return false;
    const content = fs.readFileSync(_filePath, "utf-8");
    return content.includes(text);
  },

  async readFile(_filePath: string): Promise<string> {
    return fs.readFileSync(_filePath, "utf-8");
  },

  async insertLineInFile(this: DriverContext, relativePath: string, lineNumber: number, text: string): Promise<void> {
    const wsPath = this.getWorkspacePath();
    if (!wsPath) throw new Error("No workspace path available");

    const filePath = path.join(wsPath, relativePath);
    const resolvedText = text.includes("\\n") ? text.replace(/\\n/g, "\n") : text;

    if (fs.existsSync(filePath)) {
      const lines = fs.readFileSync(filePath, "utf-8").split("\n");
      lines.splice(lineNumber - 1, 0, resolvedText);
      fs.writeFileSync(filePath, lines.join("\n"));
      console.log(`   📝 Inserted line ${lineNumber} in ${relativePath}`);
      await this.runCommandFromPalette("File: Revert File");
    } else {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, resolvedText);
      console.log(`   📝 Created ${relativePath}`);
      await this.openFile(path.basename(filePath));
    }
  },

  async revertFile(this: DriverContext): Promise<void> {
    await this.runCommandFromPalette("File: Revert File");
  },

  async deleteFile(this: DriverContext, relativePath: string): Promise<void> {
    const wsPath = this.getWorkspacePath();
    if (!wsPath) throw new Error("No workspace path available");
    const filePath = path.join(wsPath, relativePath);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
      console.log(`   🗑️ Deleted ${relativePath}`);
    } else {
      console.log(`   ⚠️ File not found: ${relativePath}`);
    }
  },
};
