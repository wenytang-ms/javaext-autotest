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
      process.exit(report.summary.failed + report.summary.errors > 0 ? 1 : 0);
    } catch (e) {
      console.error(`❌ Error: ${(e as Error).message}`);
      process.exit(1);
    }
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
