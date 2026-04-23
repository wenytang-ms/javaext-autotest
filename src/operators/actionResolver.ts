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
        regex: /(?:selectCommand|选择命令)\s+(.+)/i,
        handler: async (m) => { await d.selectAndRunCommand(m[1]); },
      },
      {
        regex: /(?:执行命令|run command)\s+(.+)/i,
        handler: async (m) => { await d.runCommandFromPalette(m[1]); },
      },
      {
        regex: /(?:pressKey|按键)\s+(.+)/i,
        handler: async (m) => { await d.pressKey(m[1].trim()); },
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
        regex: /(?:doubleClick|双击)\s+(.+?)(?:\s*节点|tree item)?$/i,
        handler: async (m) => { await d.doubleClickTreeItem(m[1]); },
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
        regex: /(?:insertLineInFile|在文件中插入行)\s+(\S+)\s+(\d+)\s+([\s\S]+)/i,
        handler: async (m) => {
          await d.insertLineInFile(m[1], parseInt(m[2], 10), m[3].trim());
        },
      },
      {
        regex: /(?:deleteFile|删除文件)\s+(.+)/i,
        handler: async (m) => { await d.deleteFile(m[1].trim()); },
      },

      // ── Wait ──
      // IMPORTANT: waitForLanguageServer must be before generic "wait" pattern
      {
        regex: /(?:waitForLanguageServer|等待语言服务器)/i,
        handler: async () => {
          const ready = await d.waitForLanguageServer(lsTimeout);
          if (!ready) throw new Error("Language Server did not become ready within timeout");
        },
      },
      {
        regex: /(?:等待|wait)\s*(?:(\d+)\s*(?:秒|seconds?|s))?/i,
        handler: async (m) => { await d.wait(parseInt(m[1] ?? "3", 10)); },
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
        regex: /(?:findText|查找文本)\s+(.+)/i,
        handler: async (m) => { await d.findText(m[1].trim()); },
      },
      {
        regex: /(?:renameSymbol|重命名)\s+(.+)/i,
        handler: async (m) => { await d.renameSymbol(m[1].trim()); },
      },
      {
        regex: /(?:organizeImports|整理导入)/i,
        handler: async () => { await d.organizeImports(); },
      },
      {
        regex: /^(?:triggerCompletion|触发代码补全)$/i,
        handler: async () => { await d.triggerCompletion(); },
      },
      {
        regex: /(?:triggerCompletionAt|在位置触发补全)\s+(.+)/i,
        handler: async () => { await d.triggerCompletion(); },
      },

      // ── Debugging ──
      {
        regex: /(?:startDebugSession|启动调试)/i,
        handler: async () => { await d.startDebugSession(); },
      },
      {
        regex: /(?:stopDebugSession|停止调试)/i,
        handler: async () => { await d.stopDebugSession(); },
      },
      {
        regex: /(?:setBreakpoint|设置断点)\s+(\d+)/i,
        handler: async (m) => { await d.setBreakpoint(parseInt(m[1], 10)); },
      },
      {
        regex: /(?:debugStepOver|单步跳过)/i,
        handler: async () => { await d.debugStepOver(); },
      },
      {
        regex: /(?:debugStepInto|单步进入)/i,
        handler: async () => { await d.debugStepInto(); },
      },
      {
        regex: /(?:debugStepOut|单步跳出)/i,
        handler: async () => { await d.debugStepOut(); },
      },

      // ── Test Runner ──
      {
        regex: /(?:openTestExplorer|打开测试面板)/i,
        handler: async () => { await d.openTestExplorer(); },
      },
      {
        regex: /(?:waitForTestDiscovery|等待测试发现)\s+(.+?)(?:\s+(\d+)s)?$/i,
        handler: async (m) => {
          const timeoutMs = m[2] ? parseInt(m[2], 10) * 1000 : 300_000;
          const found = await d.waitForTestDiscovery(m[1].trim(), timeoutMs);
          if (!found) throw new Error(`Test item "${m[1].trim()}" not found within timeout`);
        },
      },
      {
        regex: /(?:runAllTests|运行全部测试)/i,
        handler: async () => { await d.runAllTests(); },
      },
      {
        regex: /(?:runTestsWithProfile|使用配置运行测试)\s+(.+)/i,
        handler: async (m) => { await d.runTestsWithProfile(m[1].trim()); },
      },
      {
        regex: /(?:clickCodeLens|点击CodeLens)\s+(.+)/i,
        handler: async (m) => { await d.clickCodeLens(m[1].trim()); },
      },

      // ── Hover ──
      {
        regex: /(?:hoverOnText|悬停在)\s+(.+)/i,
        handler: async (m) => { await d.hoverOnText(m[1].trim()); },
      },
      {
        regex: /(?:dismissHover|关闭悬停)/i,
        handler: async () => { await d.dismissHover(); },
      },

      // ── File Explorer ──
      {
        regex: /(?:createNewFile|创建文件)\s+(\S+)\s+(\S+)/i,
        handler: async (m) => { await d.createNewFileViaExplorer(m[1], m[2]); },
      },
      {
        regex: /(?:contextMenu|右键菜单)\s+(\S+)\s+(.+)/i,
        handler: async (m) => { await d.contextMenuOnTreeItem(m[1], m[2].trim()); },
      },

      // ── Dependency tree ──
      {
        regex: /(?:openDependencyExplorer|打开依赖视图)/i,
        handler: async () => { await d.openDependencyExplorer(); },
      },

      // ── Quick Input ──
      {
        regex: /(?:typeInQuickInput|在输入框中输入)\s+([\s\S]+)/i,
        handler: async (m) => { await d.typeInQuickInput(m[1].trim()); },
      },
      {
        regex: /(?:confirmQuickInput|确认输入)/i,
        handler: async () => { await d.confirmQuickInput(); },
      },
      {
        regex: /(?:dismissQuickInput|取消输入)/i,
        handler: async () => { await d.dismissQuickInput(); },
      },

      // ── Dialog ──
      {
        regex: /(?:clickDialogButton|点击对话框按钮)\s+(.+)/i,
        handler: async (m) => { await d.clickDialogButton(m[1].trim()); },
      },
      {
        regex: /(?:waitForDialog|等待对话框)\s*(?:(\d+)\s*(?:秒|seconds?|s))?/i,
        handler: async (m) => {
          const timeoutMs = m[1] ? parseInt(m[1], 10) * 1000 : 10_000;
          await d.waitForDialog(timeoutMs);
        },
      },
    ];
  }
}
