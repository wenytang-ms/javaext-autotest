/**
 * Test Runner — executes test plans step by step.
 *
 * For each step:
 *   1. Take A11y snapshot (current state)
 *   2. Execute action (mapped from natural language to driver calls)
 *   3. Take snapshot again (new state)
 *   4. Run verifications (deterministic + AI-assisted)
 *   5. Record result
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { StepResult, TestPlan, TestReport, TestStep } from "../types.js";

export interface TestRunnerOptions {
  /** Directory to save screenshots. If set, screenshots are taken before/after each step. */
  screenshotDir?: string;
}

export class TestRunner {
  private driver: VscodeDriver;
  private plan: TestPlan;
  private screenshotDir: string | null;

  constructor(plan: TestPlan, options: TestRunnerOptions = {}) {
    this.plan = plan;
    this.screenshotDir = options.screenshotDir ?? null;
    this.driver = new VscodeDriver({
      vscodeVersion: plan.setup.vscodeVersion,
      extensionPath: plan.setup.extensionPath,
      extensions: plan.setup.extensions,
      workspacePath: plan.setup.workspace,
      settings: plan.setup.settings,
    });
  }

  /** Force-close the VSCode instance (for signal handlers) */
  async cleanup(): Promise<void> {
    await this.driver.close();
  }

  async run(): Promise<TestReport> {
    const startTime = new Date();
    const results: StepResult[] = [];

    // Prepare screenshot directory — clean stale screenshots from previous runs
    if (this.screenshotDir) {
      if (fs.existsSync(this.screenshotDir)) {
        fs.rmSync(this.screenshotDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.screenshotDir, { recursive: true });
      console.log(`📸 Screenshots → ${this.screenshotDir}`);
    }

    try {
      console.log(`\n🚀 Launching VSCode for: ${this.plan.name}`);
      await this.driver.launch();
      console.log(`✅ VSCode ready\n`);

      // Wait for extension to load
      const extTimeout = this.plan.setup.timeout ?? 10;
      await this.driver.wait(extTimeout);

      for (const step of this.plan.steps) {
        const result = await this.executeStep(step);
        results.push(result);

        const icon = result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : "⏭️";
        console.log(`${icon} [${result.stepId}] ${result.action} (${result.duration}ms)`);
        if (result.reason) {
          console.log(`   → ${result.reason}`);
        }
      }
    } catch (e) {
      console.error(`\n💥 Fatal error: ${(e as Error).message}`);
    } finally {
      await this.driver.close();
    }

    const endTime = new Date();
    const summary = {
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
    };

    console.log(`\n📊 Results: ${summary.passed}/${summary.total} passed`);

    return {
      planName: this.plan.name,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: endTime.getTime() - startTime.getTime(),
      results,
      summary,
    };
  }

  private async executeStep(step: TestStep): Promise<StepResult> {
    const start = Date.now();
    // Capture before-screenshot lazily — only saved if step fails/errors
    let beforePath: string | undefined;

    try {
      if (step.waitBefore) {
        await this.driver.wait(step.waitBefore);
      }

      // Capture before state (saved to disk only on failure)
      beforePath = await this.takeScreenshot(step.id, "before");

      // Execute the action
      await this.executeAction(step.action);

      // Screenshot after action
      const afterPath = await this.takeScreenshot(step.id, "after");

      // Run verifications
      const verifyResult = await this.verifyStep(step);

      if (verifyResult.passed) {
        // Remove before screenshot for passed steps — after is sufficient
        this.removeScreenshot(beforePath);
      }

      return {
        stepId: step.id,
        action: step.action,
        status: verifyResult.passed ? "pass" : "fail",
        reason: verifyResult.reason,
        duration: Date.now() - start,
        screenshot: afterPath,
      };
    } catch (e) {
      // Screenshot on error
      const errorPath = await this.takeScreenshot(step.id, "error");

      return {
        stepId: step.id,
        action: step.action,
        status: "error",
        reason: (e as Error).message,
        duration: Date.now() - start,
        screenshot: errorPath,
      };
    }
  }

  private removeScreenshot(filePath: string | undefined): void {
    if (filePath) {
      try { fs.unlinkSync(filePath); } catch { /* ignore */ }
    }
  }

  /** Take a screenshot and return the file path, or undefined if screenshots are disabled. */
  private async takeScreenshot(stepId: string, phase: "before" | "after" | "error"): Promise<string | undefined> {
    if (!this.screenshotDir) return undefined;
    try {
      const fileName = `${stepId}_${phase}.png`;
      const filePath = path.join(this.screenshotDir, fileName);
      await this.driver.screenshot(filePath);
      return filePath;
    } catch {
      return undefined;
    }
  }

  /**
   * Map natural language action to driver calls.
   *
   * This is the "action dictionary" — common actions mapped to deterministic operations.
   * When AI integration is added (Phase 4), unmatched actions will be sent to AI.
   */
  private async executeAction(action: string): Promise<void> {
    const trimmed = action.trim();
    // Use case-insensitive matching on original action to preserve case in captured groups
    const i = "i"; // case-insensitive flag
    const s = "is"; // case-insensitive + dotAll (. matches \n)

    // Pattern: "执行命令 XXX" or "run command XXX"
    const commandMatch = trimmed.match(new RegExp(`(?:执行命令|run command)\\s+(.+)`, i));
    if (commandMatch) {
      await this.driver.runCommandFromPalette(commandMatch[1]);
      return;
    }

    // Pattern: "点击侧边栏 XXX tab" or "click side tab XXX"
    const sideTabMatch = trimmed.match(new RegExp(`(?:点击侧边栏|click side tab)\\s+(.+?)(?:\\s*tab)?$`, i));
    if (sideTabMatch) {
      await this.driver.activeSideTab(sideTabMatch[1]);
      return;
    }

    // Pattern: "展开/点击 XXX 节点" or "click/expand tree item XXX"
    const treeMatch = trimmed.match(new RegExp(`(?:展开|点击|click|expand)\\s+(.+?)(?:\\s*节点|tree item)?$`, i));
    if (treeMatch) {
      await this.driver.clickTreeItem(treeMatch[1]);
      return;
    }

    // Pattern: "选择 XXX 选项" or "select option XXX"
    const selectMatch = trimmed.match(new RegExp(`(?:选择|select)\\s+(.+?)(?:\\s*选项|option)?$`, i));
    if (selectMatch) {
      await this.driver.selectPaletteOption(selectMatch[1]);
      return;
    }

    // Pattern: "打开文件 XXX" or "open file XXX"
    const openMatch = trimmed.match(new RegExp(`(?:打开文件|open file)\\s+(.+)`, i));
    if (openMatch) {
      await this.driver.openFile(openMatch[1]);
      return;
    }

    // Pattern: "等待" or "wait"
    const waitMatch = trimmed.match(new RegExp(`(?:等待|wait)\\s*(?:(\\d+)\\s*(?:秒|seconds?|s))?`, i));
    if (waitMatch) {
      await this.driver.wait(parseInt(waitMatch[1] ?? "3", 10));
      return;
    }

    // ── Keyword-only patterns ──────────────────

    const lower = trimmed.toLowerCase();

    if (lower.match(/(?:waitforlanguageserver|等待语言服务器)/)) {
      const ready = await this.driver.waitForLanguageServer(
        (this.plan.setup.timeout ?? 120) * 1000
      );
      if (!ready) {
        throw new Error("Language Server did not become ready within timeout");
      }
      return;
    }

    if (lower.match(/(?:gotoendofline|跳转到行尾)/)) {
      await this.driver.goToEndOfLine();
      return;
    }

    if (lower.match(/^(?:triggercompletion|触发代码补全)$/)) {
      await this.driver.triggerCompletion();
      return;
    }

    // ── Patterns with text arguments (case-preserved) ──────────────────

    // Pattern: "saveFile" or "保存文件"
    if (lower.match(/(?:savefile|保存文件)/)) {
      await this.driver.saveFile();
      return;
    }

    // Pattern: "typeAndTriggerSnippet XXX"
    const snippetMatch = trimmed.match(new RegExp(`(?:typeAndTriggerSnippet|输入代码片段)\\s+(.+)`, i));
    if (snippetMatch) {
      await this.driver.typeAndTriggerSnippet(snippetMatch[1].trim());
      return;
    }

    // Pattern: "goToLine N"
    const goToLineMatch = trimmed.match(new RegExp(`(?:goToLine|跳转到行)\\s+(\\d+)`, i));
    if (goToLineMatch) {
      await this.driver.goToLine(parseInt(goToLineMatch[1], 10));
      return;
    }

    // Pattern: "typeInEditor XXX" (dotAll: . matches newlines)
    const typeMatch = trimmed.match(new RegExp(`(?:typeInEditor|在编辑器中输入)\\s+([\\s\\S]+)`, i));
    if (typeMatch) {
      await this.driver.typeInEditor(typeMatch[1].trim());
      return;
    }

    // Pattern: "insertLineInFile <path> <line> <text>"
    const insertLineMatch = trimmed.match(new RegExp(`(?:insertLineInFile|在文件中插入行)\\s+(\\S+)\\s+(\\d+)\\s+(.+)`, i));
    if (insertLineMatch) {
      await this.driver.insertLineInFile(insertLineMatch[1], parseInt(insertLineMatch[2], 10), insertLineMatch[3]);
      return;
    }

    // Pattern: "navigateToError N"
    const errorNavMatch = trimmed.match(new RegExp(`(?:navigateToError|跳转到错误)\\s*(\\d+)?`, i));
    if (errorNavMatch) {
      const index = parseInt(errorNavMatch[1] ?? "1", 10);
      await this.driver.navigateToError(index);
      return;
    }

    // Pattern: "applyCodeAction XXX"
    const codeActionMatch = trimmed.match(new RegExp(`(?:applyCodeAction|应用代码操作)\\s+(.+)`, i));
    if (codeActionMatch) {
      await this.driver.applyCodeAction(codeActionMatch[1].trim());
      return;
    }

    // Pattern: "triggerCompletionAt XXX"
    const completionAtMatch = trimmed.match(new RegExp(`(?:triggerCompletionAt|在位置触发补全)\\s+(.+)`, i));
    if (completionAtMatch) {
      await this.driver.triggerCompletion();
      return;
    }

    // Fallback: treat the entire action as a command palette input
    console.log(`   ⚠️  No pattern match for: "${action}" — trying as command palette`);
    await this.driver.runCommandFromPalette(action);
  }

  private async verifyStep(step: TestStep): Promise<{ passed: boolean; reason?: string }> {
    // If no verification defined, auto-pass
    if (!step.verify && !step.verifyFile && !step.verifyNotification
        && !step.verifyEditor && !step.verifyProblems && !step.verifyCompletion) {
      return { passed: true };
    }

    // Deterministic: file verification
    if (step.verifyFile) {
      const filePath = path.resolve(step.verifyFile.path);
      if (step.verifyFile.exists === false) {
        const exists = await this.driver.fileExists(filePath);
        if (exists) return { passed: false, reason: `File should not exist: ${filePath}` };
      } else {
        if (!await this.driver.fileExists(filePath)) {
          return { passed: false, reason: `File not found: ${filePath}` };
        }
        if (step.verifyFile.contains) {
          const contains = await this.driver.fileContains(filePath, step.verifyFile.contains);
          if (!contains) {
            return { passed: false, reason: `File does not contain: "${step.verifyFile.contains}"` };
          }
        }
      }
    }

    // Deterministic: notification verification
    if (step.verifyNotification) {
      const notifications = await this.driver.getNotifications();
      const found = notifications.some((n) => n.includes(step.verifyNotification!));
      if (!found) {
        return {
          passed: false,
          reason: `Notification not found: "${step.verifyNotification}". Got: [${notifications.join(", ")}]`,
        };
      }
    }

    // Deterministic: editor verification
    if (step.verifyEditor) {
      if (step.verifyEditor.contains) {
        const found = await this.driver.editorContains(step.verifyEditor.contains);
        if (!found) {
          return {
            passed: false,
            reason: `Editor does not contain: "${step.verifyEditor.contains}"`,
          };
        }
      }
    }

    // Deterministic: problems panel verification (polls up to step timeout for LS to produce diagnostics)
    if (step.verifyProblems) {
      const maxWait = (step.timeout ?? 30) * 1000;
      const pollInterval = 3000;
      const deadline = Date.now() + maxWait;
      let lastCounts = { errors: 0, warnings: 0 };
      let matched = false;

      while (Date.now() < deadline) {
        lastCounts = await this.driver.getProblemsCount();
        const errorsOk = step.verifyProblems.errors === undefined || (
          step.verifyProblems.atLeast
            ? lastCounts.errors >= step.verifyProblems.errors
            : lastCounts.errors === step.verifyProblems.errors
        );
        const warningsOk = step.verifyProblems.warnings === undefined || (
          step.verifyProblems.atLeast
            ? lastCounts.warnings >= step.verifyProblems.warnings
            : lastCounts.warnings === step.verifyProblems.warnings
        );
        if (errorsOk && warningsOk) {
          matched = true;
          break;
        }
        await this.driver.wait(pollInterval / 1000);
      }

      if (!matched) {
        const parts: string[] = [];
        if (step.verifyProblems.errors !== undefined) {
          const cmp = step.verifyProblems.atLeast ? "at least " : "";
          parts.push(`Expected ${cmp}${step.verifyProblems.errors} errors, got ${lastCounts.errors}`);
        }
        if (step.verifyProblems.warnings !== undefined) {
          const cmp = step.verifyProblems.atLeast ? "at least " : "";
          parts.push(`Expected ${cmp}${step.verifyProblems.warnings} warnings, got ${lastCounts.warnings}`);
        }
        return { passed: false, reason: parts.join("; ") };
      }
    }

    // Deterministic: completion list verification
    if (step.verifyCompletion) {
      const items = await this.driver.triggerCompletion();
      await this.driver.dismissCompletion();

      if (step.verifyCompletion.notEmpty && items.length === 0) {
        return {
          passed: false,
          reason: "Expected non-empty completion list, got empty",
        };
      }
      if (step.verifyCompletion.contains) {
        for (const expected of step.verifyCompletion.contains) {
          const found = items.some((item) =>
            item.toLowerCase().includes(expected.toLowerCase())
          );
          if (!found) {
            return {
              passed: false,
              reason: `Completion list missing "${expected}". Got: [${items.slice(0, 10).join(", ")}${items.length > 10 ? "..." : ""}]`,
            };
          }
        }
      }
    }

    // AI-assisted verification (Phase 4): natural language `verify` field
    if (step.verify) {
      // TODO: Phase 4 — send snapshot + verify description to AI for judgment
      // For now, log and auto-pass with warning
      const snapshot = await this.driver.snapshot();
      console.log(`   🤖 AI verify pending: "${step.verify}" (auto-pass for now)`);
      return { passed: true, reason: `AI verification not yet implemented: ${step.verify}` };
    }

    return { passed: true };
  }
}
