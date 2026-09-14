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
import type {
  AnalysisMode,
  CaseAnalysis,
  EvidenceBundleManifest,
  RepoClone,
  StepAttemptResult,
  StepResult,
  TestPlan,
  TestReport,
  TestStep,
} from "../types.js";
import { ActionResolver } from "./actionResolver.js";
import { EvidenceCollector } from "./evidenceCollector.js";
import { LLMClient, type CaseScreenshot } from "./llmClient.js";
import { StepVerifier } from "./stepVerifier.js";

export interface TestRunnerOptions {
  /** Output directory for this test run. Contains screenshots/ and results.json. */
  outputDir?: string;
  /** Disable LLM verification (auto-pass all `verify` fields). */
  noLLM?: boolean;
  /** Opt-in analysis pipeline. Defaults to legacy behavior. */
  analysisMode?: AnalysisMode;
}

export class TestRunner {
  private driver: VscodeDriver;
  private plan: TestPlan;
  private actionResolver: ActionResolver;
  private verifier: StepVerifier;
  private evidenceCollector: EvidenceCollector | null;
  private llm: LLMClient | null;
  private analysisMode: AnalysisMode;
  private outputDir: string | null;
  private screenshotDir: string | null;
  private screenshotCounter = 0;

  constructor(plan: TestPlan, options: TestRunnerOptions = {}) {
    this.plan = plan;
    this.outputDir = options.outputDir ?? null;
    this.screenshotDir = this.outputDir ? path.join(this.outputDir, "screenshots") : null;
    this.analysisMode = options.analysisMode ?? "legacy";
    const evidenceEnabled = this.analysisMode !== "legacy";

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
      preRelease: plan.setup.preRelease,
      workspacePath: plan.setup.workspace,
      filePath: plan.setup.file,
      settings: plan.setup.settings,
      workspaceSettings: plan.setup.workspaceSettings,
      workspaceTrust: plan.setup.workspaceTrust,
      mockOpenDialog: plan.setup.mockOpenDialog,
      enableEvidenceProbe: evidenceEnabled,
    });

    this.actionResolver = new ActionResolver(this.driver, {
      lsTimeout: (plan.setup.timeout ?? 120) * 1000,
    });

    this.verifier = new StepVerifier(this.driver);
    this.evidenceCollector = evidenceEnabled
      ? new EvidenceCollector(this.driver, this.outputDir)
      : null;
    this.llm = options.noLLM || this.analysisMode === "evidence-only"
      ? null
      : new LLMClient();
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
    let runEvidence: TestReport["evidence"];

    this.prepareOutputDir();

    try {
      if (this.plan.setup.repos?.length) {
        await this.cloneRepos(this.plan.setup.repos);
      }

      console.log(`\n🚀 Launching VSCode for: ${this.plan.name}`);
      await this.driver.launch();
      console.log(`✅ VSCode ready\n`);

      // Brief wait for UI to settle (not the full setup.timeout — that's for LS steps)
      await this.driver.wait(3);

      await this.runSteps(results);
    } catch (e) {
      const errorMsg = (e as Error).message;
      console.error(`\n💥 Fatal error: ${errorMsg}`);
      crashed = true;
      crashReason = errorMsg;
    } finally {
      if (this.evidenceCollector) {
        const collectionErrors: string[] = [];
        try {
          await this.driver.refreshProbeSnapshot();
        } catch (e) {
          collectionErrors.push(`Probe refresh failed: ${(e as Error).message}`);
        }
        try {
          runEvidence = this.evidenceCollector.collectRunEvidence(collectionErrors);
        } catch (e) {
          console.warn(`⚠️  Could not collect run evidence: ${(e as Error).message}`);
        }
      }
      await this.driver.close();
    }

    const endTime = new Date();
    const summary = this.summarize(results);

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

    if (
      this.analysisMode === "legacy"
      && (summary.failed + summary.errors) > 0
    ) {
      await this.analyzeFailedStepsLegacy(results);
    }

    const report: TestReport = {
      planName: this.plan.name,
      startTime: startTime.toISOString(),
      endTime: endTime.toISOString(),
      duration: endTime.getTime() - startTime.getTime(),
      results,
      ...(crashed ? { crashed: true, crashReason } : {}),
      summary,
      ...(runEvidence ? { evidence: runEvidence } : {}),
    };

    this.writeReport(report);
    if (this.analysisMode !== "legacy" && this.evidenceCollector) {
      report.analysis = {
        schemaVersion: 1,
        mode: this.analysisMode,
      };
      let evidenceManifest: string | undefined;
      try {
        evidenceManifest = this.evidenceCollector.writeBundle(
          this.plan,
          results,
          runEvidence,
          crashed,
        );
        if (evidenceManifest) {
          report.analysis.evidenceManifest = evidenceManifest;
        }
      } catch (e) {
        this.appendAnalysisError(
          report,
          `Evidence bundle failed: ${(e as Error).message}`,
        );
      }
      this.writeReport(report, false);

      if (this.analysisMode === "case") {
        if (this.llm?.isConfigured()) {
          try {
            report.analysis.case = await this.llm.analyzeCase({
              plan: this.plan,
              report,
              evidenceManifestPath: evidenceManifest,
              evidenceManifest: this.readEvidenceManifest(evidenceManifest),
              screenshots: this.collectCaseScreenshots(results),
            });
            const caseAnalysisPath = this.writeCaseAnalysis(report.analysis.case);
            if (caseAnalysisPath) {
              report.analysis.caseAnalysisPath = caseAnalysisPath;
            }
            console.log(`\n🤖 Case Analysis: ${report.analysis.case.summary}`);
          } catch (e) {
            const message = `Case analysis failed: ${(e as Error).message}`;
            this.appendAnalysisError(report, message);
            console.warn(`⚠️  ${message}`);
          }
        } else {
          this.appendAnalysisError(report, "LLM not configured or disabled");
        }
        this.writeReport(report, false);
      }
    }
    return report;
  }

  /** Clean and create the output / screenshots directory tree. */
  private prepareOutputDir(): void {
    if (!this.outputDir) return;
    if (fs.existsSync(this.outputDir)) {
      fs.rmSync(this.outputDir, { recursive: true, force: true });
    }
    fs.mkdirSync(this.outputDir, { recursive: true });
    fs.mkdirSync(this.screenshotDir!, { recursive: true });
    console.log(`📂 Output → ${this.outputDir}`);
  }

  /** Execute every step in the plan, appending results in place. */
  private async runSteps(results: StepResult[]): Promise<void> {
    for (const step of this.plan.steps) {
      const result = await this.executeStepWithRetries(step);
      results.push(result);

      const icon = result.status === "pass" ? "✅" : result.status === "fail" ? "❌" : "⏭️";
      console.log(`${icon} [${result.stepId}] ${result.action} (${result.duration}ms)`);
      if (result.reason) {
        console.log(`   → ${result.reason}`);
      }
    }
  }

  /**
   * Run a step, retrying on fail/error up to `step.retries` extra attempts.
   * Final result reflects the last attempt; `reason` includes attempt count
   * when retried so flake is visible in reports.
   */
  private async executeStepWithRetries(step: TestStep): Promise<StepResult> {
    const maxAttempts = 1 + Math.max(0, step.retries ?? 0);
    const attempts: StepAttemptResult[] = [];
    let last: StepResult | undefined;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const result = await this.executeStep(step);
      if (this.analysisMode !== "legacy") {
        attempts.push({
          attempt,
          status: result.status,
          reason: result.reason,
          duration: result.duration,
          screenshot: result.screenshot,
          llmVerification: result.llmVerification,
          evidence: result.evidence,
        });
      }
      if (result.status === "pass" || result.status === "skip") {
        if (attempt > 1) {
          console.log(`   ↻ [${step.id}] passed on attempt ${attempt}/${maxAttempts}`);
        }
        if (this.analysisMode !== "legacy") {
          result.attempts = attempts;
        }
        return result;
      }
      last = result;
      if (attempt < maxAttempts) {
        console.log(`   ↻ [${step.id}] ${result.status} on attempt ${attempt}/${maxAttempts}; retrying...`);
      }
    }
    if (last && maxAttempts > 1) {
      last.reason = `${last.reason ?? "step failed"} (after ${maxAttempts} attempts)`;
    }
    if (last && this.analysisMode !== "legacy") {
      last.attempts = attempts;
    }
    return last!;
  }

  /** Aggregate per-step results into the summary structure. */
  private summarize(results: StepResult[]): TestReport["summary"] {
    return {
      total: results.length,
      passed: results.filter((r) => r.status === "pass").length,
      failed: results.filter((r) => r.status === "fail").length,
      skipped: results.filter((r) => r.status === "skip").length,
      errors: results.filter((r) => r.status === "error").length,
    };
  }

  /** Preserve the pre-case-analysis screenshot failure analysis path. */
  private async analyzeFailedStepsLegacy(results: StepResult[]): Promise<void> {
    if (!this.llm?.isConfigured() || !this.screenshotDir) return;
    const failing = results.filter((r) => r.status === "fail" || r.status === "error");
    if (failing.length === 0) return;

    console.log(`\n🤖 Analyzing ${failing.length} failed step(s) with LLM...`);
    for (const result of failing) {
      await this.analyzeFailureLegacy(result);
    }
  }

  /** Persist `results.json` next to the screenshots directory. */
  private writeReport(report: TestReport, announce = true): void {
    if (!this.outputDir) return;
    const reportPath = path.join(this.outputDir, "results.json");
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    if (announce) {
      console.log(`📄 Report → ${reportPath}`);
    }
  }

  private appendAnalysisError(report: TestReport, message: string): void {
    if (!report.analysis) return;
    report.analysis.error = report.analysis.error
      ? `${report.analysis.error}; ${message}`
      : message;
  }

  private async executeStep(step: TestStep): Promise<StepResult> {
    const start = Date.now();
    let beforePath: string | undefined;

    try {
      if (step.waitBefore) {
        await this.driver.wait(step.waitBefore);
      }

      beforePath = await this.takeScreenshot(step.id, "before");

      // Install a sub-screenshot sink so compound driver operations
      // (e.g. clickViewTitleAction, contextMenuOnTreeItem) can capture
      // intermediate UI states (menu opened, item focused, ...) between
      // the per-step `before` and `after` snapshots. Files are written
      // with the same global counter so chronological order = correct
      // visual order, and the runner's own before/after files keep their
      // canonical names for the LLM verifier (which references them by
      // explicit path, not by dir scan).
      let subCounter = 0;
      const previousSink = this.driver.setSubScreenshotSink(async (label: string) => {
        if (!this.screenshotDir) return;
        subCounter += 1;
        const seq = String(++this.screenshotCounter).padStart(2, "0");
        const subN = String(subCounter).padStart(2, "0");
        const safeLabel = label.replace(/[^a-z0-9-]+/gi, "-").replace(/^-+|-+$/g, "") || "step";
        const fileName = `${seq}_${step.id}_sub_${subN}_${safeLabel}.png`;
        const filePath = path.join(this.screenshotDir, fileName);
        await this.driver.screenshot(filePath);
      });

      let afterPath: string | undefined;
      try {
        // Delegate action execution to ActionResolver
        await this.actionResolver.resolve(step.action);
        afterPath = await this.takeScreenshot(step.id, "after");
      } finally {
        this.driver.setSubScreenshotSink(previousSink);
      }

      // Delegate verification to StepVerifier (deterministic only)
      const verifyResult = await this.verifier.verify(step);

      let status: StepResult["status"] = verifyResult.passed ? "pass" : "fail";
      let reason = verifyResult.reason;
      let llmVerification: StepResult["llmVerification"];

      // LLM-authoritative re-check: a deterministic pass on `verify:` text
      // can mask a silent-pass (action did nothing but the verify text leaks
      // from prior state, the structured verifier matched stale text in a
      // hidden tab, or a UI element wasn't actually rendered). Ask the LLM
      // to inspect before/after screenshots and downgrade pass→fail when
      // confident the action did not produce the expected outcome. Never
      // upgrades fail → pass.
      //
      // The LLM re-check is skipped only when `step.skipLlmVerify` is set
      // explicitly — for steps whose action *is* the authoritative check
      // (e.g. waitForLanguageServer) or steps that are by-design invisible
      // (e.g. insertLineInFile / saveFile to a file that isn't open in any
      // editor, where before/after screenshots are necessarily identical
      // and the deterministic verifyFile / verifyProblems is the only
      // meaningful signal).
      if (
        status === "pass" &&
        step.verify &&
        !step.skipLlmVerify &&
        beforePath &&
        afterPath &&
        this.llm?.isConfigured()
      ) {
        const llmResult = await this.runLlmVerification(step, beforePath, afterPath);
        if (llmResult) {
          llmVerification = llmResult;
          if (!llmResult.passed && llmResult.confidence >= 0.6) {
            status = "fail";
            reason = `[LLM] ${llmResult.reasoning}${llmResult.suggestion ? ` 💡 ${llmResult.suggestion}` : ""}`;
            console.log(`   🤖 [${step.id}] LLM downgraded pass → fail (confidence ${llmResult.confidence.toFixed(2)}): ${llmResult.reasoning}`);
          } else {
            console.log(`   🤖 [${step.id}] LLM verified — ${llmResult.reasoning}`);
          }
        }
      }

      const evidence = status === "pass" || !this.evidenceCollector
        ? undefined
        : await this.captureFailureEvidence(step.id);
      return {
        stepId: step.id,
        action: step.action,
        status,
        reason,
        duration: Date.now() - start,
        screenshot: afterPath,
        ...(this.analysisMode !== "legacy" && llmVerification
          ? { llmVerification }
          : {}),
        ...(evidence ? { evidence } : {}),
      };
    } catch (e) {
      const errorPath = await this.takeScreenshot(step.id, "error");
      const evidence = this.evidenceCollector
        ? await this.captureFailureEvidence(step.id)
        : undefined;

      return {
        stepId: step.id,
        action: step.action,
        status: "error",
        reason: (e as Error).message,
        duration: Date.now() - start,
        screenshot: errorPath,
        ...(evidence ? { evidence } : {}),
      };
    }
  }

  /**
   * Best-effort LLM screenshot verification. Returns null when the call fails
   * so we keep the deterministic verdict rather than turning a transient LLM
   * outage into a test failure.
   */
  private async runLlmVerification(
    step: TestStep,
    beforePath: string,
    afterPath: string,
  ): Promise<{ passed: boolean; reasoning: string; confidence: number; suggestion?: string } | null> {
    if (!this.llm) return null;
    try {
      const beforeBase64 = fs.readFileSync(beforePath).toString("base64");
      const afterBase64 = fs.readFileSync(afterPath).toString("base64");
      return await this.llm.verifyStep(beforeBase64, afterBase64, step.action, step.verify ?? "");
    } catch (e) {
      console.log(`   🤖 ⚠️ [${step.id}] LLM verification error (keeping deterministic pass): ${(e as Error).message}`);
      return null;
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

  private async captureFailureEvidence(stepId: string): Promise<StepResult["evidence"] | undefined> {
    if (!this.evidenceCollector) return undefined;
    try {
      return await this.evidenceCollector.captureFailureEvidence(stepId);
    } catch (e) {
      console.warn(`⚠️  [${stepId}] Could not collect failure evidence: ${(e as Error).message}`);
      return undefined;
    }
  }

  private async analyzeFailureLegacy(result: StepResult): Promise<void> {
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

  private collectCaseScreenshots(results: StepResult[]): CaseScreenshot[] {
    if (!this.screenshotDir || !fs.existsSync(this.screenshotDir)) return [];

    const files = fs.readdirSync(this.screenshotDir)
      .filter((fileName) => fileName.endsWith(".png"))
      .sort();
    const selected = new Set<string>();
    const failing = results.filter((result) =>
      result.status === "fail" || result.status === "error"
    );
    const addStepScreenshot = (
      stepId: string,
      phases: Array<"before" | "after" | "error">,
    ): void => {
      for (const phase of phases) {
        const fileName = files.find((candidate) =>
          candidate.includes(`_${stepId}_${phase}.png`)
        );
        if (fileName) {
          selected.add(fileName);
          return;
        }
      }
    };

    if (failing.length > 0) {
      addStepScreenshot(failing[0]!.stepId, ["before"]);
      const firstFailureSubScreenshot = files
        .filter((candidate) => candidate.includes(`_${failing[0]!.stepId}_sub_`))
        .at(-1);
      if (firstFailureSubScreenshot) {
        selected.add(firstFailureSubScreenshot);
      }
      addStepScreenshot(failing[0]!.stepId, ["after", "error"]);
      addStepScreenshot(failing[failing.length - 1]!.stepId, ["after", "error"]);
      const finalStep = results[results.length - 1];
      if (finalStep) addStepScreenshot(finalStep.stepId, ["after", "error"]);
    } else if (files.length > 0) {
      selected.add(files[0]!);
      selected.add(files[Math.floor(files.length / 2)]!);
      selected.add(files[files.length - 1]!);
    }

    const screenshots: CaseScreenshot[] = [];
    for (const fileName of [...selected].slice(0, 4)) {
      try {
        screenshots.push({
          label: fileName,
          base64: fs.readFileSync(path.join(this.screenshotDir, fileName)).toString("base64"),
        });
      } catch (e) {
        console.warn(
          `⚠️  Could not read case-analysis screenshot ${fileName}: ${(e as Error).message}`,
        );
      }
    }
    return screenshots;
  }

  private writeCaseAnalysis(analysis: CaseAnalysis): string | undefined {
    if (!this.outputDir) return undefined;
    try {
      const analysisDir = path.join(this.outputDir, "analysis");
      fs.mkdirSync(analysisDir, { recursive: true });
      const analysisPath = path.join(analysisDir, "case-analysis.json");
      fs.writeFileSync(analysisPath, JSON.stringify(analysis, null, 2), "utf-8");
      return path.relative(this.outputDir, analysisPath).replaceAll("\\", "/");
    } catch (e) {
      console.warn(`⚠️  Could not persist case analysis: ${(e as Error).message}`);
      return undefined;
    }
  }

  private readEvidenceManifest(
    relativePath: string | undefined,
  ): EvidenceBundleManifest | undefined {
    if (!this.outputDir || !relativePath) return undefined;
    try {
      const manifestPath = path.join(this.outputDir, relativePath);
      return JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as EvidenceBundleManifest;
    } catch (e) {
      console.warn(`⚠️  Could not read evidence manifest: ${(e as Error).message}`);
      return undefined;
    }
  }
}
