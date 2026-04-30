/**
 * ActionResolver — maps natural language actions to VscodeDriver calls.
 *
 * Uses a dictionary of regex patterns for deterministic matching.
 * Unmatched actions fall back to Command Palette execution.
 */

import type { VscodeDriver } from "../drivers/vscodeDriver.js";

export interface ActionResolverOptions {
  /** Default timeout for waitForLanguageServer (ms) */
  lsTimeout?: number;
}

interface ActionPattern {
  regex: RegExp;
  handler: (match: RegExpMatchArray) => Promise<void>;
}

export class ActionResolver {
  private driver: VscodeDriver;
  private patterns: ActionPattern[];
  private options: ActionResolverOptions;

  constructor(driver: VscodeDriver, options: ActionResolverOptions = {}) {
    this.driver = driver;
    this.options = options;
    this.patterns = this.buildPatterns();
  }

  /**
   * Resolve and execute an action string.
   * Returns true if a pattern matched, false if fallback was used.
   */
  async resolve(action: string): Promise<boolean> {
    const trimmed = action.trim();

    for (const { regex, handler } of this.patterns) {
      const match = trimmed.match(regex);
      if (match) {
        await handler(match);
        return true;
      }
    }

    // Fallback: treat the entire action as a command palette input
    console.log(`   ⚠️  No pattern match for: "${action}" — trying as command palette`);
    await this.driver.runCommandFromPalette(action);
    return false;
  }

  private buildPatterns(): ActionPattern[] {
    const d = this.driver;
    const lsTimeout = this.options.lsTimeout ?? 120_000;

    return [
      // ── Command Palette ──
      {
        regex: /^selectCommand\s+(.+)$/i,
        handler: async (m) => { await d.selectAndRunCommand(m[1]); },
      },
      {
        regex: /^run command\s+(.+)$/i,
        handler: async (m) => { await d.runCommandFromPalette(m[1]); },
      },
      {
        regex: /^pressKey\s+(.+)$/i,
        handler: async (m) => { await d.pressKey(m[1].trim()); },
      },
      {
        regex: /^pressTerminalKey\s+(.+)$/i,
        handler: async (m) => { await d.pressTerminalKey(m[1].trim()); },
      },
      {
        regex: /^executeVSCodeCommand\s+(\S+)(?:\s+([\s\S]+))?$/i,
        handler: async (m) => {
          const args = m[2] ? [JSON.parse(m[2])] : [];
          await d.executeVSCodeCommand(m[1].trim(), ...args);
        },
      },

      // ── UI Navigation ──
      {
        regex: /^click side tab\s+(.+?)\s*(?:tab)?$/i,
        handler: async (m) => { await d.activeSideTab(m[1]); },
      },
      {
        regex: /^collapseSidebarSection\s+(.+)$/i,
        handler: async (m) => { await d.collapseSidebarSection(m[1].trim()); },
      },
      {
        regex: /^collapseWorkspaceRoot$/i,
        handler: async () => { await d.collapseWorkspaceRoot(); },
      },
      {
        regex: /^expandTreeItem\s+(.+)$/i,
        handler: async (m) => { await d.expandTreeItem(m[1].trim()); },
      },
      {
        regex: /^clickTreeItemAction\s+(.+)$/i,
        handler: async (m) => {
          const [itemName, actionLabel] = this.parseActionArgs(m[1], 2, "clickTreeItemAction");
          await d.clickTreeItemAction(itemName, actionLabel);
        },
      },
      {
        regex: /^contextMenu\s+(.+)$/i,
        handler: async (m) => {
          const [itemName, menuLabel] = this.parseActionArgs(m[1], 2, "contextMenu");
          await d.contextMenuOnTreeItem(itemName, menuLabel);
        },
      },
      {
        regex: /^click\s+(.+?)\s*(?:tree item)?$/i,
        handler: async (m) => { await d.clickTreeItem(m[1]); },
      },
      {
        regex: /^doubleClick\s+(.+?)\s*(?:tree item)?$/i,
        handler: async (m) => { await d.doubleClickTreeItem(m[1]); },
      },
      {
        regex: /^select\s+(.+?)\s*(?:option)?$/i,
        handler: async (m) => { await d.selectPaletteOption(m[1]); },
      },
      {
        regex: /^selectOptionByIndex\s+(\d+)$/i,
        handler: async (m) => { await d.selectPaletteOptionByIndex(parseInt(m[1], 10)); },
      },

      // ── File Operations ──
      {
        regex: /^open file\s+(.+)$/i,
        handler: async (m) => { await d.openFile(m[1]); },
      },
      {
        regex: /^saveFile$/i,
        handler: async () => { await d.saveFile(); },
      },
      {
        regex: /^insertLineInFile\s+(\S+)\s+(\d+)\s+([\s\S]+)$/i,
        handler: async (m) => {
          await d.insertLineInFile(m[1], parseInt(m[2], 10), m[3].trim());
        },
      },
      {
        regex: /^deleteFile\s+(.+)$/i,
        handler: async (m) => { await d.deleteFile(m[1].trim()); },
      },

      // ── Wait ──
      // IMPORTANT: waitForLanguageServer must be before generic "wait" pattern
      {
        regex: /^waitForLanguageServer$/i,
        handler: async () => {
          const ready = await d.waitForLanguageServer(lsTimeout);
          if (!ready) throw new Error("Language Server did not become ready within timeout");
        },
      },
      {
        regex: /^wait(?:\s+(\d+)\s*(?:seconds?|s))?$/i,
        handler: async (m) => { await d.wait(parseInt(m[1] ?? "3", 10)); },
      },

      // ── Cursor Navigation ──
      {
        regex: /^goToLine\s+(\d+)$/i,
        handler: async (m) => { await d.goToLine(parseInt(m[1], 10)); },
      },
      {
        regex: /^goToEndOfLine$/i,
        handler: async () => { await d.goToEndOfLine(); },
      },

      // ── Editor Input ──
      {
        regex: /^typeAndTriggerSnippet\s+(.+)$/i,
        handler: async (m) => { await d.typeAndTriggerSnippet(m[1].trim()); },
      },
      {
        regex: /^typeInEditor\s+([\s\S]+)$/i,
        handler: async (m) => { await d.typeInEditor(m[1].trim()); },
      },

      // ── Code Intelligence ──
      {
        regex: /^navigateToError(?:\s+(\d+))?$/i,
        handler: async (m) => {
          await d.navigateToError(parseInt(m[1] ?? "1", 10));
        },
      },
      {
        regex: /^applyCodeAction\s+(.+)$/i,
        handler: async (m) => { await d.applyCodeAction(m[1].trim()); },
      },
      {
        regex: /^findText\s+(.+)$/i,
        handler: async (m) => { await d.findText(m[1].trim()); },
      },
      {
        regex: /^renameSymbol\s+(.+)$/i,
        handler: async (m) => { await d.renameSymbol(m[1].trim()); },
      },
      {
        regex: /^organizeImports$/i,
        handler: async () => { await d.organizeImports(); },
      },
      {
        regex: /^triggerCompletion$/i,
        handler: async () => { await d.triggerCompletion(); },
      },
      {
        regex: /^triggerCompletionAt\s+(.+)$/i,
        handler: async (m) => { await d.triggerCompletionAt(m[1].trim()); },
      },

      // ── Debugging ──
      {
        regex: /^startDebugSession$/i,
        handler: async () => { await d.startDebugSession(); },
      },
      {
        regex: /^stopDebugSession$/i,
        handler: async () => { await d.stopDebugSession(); },
      },
      {
        regex: /^setBreakpoint\s+(\d+)$/i,
        handler: async (m) => { await d.setBreakpoint(parseInt(m[1], 10)); },
      },
      {
        regex: /^debugStepOver$/i,
        handler: async () => { await d.debugStepOver(); },
      },
      {
        regex: /^debugStepInto$/i,
        handler: async () => { await d.debugStepInto(); },
      },
      {
        regex: /^debugStepOut$/i,
        handler: async () => { await d.debugStepOut(); },
      },

      // ── Test Runner ──
      {
        regex: /^openTestExplorer$/i,
        handler: async () => { await d.openTestExplorer(); },
      },
      {
        regex: /^waitForTestDiscovery\s+(.+?)(?:\s+(\d+)s)?$/i,
        handler: async (m) => {
          const timeoutMs = m[2] ? parseInt(m[2], 10) * 1000 : 300_000;
          const found = await d.waitForTestDiscovery(m[1].trim(), timeoutMs);
          if (!found) throw new Error(`Test item "${m[1].trim()}" not found within timeout`);
        },
      },
      {
        regex: /^runAllTests$/i,
        handler: async () => { await d.runAllTests(); },
      },
      {
        regex: /^runTestsWithProfile\s+(.+)$/i,
        handler: async (m) => { await d.runTestsWithProfile(m[1].trim()); },
      },
      {
        regex: /^clickCodeLens\s+(.+)$/i,
        handler: async (m) => { await d.clickCodeLens(m[1].trim()); },
      },

      // ── Hover ──
      {
        regex: /^hoverOnText\s+(.+)$/i,
        handler: async (m) => { await d.hoverOnText(m[1].trim()); },
      },
      {
        regex: /^dismissHover$/i,
        handler: async () => { await d.dismissHover(); },
      },

      // ── File Explorer ──
      {
        regex: /^createNewFile\s+(.+)$/i,
        handler: async (m) => {
          const [parentFolder, fileName] = this.parseActionArgs(m[1], 2, "createNewFile");
          await d.createNewFileViaExplorer(parentFolder, fileName);
        },
      },

      // ── Dependency tree ──
      {
        regex: /^openDependencyExplorer$/i,
        handler: async () => { await d.openDependencyExplorer(); },
      },

      // ── Quick Input ──
      {
        regex: /^fillQuickInput\s+([\s\S]+)$/i,
        handler: async (m) => { await d.fillQuickInput(m[1].trim()); },
      },
      {
        regex: /^fillAnyInput\s+([\s\S]+)$/i,
        handler: async (m) => { await d.fillAnyInput(m[1].trim()); },
      },
      {
        regex: /^typeInQuickInput\s+([\s\S]+)$/i,
        handler: async (m) => { await d.typeInQuickInput(m[1].trim()); },
      },
      {
        regex: /^confirmQuickInput$/i,
        handler: async () => { await d.confirmQuickInput(); },
      },
      {
        regex: /^dismissQuickInput$/i,
        handler: async () => { await d.dismissQuickInput(); },
      },

      // ── Dialog ──
      {
        regex: /^waitForDialog(?:\s+(\d+)\s*(?:seconds?|s)?)?$/i,
        handler: async (m) => {
          const timeout = m[1] ? parseInt(m[1], 10) * 1000 : 10_000;
          await d.waitForDialog(timeout);
        },
      },
      {
        regex: /^clickDialogButton\s+(.+)$/i,
        handler: async (m) => { await d.clickDialogButton(m[1].trim()); },
      },
      {
        regex: /^tryClickDialogButton\s+(.+)$/i,
        handler: async (m) => { await d.tryClickDialogButton(m[1].trim()); },
      },
      {
        regex: /^confirmDialog$/i,
        handler: async () => { await d.confirmDialog(); },
      },
      {
        regex: /^tryClickButton\s+(.+)$/i,
        handler: async (m) => { await d.tryClickButton(m[1].trim()); },
      },
    ];
  }

  private parseActionArgs(input: string, expected: number, actionName: string): string[] {
    const args: string[] = [];
    const pattern = /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|(\S+)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(input)) !== null) {
      const value = match[1] ?? match[2] ?? match[3] ?? "";
      args.push(value.replace(/\\(["'])/g, "$1"));
    }

    if (args.length === expected) {
      return args;
    }
    if (expected === 2 && args.length > 2) {
      return [args[0], args.slice(1).join(" ")];
    }

    throw new Error(
      `Invalid ${actionName} arguments. Expected ${expected} argument(s); use quotes for values that contain spaces.`
    );
  }
}
