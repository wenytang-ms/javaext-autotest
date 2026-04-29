/**
 * Test Runner — orchestrates test plan execution.
 *
 * Delegates action resolution to ActionResolver and verification to StepVerifier.
 * Handles lifecycle (launch/close), screenshots, and reporting.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { execSync } from "node:child_process";
import { VscodeDriver } from "../drivers/vscodeDriver.js";
import type { RepoClone, StepResult, TestPlan, TestReport, TestStep } from "../types.js";
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
  private llm: LLMClient | null;
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
      extensionPaths: plan.setup.extensionPaths,
      localExtensions: plan.setup.localExtensions,
      extensions: [
        // setup.extension is the primary extension — install it too
        ...(plan.setup.extension ? [plan.setup.extension] : []),
        ...(plan.setup.extensions ?? []),
      ],
      vsix: plan.setup.vsix,
      workspacePath: plan.setup.workspace,
      filePath: plan.setup.file,
      settings: plan.setup.settings,
      workspaceSettings: plan.setup.workspaceSettings,
      workspaceTrust: plan.setup.workspaceTrust,
      mockOpenDialog: plan.setup.mockOpenDialog,
    });

    this.actionResolver = new ActionResolver(this.driver, {
      lsTimeout: (plan.setup.timeout ?? 120) * 1000,
    });

    this.verifier = new StepVerifier(this.driver);
    this.llm = options.noLLM ? null : new LLMClient();
  }

  /** Force-close the VSCode instance (for signal handlers) */
  async cleanup(): Promise<void> {
    await this.driver.close();
  }

  async run(): Promise<TestReport> {
    const startTime = new Date();
    const results: StepResult[] = [];
    let crashed = false;
    let crashReason = "";

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
      // Clone required repos if specified
      if (this.plan.setup.repos?.length) {
        await this.cloneRepos(this.plan.setup.repos);
      }

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
      const errorMsg = (e as Error).message;
      console.error(`\n💥 Fatal error: ${errorMsg}`);
      crashed = true;
      crashReason = errorMsg;
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

    // Detect crash: plan has steps but none executed
    if (!crashed && results.length === 0 && this.plan.steps.length > 0) {
      crashed = true;
      crashReason = crashReason || "VSCode exited before any steps could execute";
    }

    if (crashed) {
      console.log(`\n💥 CRASHED: ${crashReason}`);
      console.log(`   ${this.plan.steps.length} step(s) were skipped`);
    } else {
      console.log(`\n📊 Results: ${summary.passed}/${summary.total} passed`);
    }

    // Post-analysis: use LLM to analyze failed/error steps and provide suggestions
    if (this.llm?.isConfigured() && (summary.failed + summary.errors) > 0 && this.screenshotDir) {
      console.log(`\n🤖 Analyzing ${summary.failed + summary.errors} failed step(s) with LLM...`);
      for (const result of results) {
        if (result.status !== "fail" && result.status !== "error") continue;
        await this.analyzeFailure(result);
      }
    }

    const report: TestReport = {
      planName: this.plan.name,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: endTime.getTime() - startTime.getTime(),
      results,
      ...(crashed ? { crashed: true, crashReason } : {}),
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

      // Delegate verification to StepVerifier (deterministic only)
      const verifyResult = await this.verifier.verify(step);

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

  private async cloneRepos(repos: RepoClone[]): Promise<void> {
    for (const repo of repos) {
      // Derive local path from URL if not specified
      const repoName = repo.url.replace(/\.git$/, "").split("/").pop() ?? "repo";
      const targetPath = repo.path ?? path.resolve(repoName);

      if (fs.existsSync(targetPath)) {
        console.log(`📦 Repo already exists: ${targetPath}`);
        continue;
      }

      console.log(`📦 Cloning ${repo.url} → ${targetPath}`);
      const branchArg = repo.branch ? `--branch ${repo.branch}` : "";
      try {
        execSync(`git clone --depth 1 ${branchArg} ${repo.url} "${targetPath}"`, {
          stdio: "pipe",
          timeout: 120_000,
        });
        console.log(`📦 Clone complete`);
      } catch (e) {
        throw new Error(`Failed to clone ${repo.url}: ${(e as Error).message.slice(0, 200)}`);
      }
    }
  }

  private async analyzeFailure(result: StepResult): Promise<void> {
    if (!this.llm || !this.screenshotDir) return;

    // Find before/after screenshots for this step
    const files = fs.readdirSync(this.screenshotDir);
    const beforeFile = files.find(f => f.includes(`_${result.stepId}_before.png`));
    const afterFile = files.find(f => f.includes(`_${result.stepId}_after.png`))
      ?? files.find(f => f.includes(`_${result.stepId}_error.png`));

    if (!beforeFile || !afterFile) return;

    const beforeBase64 = fs.readFileSync(path.join(this.screenshotDir, beforeFile)).toString("base64");
    const afterBase64 = fs.readFileSync(path.join(this.screenshotDir, afterFile)).toString("base64");

    const step = this.plan.steps.find(s => s.id === result.stepId);
    const verifyDesc = step?.verify ?? `Action "${result.action}" should have succeeded`;

    try {
      const analysis = await this.llm.verifyStep(
        beforeBase64, afterBase64, result.action, verifyDesc
      );

      console.log(`\n   🤖 [${result.stepId}] LLM Analysis:`);
      console.log(`      Reasoning: ${analysis.reasoning}`);
      if (analysis.suggestion) {
        console.log(`      💡 Suggestion: ${analysis.suggestion}`);
      }

      result.reason = `${result.reason}\n[LLM] ${analysis.reasoning}${analysis.suggestion ? `\n💡 ${analysis.suggestion}` : ""}`;
    } catch (e) {
      console.log(`   🤖 ⚠️ LLM analysis error: ${(e as Error).message}`);
    }
  }
}
