/**
 * StepVerifier — runs deterministic verification checks for a test step.
 *
 * Supports: verifyFile, verifyEditor, verifyProblems, verifyCompletion, verifyNotification.
 * LLM-powered analysis is handled separately by TestRunner as post-failure analysis.
 */

import * as path from "node:path";
import type { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { TestStep } from "../types.js";

export class StepVerifier {
  private driver: VscodeDriver;

  constructor(driver: VscodeDriver) {
    this.driver = driver;
  }

  /**
   * Verify a step against all its verification criteria.
   * Runs deterministic checks first, then LLM verification if needed.
   *
   * @param screenshotPath — path to the after-action screenshot (for LLM verify)
   */
  async verify(
    step: TestStep,
  ): Promise<{ passed: boolean; reason?: string }> {
    // If no deterministic verification defined, auto-pass
    if (!step.verifyFile && !step.verifyNotification
        && !step.verifyEditor && !step.verifyProblems && !step.verifyCompletion
        && !step.verifyQuickInput && !step.verifyDialog) {
      return { passed: true };
    }

    // ── Deterministic verifications (run all, fail fast) ──

    const fileResult = await this.verifyFile(step);
    if (fileResult && !fileResult.passed) return fileResult;

    const notifResult = await this.verifyNotification(step);
    if (notifResult && !notifResult.passed) return notifResult;

    const editorResult = await this.verifyEditor(step);
    if (editorResult && !editorResult.passed) return editorResult;

    const problemsResult = await this.verifyProblems(step);
    if (problemsResult && !problemsResult.passed) return problemsResult;

    const completionResult = await this.verifyCompletion(step);
    if (completionResult && !completionResult.passed) return completionResult;

    const quickInputResult = await this.verifyQuickInput(step);
    if (quickInputResult && !quickInputResult.passed) return quickInputResult;

    const dialogResult = await this.verifyDialogCheck(step);
    if (dialogResult && !dialogResult.passed) return dialogResult;

    return { passed: true };
  }

  // ─── Deterministic Verifiers ─────────────────────────────

  private async verifyFile(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyFile) return null;

    // Support workspace-relative paths with "~/" prefix
    let filePath = step.verifyFile.path;
    if (filePath.startsWith("~/")) {
      const wsPath = this.driver.getWorkspacePath();
      if (!wsPath) return { passed: false, reason: "No workspace path available for ~/relative path" };
      filePath = path.join(wsPath, filePath.substring(2));
    } else {
      filePath = path.resolve(filePath);
    }
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
    return { passed: true };
  }

  private async verifyNotification(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyNotification) return null;

    const notifications = await this.driver.getNotifications();
    const found = notifications.some((n) => n.includes(step.verifyNotification!));
    if (!found) {
      return {
        passed: false,
        reason: `Notification not found: "${step.verifyNotification}". Got: [${notifications.join(", ")}]`,
      };
    }
    return { passed: true };
  }

  private async verifyEditor(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyEditor?.contains) return null;

    const found = await this.driver.editorContains(step.verifyEditor.contains);
    if (!found) {
      return {
        passed: false,
        reason: `Editor does not contain: "${step.verifyEditor.contains}"`,
      };
    }
    return { passed: true };
  }

  private async verifyProblems(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyProblems) return null;

    const maxWait = (step.timeout ?? 30) * 1000;
    const pollInterval = 3000;
    const deadline = Date.now() + maxWait;
    let lastCounts = { errors: 0, warnings: 0 };

    while (Date.now() < deadline) {
      lastCounts = await this.driver.getProblemsCount();
      // -1 means status bar not ready yet — keep polling
      if (lastCounts.errors === -1) {
        await this.driver.wait(pollInterval / 1000);
        continue;
      }
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
      if (errorsOk && warningsOk) return { passed: true };
      await this.driver.wait(pollInterval / 1000);
    }

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

  private async verifyCompletion(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyCompletion) return null;

    const maxWait = (step.timeout ?? 30) * 1000;
    const pollInterval = 1000;
    const deadline = Date.now() + maxWait;
    const vc = step.verifyCompletion;

    // Trigger completion once — then poll the open widget
    await this.driver.triggerCompletion();

    let lastItems: string[] = [];

    while (Date.now() < deadline) {
      // If the widget closed itself, retrigger
      const visible = await this.driver.isCompletionVisible();
      if (!visible) {
        await this.driver.triggerCompletion();
        await this.driver.wait(pollInterval / 1000);
        continue;
      }

      const items = await this.driver.readCompletionItems();
      lastItems = items;

      // Check positive conditions first (notEmpty, contains)
      if (vc.notEmpty && items.length === 0) {
        await this.driver.wait(pollInterval / 1000);
        continue;
      }

      let positivesMet = true;
      if (vc.contains) {
        for (const expected of vc.contains) {
          const found = items.some((item) =>
            item.toLowerCase().includes(expected.toLowerCase())
          );
          if (!found) {
            positivesMet = false;
            break;
          }
        }
      }

      if (!positivesMet) {
        console.log(`   ⏳ Completion missing expected items, retrying...`);
        await this.driver.wait(pollInterval / 1000);
        continue;
      }

      // Positive conditions met — now check excludes.
      // Wait a short grace period and re-read to let the list settle,
      // since LS items may still be arriving.
      await this.driver.wait(1);
      const settledItems = await this.driver.readCompletionItems();
      lastItems = settledItems.length > 0 ? settledItems : lastItems;

      if (vc.excludes) {
        for (const excluded of vc.excludes) {
          const found = lastItems.some((item) =>
            item.toLowerCase().includes(excluded.toLowerCase())
          );
          if (found) {
            await this.driver.dismissCompletion();
            return {
              passed: false,
              reason: `Completion list should NOT contain "${excluded}" but it does. Got: [${lastItems.slice(0, 15).join(", ")}${lastItems.length > 15 ? "..." : ""}]`,
            };
          }
        }
      }

      // All conditions passed
      await this.driver.dismissCompletion();
      return { passed: true };
    }

    // Timeout — read final state for error message
    const visible = await this.driver.isCompletionVisible();
    if (!visible) {
      // Try one last trigger
      lastItems = await this.driver.triggerCompletion();
      await this.driver.wait(2);
      lastItems = await this.driver.readCompletionItems();
    } else {
      lastItems = await this.driver.readCompletionItems();
    }
    await this.driver.dismissCompletion();

    if (vc.notEmpty && lastItems.length === 0) {
      return { passed: false, reason: "Expected non-empty completion list, got empty" };
    }
    if (vc.contains) {
      for (const expected of vc.contains) {
        const found = lastItems.some((item) =>
          item.toLowerCase().includes(expected.toLowerCase())
        );
        if (!found) {
          return {
            passed: false,
            reason: `Completion list missing "${expected}". Got: [${lastItems.slice(0, 10).join(", ")}${lastItems.length > 10 ? "..." : ""}]`,
          };
        }
      }
    }
    if (vc.excludes) {
      for (const excluded of vc.excludes) {
        const found = lastItems.some((item) =>
          item.toLowerCase().includes(excluded.toLowerCase())
        );
        if (found) {
          return {
            passed: false,
            reason: `Completion list should NOT contain "${excluded}" but it does. Got: [${lastItems.slice(0, 15).join(", ")}${lastItems.length > 15 ? "..." : ""}]`,
          };
        }
      }
    }
    return { passed: true };
  }

  private async verifyQuickInput(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyQuickInput) return null;
    const qi = step.verifyQuickInput;

    const message = await this.driver.getQuickInputValidationMessage();
    console.log(`   🔍 Quick input validation message: "${message}"`);

    if (qi.noError) {
      if (message && message.trim().length > 0) {
        return { passed: false, reason: `Expected no validation error, but got: "${message}"` };
      }
    }

    if (qi.messageContains) {
      if (!message.toLowerCase().includes(qi.messageContains.toLowerCase())) {
        return { passed: false, reason: `Validation message should contain "${qi.messageContains}" but got: "${message}"` };
      }
    }

    if (qi.messageExcludes) {
      if (message.toLowerCase().includes(qi.messageExcludes.toLowerCase())) {
        return { passed: false, reason: `Validation message should NOT contain "${qi.messageExcludes}" but got: "${message}"` };
      }
    }

    return { passed: true };
  }

  private async verifyDialogCheck(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyDialog) return null;

    const expectVisible = step.verifyDialog.visible !== false; // default true
    const isVisible = await this.driver.isDialogVisible();

    if (expectVisible && !isVisible) {
      return { passed: false, reason: "Expected a modal dialog to be visible, but none found" };
    }
    if (!expectVisible && isVisible) {
      return { passed: false, reason: "Expected no modal dialog, but one is visible" };
    }

    if (expectVisible && step.verifyDialog.contains) {
      const message = await this.driver.getDialogMessage();
      if (!message.toLowerCase().includes(step.verifyDialog.contains.toLowerCase())) {
        return {
          passed: false,
          reason: `Dialog message should contain "${step.verifyDialog.contains}" but got: "${message}"`,
        };
      }
    }

    return { passed: true };
  }

}
