/**
 * StepVerifier — runs deterministic verification checks for a test step.
 *
 * Supports: verifyFile, verifyEditor, verifyProblems, verifyCompletion, verifyNotification.
 * LLM-powered analysis is handled separately by TestRunner as post-failure analysis.
 */

import * as path from "node:path";
import { createHash } from "node:crypto";
import type { VscodeDriver } from "../drivers/vscodeDriver.js";
import type {
  TestStep, VerificationActual, VerificationCheck, VerificationEvidence, VerifierKind,
} from "../types.js";
import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TREE_ITEM_TIMEOUT_S,
  PROBLEMS_POLL_INTERVAL_MS,
} from "./defaults.js";
import { computeDeadline, pollUntil, type VerifyResult } from "./verifierUtils.js";
import { sanitizeEvidence } from "./evidenceCollector.js";

type Observe = (actual: VerificationActual) => void;

export class StepVerifier {
  private driver: VscodeDriver;

  constructor(driver: VscodeDriver) {
    this.driver = driver;
  }

  /**
   * Verify a step against all its verification criteria.
   * Optional evidence records the values used by each check, without re-reading UI.
   */
  async verify(
    step: TestStep,
    evidence?: VerificationEvidence,
  ): Promise<{ passed: boolean; reason?: string }> {
    const verifiers: Array<[VerifierKind, (observe?: Observe) => Promise<VerifyResult | null>]> = [
      ["verifyFile", (observe) => this.verifyFile(step, observe)],
      ["verifyNotification", (observe) => this.verifyNotification(step, observe)],
      ["verifyEditor", (observe) => this.verifyEditor(step, observe)],
      ["verifyProblems", (observe) => this.verifyProblems(step, observe)],
      ["verifyCompletion", (observe) => this.verifyCompletion(step, observe)],
      ["verifyQuickInput", (observe) => this.verifyQuickInput(step, observe)],
      ["verifyDialog", (observe) => this.verifyDialogCheck(step, observe)],
      ["verifyTreeItem", (observe) => this.verifyTreeItemCheck(step, observe)],
      ["verifyEditorTab", (observe) => this.verifyEditorTabCheck(step, observe)],
      ["verifyWebview", (observe) => this.verifyWebviewCheck(step, observe)],
      ["verifyOutputChannel", (observe) => this.verifyOutputChannelCheck(step, observe)],
      ["verifyTerminal", (observe) => this.verifyTerminalCheck(step, observe)],
      ["verifyClipboard", (observe) => this.verifyClipboardCheck(step, observe)],
    ];
    if (evidence) {
      evidence.status = "not-configured";
      evidence.checks = verifiers.flatMap(([verifier]) => {
        const expected = step[verifier];
        return expected ? [{ verifier, expected, status: "not-run" as const }] : [];
      });
    }

    for (const [kind, verify] of verifiers) {
      const check = evidence?.checks.find((entry) => entry.verifier === kind);
      if (check) check.startedAt = new Date().toISOString();
      try {
        const result = await verify(check ? (actual) => this.observe(check, actual) : undefined);
        if (check) {
          check.completedAt = new Date().toISOString();
          check.status = result ? (result.passed ? "pass" : "fail") : "skipped";
          if (result?.reason) this.recordReason(check, result.reason);
          if (result && evidence) evidence.status = result.passed ? "pass" : "fail";
        }
        if (result && !result.passed) return result;
      } catch (e) {
        if (check && evidence) {
          check.completedAt = new Date().toISOString();
          check.status = "error";
          this.recordReason(check, (e as Error).message);
          evidence.status = "error";
        }
        throw e;
      }
    }
    return { passed: true };
  }

  private recordReason(check: VerificationCheck, reason: string): void {
    const redacted = sanitizeEvidence(reason);
    check.reason = redacted.slice(0, 4096);
    if (redacted.length > 4096) check.reasonTruncated = true;
  }

  private observe(check: VerificationCheck, actual: VerificationActual): void {
    const bounded: VerificationActual = {};
    const truncated = new Set(check.truncated);
    for (const [key, value] of Object.entries(actual)) {
      if (typeof value === "string") {
        bounded[key] = value.slice(0, 4096);
        if (value.length > 4096) truncated.add(key);
        else truncated.delete(key);
      } else if (Array.isArray(value)) {
        const entries: string[] = [];
        let remaining = 4096;
        for (const entry of value.slice(0, 100)) {
          if (remaining === 0) break;
          entries.push(entry.slice(0, remaining));
          remaining -= entries.at(-1)!.length;
        }
        bounded[key] = entries;
        if (entries.length !== value.length || entries.some((entry, index) => entry !== value[index])) truncated.add(key);
        else truncated.delete(key);
      } else {
        bounded[key] = value;
      }
    }
    check.actual = { ...check.actual, ...bounded };
    check.observedAt = new Date().toISOString();
    check.truncated = truncated.size ? [...truncated] : undefined;
  }

  // ─── Deterministic Verifiers ─────────────────────────────

  private async verifyFile(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
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
    const exists = await this.driver.fileExists(filePath);
    observe?.({ path: filePath, exists });
    if (step.verifyFile.exists === false) {
      if (exists) return { passed: false, reason: `File should not exist: ${filePath}` };
    } else {
      if (!exists) {
        return { passed: false, reason: `File not found: ${filePath}` };
      }
      // Evidence mode uses the same read for the verdict, excerpt, and content hash.
      const observedContent = observe && (step.verifyFile.contains || step.verifyFile.matches)
        ? await this.driver.readFile(filePath)
        : undefined;
      if (observedContent !== undefined) {
        observe?.({
          content: observedContent,
          contentLength: observedContent.length,
          sha256: createHash("sha256").update(observedContent).digest("hex"),
        });
      }
      if (step.verifyFile.contains) {
        const contains = observedContent === undefined
          ? await this.driver.fileContains(filePath, step.verifyFile.contains)
          : observedContent.includes(step.verifyFile.contains);
        observe?.({ containsMatched: contains });
        if (!contains) {
          const snippet = observedContent === undefined
            ? await this.readFileSnippet(filePath)
            : observedContent.slice(0, 2048);
          return {
            passed: false,
            reason: `File does not contain: "${step.verifyFile.contains}"\n--- file (${filePath}) ---\n${snippet}\n--- end ---`,
          };
        }
      }
      if (step.verifyFile.matches) {
        const content = observedContent ?? await this.driver.readFile(filePath);
        let re: RegExp;
        try {
          re = new RegExp(step.verifyFile.matches);
        } catch (e) {
          return { passed: false, reason: `Invalid regex in verifyFile.matches: "${step.verifyFile.matches}" — ${(e as Error).message}` };
        }
        const matches = re.test(content);
        observe?.({ regexMatched: matches });
        if (!matches) {
          const snippet = observedContent === undefined
            ? await this.readFileSnippet(filePath)
            : observedContent.slice(0, 2048);
          return {
            passed: false,
            reason: `File does not match regex: /${step.verifyFile.matches}/\n--- file (${filePath}) ---\n${snippet}\n--- end ---`,
          };
        }
      }
    }
    return { passed: true };
  }

  /** Read up to ~2KB of a file for inclusion in failure reasons. */
  private async readFileSnippet(filePath: string): Promise<string> {
    try {
      const content = await this.driver.readFile(filePath);
      const max = 2048;
      return content.length > max ? content.substring(0, max) + "\n…(truncated)" : content;
    } catch (e) {
      return `(could not read file: ${(e as Error).message})`;
    }
  }

  private async verifyNotification(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyNotification) return null;

    const notifications = await this.driver.getNotifications();
    observe?.({ notifications });
    const found = notifications.some((n) => n.includes(step.verifyNotification!));
    if (!found) {
      return {
        passed: false,
        reason: `Notification not found: "${step.verifyNotification}". Got: [${notifications.join(", ")}]`,
      };
    }
    return { passed: true };
  }

  private async verifyEditor(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyEditor?.contains) return null;

    const found = await this.driver.editorContains(step.verifyEditor.contains);
    observe?.({ containsMatched: found });
    if (!found) {
      return {
        passed: false,
        reason: `Editor does not contain: "${step.verifyEditor.contains}"`,
      };
    }
    return { passed: true };
  }

  private async verifyProblems(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
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
        observe?.({ ...lastCounts });
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

  private async verifyCompletion(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
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
      observe?.({ items: lastItems });

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
      observe?.({ items: lastItems });

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
    observe?.({ items: lastItems });
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

  private async verifyQuickInput(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyQuickInput) return null;
    const qi = step.verifyQuickInput;

    const message = await this.driver.getQuickInputValidationMessage();
    observe?.({ message });
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

  private async verifyDialogCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyDialog) return null;

    const expectVisible = step.verifyDialog.visible !== false; // default true
    const isVisible = await this.driver.isDialogVisible();
    observe?.({ visible: isVisible });

    if (expectVisible && !isVisible) {
      return { passed: false, reason: "Expected a modal dialog to be visible, but none found" };
    }
    if (!expectVisible && isVisible) {
      return { passed: false, reason: "Expected no modal dialog, but one is visible" };
    }

    if (expectVisible && step.verifyDialog.contains) {
      const message = await this.driver.getDialogMessage();
      observe?.({ message });
      if (!message.toLowerCase().includes(step.verifyDialog.contains.toLowerCase())) {
        return {
          passed: false,
          reason: `Dialog message should contain "${step.verifyDialog.contains}" but got: "${message}"`,
        };
      }
    }

    return { passed: true };
  }

  private async verifyTreeItemCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyTreeItem) return null;

    const expectVisible = step.verifyTreeItem.visible !== false; // default true
    const exact = step.verifyTreeItem.exact ?? false;
    const expectedCount = step.verifyTreeItem.count;
    const level = step.verifyTreeItem.level;
    const timeoutMs = (step.timeout ?? DEFAULT_TREE_ITEM_TIMEOUT_S) * 1000;

    if (expectedCount !== undefined) {
      if (!Number.isInteger(expectedCount) || expectedCount < 0) {
        return { passed: false, reason: `Tree item count must be a non-negative integer, got ${expectedCount}` };
      }
      if (level !== undefined && (!Number.isInteger(level) || level < 1)) {
        return { passed: false, reason: `Tree item level must be a positive integer, got ${level}` };
      }
      const matched = await this.driver.waitForTreeItemCount(
        step.verifyTreeItem.name,
        expectedCount,
        timeoutMs,
        exact,
        step.verifyTreeItem.inView,
        level,
      );
      observe?.({ countConditionMet: matched });
      if (!matched) {
        return {
          passed: false,
          reason: `Expected ${expectedCount} visible tree item(s) named "${step.verifyTreeItem.name}"` +
            `${level === undefined ? "" : ` at level ${level}`}` +
            `${step.verifyTreeItem.inView ? ` in view "${step.verifyTreeItem.inView}"` : ""}` +
            ` within ${timeoutMs / 1000}s`,
        };
      }
      return { passed: true };
    }

    if (level !== undefined && (!Number.isInteger(level) || level < 1)) {
      return { passed: false, reason: `Tree item level must be a positive integer, got ${level}` };
    }

    if (expectVisible) {
      const found = await this.driver.waitForTreeItem(
        step.verifyTreeItem.name, timeoutMs, exact, step.verifyTreeItem.inView, level,
      );
      observe?.({ appeared: found });
      if (!found) {
        return { passed: false, reason: `Tree item "${step.verifyTreeItem.name}" did not appear within ${timeoutMs / 1000}s${step.verifyTreeItem.inView ? ` in view "${step.verifyTreeItem.inView}"` : ""}` };
      }
    } else {
      const gone = await this.driver.waitForTreeItemGone(
        step.verifyTreeItem.name, timeoutMs, exact, step.verifyTreeItem.inView, level,
      );
      observe?.({ disappeared: gone });
      if (!gone) {
        return { passed: false, reason: `Tree item "${step.verifyTreeItem.name}" did not disappear within ${timeoutMs / 1000}s${step.verifyTreeItem.inView ? ` in view "${step.verifyTreeItem.inView}"` : ""}` };
      }
    }
    return { passed: true };
  }

  private async verifyEditorTabCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyEditorTab) return null;

    const timeoutMs = (step.timeout ?? DEFAULT_TREE_ITEM_TIMEOUT_S) * 1000;
    const { title, active } = step.verifyEditorTab;
    if (active !== undefined && typeof active !== "boolean") {
      return { passed: false, reason: "verifyEditorTab.active must be a boolean" };
    }
    const found = active
      ? await this.driver.waitForEditorTab(title, timeoutMs, true)
      : await this.driver.waitForEditorTab(title, timeoutMs);
    observe?.({ appeared: found, ...(active ? { active: found } : {}) });
    if (!found) {
      return { passed: false, reason: `Editor tab "${title}" did not ${active ? "become active" : "appear"} within ${timeoutMs / 1000}s` };
    }
    return { passed: true };
  }

  private async verifyWebviewCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyWebview) return null;

    let text = "";
    return pollUntil<VerifyResult>(step, {
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        text = await this.driver.getWebviewText();
        observe?.({ text });
        const containsOk = this.asArray(step.verifyWebview?.contains).every((expected) => text.includes(expected));
        const notContainsOk = this.asArray(step.verifyWebview?.notContains).every((unexpected) => !text.includes(unexpected));
        if (containsOk && notContainsOk) return { done: true, result: { passed: true } };
        return { done: false };
      },
      onTimeout: async () => {
        const missing = this.asArray(step.verifyWebview?.contains).find((expected) => !text.includes(expected));
        if (missing !== undefined) {
          return { passed: false, reason: `Webview does not contain: "${missing}". Webview text: ${text.slice(0, 1000)}` };
        }
        const unexpected = this.asArray(step.verifyWebview?.notContains).find((value) => text.includes(value));
        if (unexpected !== undefined) {
          return { passed: false, reason: `Webview unexpectedly contains: "${unexpected}"` };
        }
        return { passed: true };
      },
    });
  }

  private async verifyOutputChannelCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyOutputChannel) return null;

    const { channel, contains, notContains } = step.verifyOutputChannel;
    let text = "";

    return pollUntil<VerifyResult>(step, {
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        text = await this.driver.getOutputChannelText(channel);
        observe?.({ channel, text });
        if (notContains && text.includes(notContains)) {
          return {
            done: true,
            result: {
              passed: false,
              reason: `Output channel "${channel}" unexpectedly contains: "${notContains}"`,
            },
          };
        }
        if (!contains || text.includes(contains)) {
          return { done: true, result: { passed: true } };
        }
        return { done: false };
      },
      onTimeout: async () => ({
        passed: false,
        reason: `Output channel "${channel}" does not contain: "${contains}". Output text: ${text.slice(-1000)}`,
      }),
    });
  }

  private async verifyTerminalCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyTerminal) return null;

    const { contains, notContains } = step.verifyTerminal;
    let text = "";

    return pollUntil<VerifyResult>(step, {
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        text = await this.driver.getTerminalText();
        observe?.({ text });
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

  private async verifyClipboardCheck(step: TestStep, observe?: Observe): Promise<VerifyResult | null> {
    if (!step.verifyClipboard) return null;

    const { exact, contains, notContains, matches, notEmpty } = step.verifyClipboard;

    let re: RegExp | undefined;
    if (matches !== undefined) {
      try {
        re = new RegExp(matches);
      } catch (e) {
        return { passed: false, reason: `Invalid regex in verifyClipboard.matches: "${matches}" — ${(e as Error).message}` };
      }
    }

    let text = "";

    return pollUntil<VerifyResult>(step, {
      waitFn: (s) => this.driver.wait(s),
      check: async () => {
        text = await this.driver.readClipboard();
        observe?.({ text });

        const exactOk = exact === undefined || text === exact;
        const containsOk = contains === undefined || text.includes(contains);
        const notContainsOk = notContains === undefined || !text.includes(notContains);
        const matchesOk = re === undefined || re.test(text);
        const notEmptyOk = !notEmpty || text.length > 0;

        if (exactOk && containsOk && notContainsOk && matchesOk && notEmptyOk) {
          return { done: true, result: { passed: true } };
        }
        return { done: false };
      },
      onTimeout: async () => {
        const snippet = text.length > 500 ? text.slice(0, 500) + "…(truncated)" : text;
        if (exact !== undefined && text !== exact) {
          return { passed: false, reason: `Clipboard text mismatch.\n  expected (exact): ${JSON.stringify(exact)}\n  actual:           ${JSON.stringify(snippet)}` };
        }
        if (contains !== undefined && !text.includes(contains)) {
          return { passed: false, reason: `Clipboard does not contain: "${contains}". Clipboard text: ${JSON.stringify(snippet)}` };
        }
        if (notContains !== undefined && text.includes(notContains)) {
          return { passed: false, reason: `Clipboard unexpectedly contains: "${notContains}". Clipboard text: ${JSON.stringify(snippet)}` };
        }
        if (re !== undefined && !re.test(text)) {
          return { passed: false, reason: `Clipboard does not match regex: /${matches}/. Clipboard text: ${JSON.stringify(snippet)}` };
        }
        if (notEmpty && text.length === 0) {
          return { passed: false, reason: "Clipboard is empty (expected non-empty)." };
        }
        return { passed: true };
      },
    });
  }

  private asArray(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
  }

}
