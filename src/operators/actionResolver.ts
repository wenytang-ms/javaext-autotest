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
        regex: /(?:执行命令|run command)\s+(.+)/i,
        handler: async (m) => { await d.runCommandFromPalette(m[1]); },
      },

      // ── UI Navigation ──
      {
        regex: /(?:点击侧边栏|click side tab)\s+(.+?)(?:\s*tab)?$/i,
        handler: async (m) => { await d.activeSideTab(m[1]); },
      },
      {
        regex: /(?:展开|点击|click|expand)\s+(.+?)(?:\s*节点|tree item)?$/i,
        handler: async (m) => { await d.clickTreeItem(m[1]); },
      },
      {
        regex: /(?:选择|select)\s+(.+?)(?:\s*选项|option)?$/i,
        handler: async (m) => { await d.selectPaletteOption(m[1]); },
      },

      // ── File Operations ──
      {
        regex: /(?:打开文件|open file)\s+(.+)/i,
        handler: async (m) => { await d.openFile(m[1]); },
      },
      {
        regex: /(?:savefile|保存文件)/i,
        handler: async () => { await d.saveFile(); },
      },
      {
        regex: /(?:insertLineInFile|在文件中插入行)\s+(\S+)\s+(\d+)\s+(.+)/i,
        handler: async (m) => {
          await d.insertLineInFile(m[1], parseInt(m[2], 10), m[3]);
        },
      },

      // ── Wait ──
      {
        regex: /(?:等待|wait)\s*(?:(\d+)\s*(?:秒|seconds?|s))?/i,
        handler: async (m) => { await d.wait(parseInt(m[1] ?? "3", 10)); },
      },
      {
        regex: /(?:waitForLanguageServer|等待语言服务器)/i,
        handler: async () => {
          const ready = await d.waitForLanguageServer(lsTimeout);
          if (!ready) throw new Error("Language Server did not become ready within timeout");
        },
      },

      // ── Cursor Navigation ──
      {
        regex: /(?:goToLine|跳转到行)\s+(\d+)/i,
        handler: async (m) => { await d.goToLine(parseInt(m[1], 10)); },
      },
      {
        regex: /(?:goToEndOfLine|跳转到行尾)/i,
        handler: async () => { await d.goToEndOfLine(); },
      },

      // ── Editor Input ──
      {
        regex: /(?:typeAndTriggerSnippet|输入代码片段)\s+(.+)/i,
        handler: async (m) => { await d.typeAndTriggerSnippet(m[1].trim()); },
      },
      {
        regex: /(?:typeInEditor|在编辑器中输入)\s+([\s\S]+)/i,
        handler: async (m) => { await d.typeInEditor(m[1].trim()); },
      },

      // ── Code Intelligence ──
      {
        regex: /(?:navigateToError|跳转到错误)\s*(\d+)?/i,
        handler: async (m) => {
          await d.navigateToError(parseInt(m[1] ?? "1", 10));
        },
      },
      {
        regex: /(?:applyCodeAction|应用代码操作)\s+(.+)/i,
        handler: async (m) => { await d.applyCodeAction(m[1].trim()); },
      },
      {
        regex: /^(?:triggerCompletion|触发代码补全)$/i,
        handler: async () => { await d.triggerCompletion(); },
      },
      {
        regex: /(?:triggerCompletionAt|在位置触发补全)\s+(.+)/i,
        handler: async () => { await d.triggerCompletion(); },
      },
    ];
  }
}
