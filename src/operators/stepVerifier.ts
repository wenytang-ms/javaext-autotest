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
        && !step.verifyEditor && !step.verifyProblems && !step.verifyCompletion) {
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

    return { passed: true };
  }

  // ─── Deterministic Verifiers ─────────────────────────────

  private async verifyFile(step: TestStep): Promise<{ passed: boolean; reason?: string } | null> {
    if (!step.verifyFile) return null;

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

    const items = await this.driver.triggerCompletion();
    await this.driver.dismissCompletion();

    if (step.verifyCompletion.notEmpty && items.length === 0) {
      return { passed: false, reason: "Expected non-empty completion list, got empty" };
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
    return { passed: true };
  }

}
