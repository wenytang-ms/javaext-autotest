#!/usr/bin/env node
/**
 * AutoTest CLI — AI-driven VSCode extension E2E testing tool.
 *
 * Usage:
 *   autotest run <test-plan.yaml>        Execute a test plan
 *   autotest validate <test-plan.yaml>   Validate test plan format
 */

import { Command } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadTestPlan, validateTestPlanFile } from "../operators/planParser.js";
import { TestRunner } from "../operators/testRunner.js";

const program = new Command();

program
  .name("autotest")
  .description("AI-driven VSCode extension E2E testing framework")
  .version("0.1.0");

program
  .command("run <plan>")
  .description("Execute a test plan against VSCode")
  .option("--attach <port>", "Connect to an existing VSCode via CDP port")
  .option("--interactive", "Step-by-step execution with manual confirmation")
  .option("--output <dir>", "Output directory (default: ./test-results/<plan-name>)")
  .option("--no-llm", "Skip LLM verification (auto-pass all verify fields)")
  .action(async (planPath: string, opts: { attach?: string; interactive?: boolean; output?: string; llm?: boolean }) => {
    try {
      const plan = loadTestPlan(planPath);
      console.log(`📋 Test Plan: ${plan.name}`);
      console.log(`   Extension: ${plan.setup.extension}`);
      console.log(`   Steps: ${plan.steps.length}`);

      // Derive output dir from plan file name: test-results/<plan-name>/
      const planName = path.basename(planPath, path.extname(planPath));
      const outputDir = opts.output
        ? path.resolve(opts.output)
        : path.resolve("test-results", planName);

      const runner = new TestRunner(plan, { outputDir, noLLM: opts.llm === false });

      // Ensure VSCode is closed even if the process is interrupted (Ctrl+C)
      const cleanup = async () => {
        console.log("\n🛑 Interrupted — closing VSCode...");
        await runner.cleanup();
        process.exit(130);
      };
      process.on("SIGINT", cleanup);
      process.on("SIGTERM", cleanup);

      const report = await runner.run();

      // Exit code based on results
      const hasFailures = report.summary.failed + report.summary.errors > 0;
      process.exit(report.crashed || hasFailures ? 1 : 0);
    } catch (e) {
      console.error(`❌ Error: ${(e as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("run-all <dir>")
  .description("Run all test plans in a directory and generate an aggregate summary")
  .option("--output <dir>", "Output directory (default: ./test-results)")
  .option("--no-llm", "Skip LLM analysis")
  .option("--exclude <plans>", "Comma-separated plan names to exclude", "java-fresh-import")
  .action(async (dir: string, opts: { output?: string; llm?: boolean; exclude?: string }) => {
    const { LLMClient } = await import("../operators/llmClient.js");
    const planFiles = fs.readdirSync(dir)
      .filter(f => f.endsWith(".yaml") || f.endsWith(".yml"))
      .sort();

    const excludeSet = new Set((opts.exclude ?? "").split(",").map(s => s.trim()));
    const filteredPlans = planFiles.filter(f => {
      const name = path.basename(f, path.extname(f));
      return !excludeSet.has(name);
    });

    console.log(`📋 Found ${filteredPlans.length} test plan(s) in ${dir}\n`);

    const outputBase = opts.output ? path.resolve(opts.output) : path.resolve("test-results");
    const reports: Array<any> = [];
    const failed: string[] = [];

    for (const planFile of filteredPlans) {
      const planPath = path.join(dir, planFile);
      const planName = path.basename(planFile, path.extname(planFile));
      console.log(`\n${"=".repeat(60)}`);
      console.log(`  ${planFile}`);
      console.log(`${"=".repeat(60)}`);

      try {
        const plan = loadTestPlan(planPath);
        const outputDir = path.join(outputBase, planName);
        const runner = new TestRunner(plan, { outputDir, noLLM: opts.llm === false });

        const cleanup = async () => {
          await runner.cleanup();
          process.exit(130);
        };
        process.removeAllListeners("SIGINT");
        process.removeAllListeners("SIGTERM");
        process.on("SIGINT", cleanup);
        process.on("SIGTERM", cleanup);

        const report = await runner.run();
        reports.push(report);

        if (report.crashed || report.summary.failed + report.summary.errors > 0) {
          failed.push(planName);
        }
      } catch (e) {
        console.error(`❌ Error loading ${planFile}: ${(e as Error).message}`);
        reports.push({
          planName: planName,
          duration: 0,
          crashed: true,
          crashReason: (e as Error).message,
          results: [],
          summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0 },
        });
        failed.push(planName);
      }
    }

    // Print aggregate summary
    console.log(`\n${"=".repeat(60)}`);
    console.log("  AGGREGATE SUMMARY");
    console.log(`${"=".repeat(60)}`);
    const totalPlans = reports.length;
    const passedPlans = reports.filter((r: any) => !r.crashed && r.summary.failed + r.summary.errors === 0).length;
    const crashedPlans = reports.filter((r: any) => r.crashed).length;
    const failedPlans = totalPlans - passedPlans - crashedPlans;

    for (const r of reports) {
      const icon = r.crashed ? "💥" : r.summary.failed + r.summary.errors > 0 ? "❌" : "✅";
      const status = r.crashed ? "CRASH" : `${r.summary.passed}/${r.summary.total}`;
      console.log(`  ${icon} ${r.planName}: ${status}`);
    }
    console.log(`\n  Total: ${totalPlans} | ✅ ${passedPlans} | ❌ ${failedPlans} | 💥 ${crashedPlans}`);

    // LLM aggregate analysis
    if (opts.llm !== false && (failedPlans + crashedPlans) > 0) {
      const llm = new LLMClient();
      if (llm.isConfigured()) {
        console.log(`\n🤖 Generating LLM analysis...`);
        const analysisInput = reports.map((r: any) => ({
          planName: r.planName,
          duration: r.duration,
          crashed: r.crashed,
          crashReason: r.crashReason,
          summary: r.summary,
          failedSteps: r.results
            ?.filter((s: any) => s.status === "fail" || s.status === "error")
            .map((s: any) => ({ stepId: s.stepId, action: s.action, reason: s.reason })),
        }));
        const analysis = await llm.summarizeResults(analysisInput);
        console.log(`\n📝 LLM Analysis:\n${analysis}`);

        // Save analysis to file
        const analysisPath = path.join(outputBase, "summary.txt");
        fs.writeFileSync(analysisPath, analysis);
        console.log(`📄 Analysis saved → ${analysisPath}`);
      }
    }

    process.exit(failed.length > 0 ? 1 : 0);
  });

program
  .command("validate <plan>")
  .description("Validate a test plan YAML file")
  .action((planPath: string) => {
    const result = validateTestPlanFile(planPath);
    if (result.valid) {
      console.log(`✅ Test plan is valid: ${planPath}`);
    } else {
      console.error(`❌ Invalid test plan: ${planPath}`);
      result.errors.forEach((e) => console.error(`   - ${e}`));
      process.exit(1);
    }
  });

program.parse();
