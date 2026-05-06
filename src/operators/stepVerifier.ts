/**
 * StepVerifier — runs deterministic verification checks for a test step.
 *
 * Supports: verifyFile, verifyEditor, verifyProblems, verifyCompletion, verifyNotification.
 * LLM-powered analysis is handled separately by TestRunner as post-failure analysis.
 */

import * as path from "node:path";
import type { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { TestStep } from "../types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TREE_ITEM_TIMEOUT_S,
  PROBLEMS_POLL_INTERVAL_MS,
} from "./defaults.js";
import { computeDeadline, pollUntil, type VerifyResult } from "./verifierUtils.js";

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
        && !step.verifyQuickInput && !step.verifyDialog
        && !step.verifyTreeItem && !step.verifyEditorTab
        && !step.verifyOutputChannel && !step.verifyTerminal) {
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

    const treeItemResult = await this.verifyTreeItemCheck(step);
    if (treeItemResult && !treeItemResult.passed) return treeItemResult;

    const editorTabResult = await this.verifyEditorTabCheck(step);
    if (editorTabResult && !editorTabResult.passed) return editorTabResult;

    const outputChannelResult = await this.verifyOutputChannelCheck(step);
    if (outputChannelResult && !outputChannelResult.passed) return outputChannelResult;

    const terminalResult = await this.verifyTerminalCheck(step);
    if (terminalResult && !terminalResult.passed) return terminalResult;

    return { passed: true };
  }

  // ─── Deterministic Verifiers ─────────────────────────────

  private async verifyFile(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyFile) return null;

    // Support workspace-relative paths with "~/" prefix and workspace placeholders.
    const rawPath = step.verifyFile.path;
    const wsPath = this.driver.getWorkspacePath();
    const needsWorkspace =
      rawPath.startsWith("~/") ||
      rawPath.includes("${workspaceFolder}") ||
      rawPath.includes("${workspaceParent}");
    if (needsWorkspace && !wsPath) {
      return { passed: false, reason: "No workspace path available for workspace-relative path" };
    }
    const filePath = path.resolve(this.driver.resolveWorkspacePlaceholders(rawPath) as string);
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

  private async verifyProblems(step: TestStep): Promise<VerifyResult | null> {
    if (!step.verifyProblems) return null;

    const expected = step.verifyProblems;
    let lastCounts = { errors: 0, warnings: 0 };
    const matches = (actual: number, target?: number) =>
      target === undefined || (expected.atLeast ? actual >= target : actual === target);

    return pollUntil<VerifyResult>(step, {
      pollIntervalMs: PROBLEMS_POLL_INTERVAL_MS,
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        lastCounts = await this.driver.getProblemsCount();
        // -1 means status bar not ready yet — keep polling
        if (lastCounts.errors === -1) return { done: false };
        if (matches(lastCounts.errors, expected.errors) && matches(lastCounts.warnings, expected.warnings)) {
          return { done: true, result: { passed: true } };
        }
        return { done: false };
      },
      onTimeout: async () => {
        const parts: string[] = [];
        if (expected.errors !== undefined) {
          const cmp = expected.atLeast ? "at least " : "";
          parts.push(`Expected ${cmp}${expected.errors} errors, got ${lastCounts.errors}`);
        }
        if (expected.warnings !== undefined) {
          const cmp = expected.atLeast ? "at least " : "";
          parts.push(`Expected ${cmp}${expected.warnings} warnings, got ${lastCounts.warnings}`);
        }
        return { passed: false, reason: parts.join("; ") };
      },
    });
  }

  private async verifyCompletion(step: TestStep): Promise<VerifyResult | null> {
    if (!step.verifyCompletion) return null;

    const vc = step.verifyCompletion;
    const deadline = computeDeadline(step);
    const pollIntervalSeconds = DEFAULT_POLL_INTERVAL_MS / 1000;

    // Trigger completion once — then poll the open widget
    await this.driver.triggerCompletion();

    let lastItems: string[] = [];

    while (Date.now() < deadline) {
      // If the widget closed itself, retrigger
      if (!(await this.driver.isCompletionVisible())) {
        await this.driver.triggerCompletion();
        await this.driver.wait(pollIntervalSeconds);
        continue;
      }

      lastItems = await this.driver.readCompletionItems();

      if (vc.notEmpty && lastItems.length === 0) {
        await this.driver.wait(pollIntervalSeconds);
        continue;
      }
      if (vc.contains && !this.containsAll(lastItems, vc.contains)) {
        console.log(`   ⏳ Completion missing expected items, retrying...`);
        await this.driver.wait(pollIntervalSeconds);
        continue;
      }

      // Positive conditions met — grace period for the LS to deliver remaining
      // items, then re-read before checking excludes.
      await this.driver.wait(1);
      const settledItems = await this.driver.readCompletionItems();
      if (settledItems.length > 0) lastItems = settledItems;

      const excludeFailure = this.findExcludeFailure(lastItems, vc.excludes);
      await this.driver.dismissCompletion();
      return excludeFailure ?? { passed: true };
    }

    // Timeout — read final state for error message
    if (!(await this.driver.isCompletionVisible())) {
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
      const missing = vc.contains.find((expected) => !this.matchesAny(lastItems, expected));
      if (missing !== undefined) {
        return {
          passed: false,
          reason: `Completion list missing "${missing}". Got: ${this.previewItems(lastItems, 10)}`,
        };
      }
    }
    return this.findExcludeFailure(lastItems, vc.excludes) ?? { passed: true };
  }

  // ─── Completion helpers ────────────────────────────────

  private matchesAny(items: string[], expected: string): boolean {
    const needle = expected.toLowerCase();
    return items.some((item) => item.toLowerCase().includes(needle));
  }

  private containsAll(items: string[], expected: string[]): boolean {
    return expected.every((e) => this.matchesAny(items, e));
  }

  private findExcludeFailure(items: string[], excludes: string[] | undefined): VerifyResult | null {
    if (!excludes) return null;
    const offending = excludes.find((excluded) => this.matchesAny(items, excluded));
    if (offending === undefined) return null;
    return {
      passed: false,
      reason: `Completion list should NOT contain "${offending}" but it does. Got: ${this.previewItems(items, 15)}`,
    };
  }

  private previewItems(items: string[], limit: number): string {
    const head = items.slice(0, limit).join(", ");
    return `[${head}${items.length > limit ? "..." : ""}]`;
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

  private async verifyTreeItemCheck(step: TestStep): Promise<VerifyResult | null> {
    if (!step.verifyTreeItem) return null;

    const expectVisible = step.verifyTreeItem.visible !== false; // default true
    const exact = step.verifyTreeItem.exact ?? false;
    const timeoutMs = (step.timeout ?? DEFAULT_TREE_ITEM_TIMEOUT_S) * 1000;

    if (expectVisible) {
      const found = await this.driver.waitForTreeItem(step.verifyTreeItem.name, timeoutMs, exact);
      if (!found) {
        return { passed: false, reason: `Tree item "${step.verifyTreeItem.name}" did not appear within ${timeoutMs / 1000}s` };
      }
    } else {
      const gone = await this.driver.waitForTreeItemGone(step.verifyTreeItem.name, timeoutMs, exact);
      if (!gone) {
        return { passed: false, reason: `Tree item "${step.verifyTreeItem.name}" did not disappear within ${timeoutMs / 1000}s` };
      }
    }
    return { passed: true };
  }

  private async verifyEditorTabCheck(step: TestStep): Promise<VerifyResult | null> {
    if (!step.verifyEditorTab) return null;

    const timeoutMs = (step.timeout ?? DEFAULT_TREE_ITEM_TIMEOUT_S) * 1000;
    const found = await this.driver.waitForEditorTab(step.verifyEditorTab.title, timeoutMs);
    if (!found) {
      return { passed: false, reason: `Editor tab "${step.verifyEditorTab.title}" did not appear within ${timeoutMs / 1000}s` };
    }
    return { passed: true };
  }

  private async verifyOutputChannelCheck(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyOutputChannel) return null;

    const { channel, contains, notContains } = step.verifyOutputChannel;
    const text = await this.driver.getOutputChannelText(channel);

    if (contains && !text.includes(contains)) {
      return { passed: false, reason: `Output channel "${channel}" does not contain: "${contains}"` };
    }
    if (notContains && text.includes(notContains)) {
      return { passed: false, reason: `Output channel "${channel}" unexpectedly contains: "${notContains}"` };
    }
    return { passed: true };
  }

  private async verifyTerminalCheck(step: TestStep): Promise<VerifyResult | null> {
    if (!step.verifyTerminal) return null;

    const { contains, notContains } = step.verifyTerminal;
    let text = "";

    return pollUntil<VerifyResult>(step, {
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        text = await this.driver.getTerminalText();
        const containsOk = !contains || text.includes(contains);
        const notContainsOk = !notContains || !text.includes(notContains);
        if (containsOk && notContainsOk) return { done: true, result: { passed: true } };
        return { done: false };
      },
      onTimeout: async () => {
        if (contains && !text.includes(contains)) {
          return { passed: false, reason: `Terminal does not contain: "${contains}". Terminal text: ${text.slice(-1000)}` };
        }
        if (notContains && text.includes(notContains)) {
          return { passed: false, reason: `Terminal unexpectedly contains: "${notContains}"` };
        }
        return { passed: true };
      },
    });
  }

}
