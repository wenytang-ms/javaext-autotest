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

import * as path from "node:path";
import { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { StepResult, TestPlan, TestReport, TestStep } from "../types.js";

export class TestRunner {
  private driver: VscodeDriver;
  private plan: TestPlan;

  constructor(plan: TestPlan) {
    this.plan = plan;
    this.driver = new VscodeDriver({
      vscodeVersion: plan.setup.vscodeVersion,
      extensionPath: plan.setup.extensionPath
        ? path.resolve(plan.setup.extensionPath)
        : undefined,
      workspacePath: plan.setup.workspace
        ? path.resolve(plan.setup.workspace)
        : undefined,
      settings: plan.setup.settings,
    });
  }

  async run(): Promise<TestReport> {
    const startTime = new Date();
    const results: StepResult[] = [];

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

    try {
      // Wait before execution if specified
      if (step.waitBefore) {
        await this.driver.wait(step.waitBefore);
      }

      // Execute the action
      await this.executeAction(step.action);

      // Run verifications
      const verifyResult = await this.verifyStep(step);

      return {
        stepId: step.id,
        action: step.action,
        status: verifyResult.passed ? "pass" : "fail",
        reason: verifyResult.reason,
        duration: Date.now() - start,
      };
    } catch (e) {
      return {
        stepId: step.id,
        action: step.action,
        status: "error",
        reason: (e as Error).message,
        duration: Date.now() - start,
      };
    }
  }

  /**
   * Map natural language action to driver calls.
   *
   * This is the "action dictionary" — common actions mapped to deterministic operations.
   * When AI integration is added (Phase 4), unmatched actions will be sent to AI.
   */
  private async executeAction(action: string): Promise<void> {
    const normalized = action.toLowerCase().trim();

    // Pattern: "执行命令 XXX" or "run command XXX"
    const commandMatch = normalized.match(/(?:执行命令|run command)\s+(.+)/);
    if (commandMatch) {
      await this.driver.runCommandFromPalette(commandMatch[1]);
      return;
    }

    // Pattern: "点击侧边栏 XXX tab" or "click side tab XXX"
    const sideTabMatch = normalized.match(/(?:点击侧边栏|click side tab)\s+(.+?)(?:\s*tab)?$/);
    if (sideTabMatch) {
      await this.driver.activeSideTab(sideTabMatch[1]);
      return;
    }

    // Pattern: "展开/点击 XXX 节点" or "click/expand tree item XXX"
    const treeMatch = normalized.match(/(?:展开|点击|click|expand)\s+(.+?)(?:\s*节点|tree item)?$/);
    if (treeMatch) {
      await this.driver.clickTreeItem(treeMatch[1]);
      return;
    }

    // Pattern: "选择 XXX 选项" or "select option XXX"
    const selectMatch = normalized.match(/(?:选择|select)\s+(.+?)(?:\s*选项|option)?$/);
    if (selectMatch) {
      await this.driver.selectPaletteOption(selectMatch[1]);
      return;
    }

    // Pattern: "打开文件 XXX" or "open file XXX"
    const openMatch = normalized.match(/(?:打开文件|open file)\s+(.+)/);
    if (openMatch) {
      await this.driver.openFile(openMatch[1]);
      return;
    }

    // Pattern: "等待" or "wait"
    const waitMatch = normalized.match(/(?:等待|wait)\s*(?:(\d+)\s*(?:秒|seconds?|s))?/);
    if (waitMatch) {
      await this.driver.wait(parseInt(waitMatch[1] ?? "3", 10));
      return;
    }

    // ── New patterns for Java/LS testing ──────────────────

    // Pattern: "waitForLanguageServer" or "等待语言服务器"
    if (normalized.match(/(?:waitforlanguageserver|等待语言服务器)/)) {
      const ready = await this.driver.waitForLanguageServer(
        (this.plan.setup.timeout ?? 120) * 1000
      );
      if (!ready) {
        throw new Error("Language Server did not become ready within timeout");
      }
      return;
    }

    // Pattern: "typeAndTriggerSnippet XXX" or "输入代码片段 XXX"
    const snippetMatch = normalized.match(/(?:typeandtriggersnippet|输入代码片段)\s+(.+)/);
    if (snippetMatch) {
      await this.driver.typeAndTriggerSnippet(snippetMatch[1].trim());
      return;
    }

    // Pattern: "typeInEditor XXX" or "在编辑器中输入 XXX"
    const typeMatch = normalized.match(/(?:typeineditor|在编辑器中输入)\s+(.+)/);
    if (typeMatch) {
      await this.driver.typeInEditor(typeMatch[1].trim());
      return;
    }

    // Pattern: "navigateToError N" or "跳转到错误 N"
    const errorNavMatch = normalized.match(/(?:navigatetoerror|跳转到错误)\s*(\d+)?/);
    if (errorNavMatch) {
      const index = parseInt(errorNavMatch[1] ?? "1", 10);
      await this.driver.navigateToError(index);
      return;
    }

    // Pattern: "applyCodeAction XXX" or "应用代码操作 XXX"
    const codeActionMatch = normalized.match(/(?:applycodeaction|应用代码操作)\s+(.+)/);
    if (codeActionMatch) {
      await this.driver.applyCodeAction(codeActionMatch[1].trim());
      return;
    }

    // Pattern: "triggerCompletion" or "触发代码补全"
    if (normalized.match(/(?:triggercompletion|触发代码补全)/)) {
      await this.driver.triggerCompletion();
      return;
    }

    // Pattern: "triggerCompletionAt XXX" — trigger completion at a described location
    const completionAtMatch = normalized.match(/(?:triggercompletionat|在位置触发补全)\s+(.+)/);
    if (completionAtMatch) {
      // For now, just trigger completion at current cursor
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
        const content = await this.driver.getEditorContent();
        if (!content.includes(step.verifyEditor.contains)) {
          return {
            passed: false,
            reason: `Editor does not contain: "${step.verifyEditor.contains}"`,
          };
        }
      }
    }

    // Deterministic: problems panel verification
    if (step.verifyProblems) {
      const counts = await this.driver.getProblemsCount();
      if (step.verifyProblems.errors !== undefined) {
        if (step.verifyProblems.atLeast) {
          if (counts.errors < step.verifyProblems.errors) {
            return {
              passed: false,
              reason: `Expected at least ${step.verifyProblems.errors} errors, got ${counts.errors}`,
            };
          }
        } else {
          if (counts.errors !== step.verifyProblems.errors) {
            return {
              passed: false,
              reason: `Expected ${step.verifyProblems.errors} errors, got ${counts.errors}`,
            };
          }
        }
      }
      if (step.verifyProblems.warnings !== undefined) {
        if (step.verifyProblems.atLeast) {
          if (counts.warnings < step.verifyProblems.warnings) {
            return {
              passed: false,
              reason: `Expected at least ${step.verifyProblems.warnings} warnings, got ${counts.warnings}`,
            };
          }
        } else {
          if (counts.warnings !== step.verifyProblems.warnings) {
            return {
              passed: false,
              reason: `Expected ${step.verifyProblems.warnings} warnings, got ${counts.warnings}`,
            };
          }
        }
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
