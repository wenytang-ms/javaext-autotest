import type { Page } from "@playwright/test";

interface DriverContext {
  getPage(): Page;
  runCommandFromPalette(label: string): Promise<void>;
  clickTreeItem(name: string): Promise<void>;
}

export interface DependencyOperations {
  openDependencyExplorer(): Promise<void>;
  expandTreePath(names: string[]): Promise<void>;
  wait(seconds: number): Promise<void>;
}

export const dependencyOperations: DependencyOperations = {
  async openDependencyExplorer(this: DriverContext): Promise<void> {
    await this.runCommandFromPalette("Java: Focus on Java Dependencies View");
  },

  async expandTreePath(this: DriverContext, names: string[]): Promise<void> {
    for (const name of names) {
      await this.clickTreeItem(name);
    }
  },

  async wait(this: DriverContext, seconds: number): Promise<void> {
    await this.getPage().waitForTimeout(seconds * 1000);
  },
};
