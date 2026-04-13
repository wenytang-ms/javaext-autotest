/**
 * Test Runner — orchestrates test plan execution.
 *
 * Delegates action resolution to ActionResolver and verification to StepVerifier.
 * Handles lifecycle (launch/close), screenshots, and reporting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { StepResult, TestPlan, TestReport, TestStep } from "../types.js";
import { ActionResolver } from "./actionResolver.js";
import { LLMClient } from "./llmClient.js";
import { StepVerifier } from "./stepVerifier.js";

export interface TestRunnerOptions {
  /** Output directory for this test run. Contains screenshots/ and results.json. */
  outputDir?: string;
  /** Disable LLM verification (auto-pass all `verify` fields). */
  noLLM?: boolean;
}

export class TestRunner {
  private driver: VscodeDriver;
  private plan: TestPlan;
  private actionResolver: ActionResolver;
  private verifier: StepVerifier;
  private outputDir: string | null;
  private screenshotDir: string | null;
  private screenshotCounter = 0;

  constructor(plan: TestPlan, options: TestRunnerOptions = {}) {
    this.plan = plan;
    this.outputDir = options.outputDir ?? null;
    this.screenshotDir = this.outputDir ? path.join(this.outputDir, "screenshots") : null;

    this.driver = new VscodeDriver({
      vscodeVersion: plan.setup.vscodeVersion,
      extensionPath: plan.setup.extensionPath,
      extensions: plan.setup.extensions,
      workspacePath: plan.setup.workspace,
      settings: plan.setup.settings,
    });

    this.actionResolver = new ActionResolver(this.driver, {
      lsTimeout: (plan.setup.timeout ?? 120) * 1000,
    });

    const llm = options.noLLM ? null : new LLMClient();
    this.verifier = new StepVerifier(this.driver, { llmClient: llm });
  }

  /** Force-close the VSCode instance (for signal handlers) */
  async cleanup(): Promise<void> {
    await this.driver.close();
  }

  async run(): Promise<TestReport> {
    const startTime = new Date();
    const results: StepResult[] = [];

    // Prepare output directory — clean stale data from previous runs
    if (this.outputDir) {
      if (fs.existsSync(this.outputDir)) {
        fs.rmSync(this.outputDir, { recursive: true, force: true });
      }
      fs.mkdirSync(this.outputDir, { recursive: true });
      fs.mkdirSync(this.screenshotDir!, { recursive: true });
      console.log(`📂 Output → ${this.outputDir}`);
    }

    try {
      console.log(`\n🚀 Launching VSCode for: ${this.plan.name}`);
      await this.driver.launch();
      console.log(`✅ VSCode ready\n`);

      // Brief wait for UI to settle (not the full setup.timeout — that's for LS steps)
      await this.driver.wait(3);

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

    const report: TestReport = {
      planName: this.plan.name,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: endTime.getTime() - startTime.getTime(),
      results,
      summary,
    };

    // Save results.json into output directory
    if (this.outputDir) {
      const reportPath = path.join(this.outputDir, "results.json");
      fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
      console.log(`📄 Report → ${reportPath}`);
    }

    return report;
  }

  private async executeStep(step: TestStep): Promise<StepResult> {
    const start = Date.now();
    let beforePath: string | undefined;

    try {
      if (step.waitBefore) {
        await this.driver.wait(step.waitBefore);
      }

      beforePath = await this.takeScreenshot(step.id, "before");

      // Delegate action execution to ActionResolver
      await this.actionResolver.resolve(step.action);

      const afterPath = await this.takeScreenshot(step.id, "after");

      // Delegate verification to StepVerifier (pass screenshot for LLM)
      const verifyResult = await this.verifier.verify(step, afterPath);

      return {
        stepId: step.id,
        action: step.action,
        status: verifyResult.passed ? "pass" : "fail",
        reason: verifyResult.reason,
        duration: Date.now() - start,
        screenshot: afterPath,
      };
    } catch (e) {
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

  private async takeScreenshot(stepId: string, phase: "before" | "after" | "error"): Promise<string | undefined> {
    if (!this.screenshotDir) return undefined;
    try {
      const seq = String(++this.screenshotCounter).padStart(2, "0");
      const fileName = `${seq}_${stepId}_${phase}.png`;
      const filePath = path.join(this.screenshotDir, fileName);
      await this.driver.screenshot(filePath);
      return filePath;
    } catch {
      return undefined;
    }
  }
}
