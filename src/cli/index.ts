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

/** Generate markdown summary from test reports */
function generateSummary(reports: Array<any>): {
  mdLines: string[];
  failed: string[];
  passedPlans: number;
  failedPlans: number;
  crashedPlans: number;
} {
  const totalPlans = reports.length;
  const passedPlans = reports.filter((r: any) => !r.crashed && r.summary.failed + r.summary.errors === 0).length;
  const crashedPlans = reports.filter((r: any) => r.crashed).length;
  const failedPlans = totalPlans - passedPlans - crashedPlans;
  const failed: string[] = [];

  const mdLines: string[] = [];
  mdLines.push(`## E2E Test Results`);
  mdLines.push(``);
  mdLines.push(`| Status | Test Plan | Steps | Duration |`);
  mdLines.push(`|--------|-----------|-------|----------|`);

  for (const r of reports) {
    const icon = r.crashed ? "💥" : r.summary.failed + r.summary.errors > 0 ? "❌" : "✅";
    const status = r.crashed ? "CRASH" : `${r.summary.passed}/${r.summary.total}`;
    const dur = `${(r.duration / 1000).toFixed(1)}s`;
    mdLines.push(`| ${icon} | ${r.planName} | ${status} | ${dur} |`);
    console.log(`  ${icon} ${r.planName}: ${status}`);
    if (r.crashed || r.summary.failed + r.summary.errors > 0) {
      failed.push(r.planName);
    }
  }

  mdLines.push(``);
  mdLines.push(`**Total: ${totalPlans}** — ✅ ${passedPlans} passed · ❌ ${failedPlans} failed · 💥 ${crashedPlans} crashed`);
  console.log(`\n  Total: ${totalPlans} | ✅ ${passedPlans} | ❌ ${failedPlans} | 💥 ${crashedPlans}`);

  // Failed step details
  const allFailedSteps = reports.flatMap((r: any) =>
    (r.results ?? [])
      .filter((s: any) => s.status === "fail" || s.status === "error")
      .map((s: any) => ({ plan: r.planName, ...s }))
  );
  if (allFailedSteps.length > 0) {
    mdLines.push(``);
    mdLines.push(`### Failed Steps`);
    mdLines.push(``);
    for (const s of allFailedSteps) {
      mdLines.push(`- **${s.plan}** → \`${s.stepId}\`: ${s.reason?.substring(0, 150) ?? "unknown"}`);
    }
  }

  // Crash details
  const crashedReports = reports.filter((r: any) => r.crashed);
  if (crashedReports.length > 0) {
    mdLines.push(``);
    mdLines.push(`### Crashes`);
    mdLines.push(``);
    for (const r of crashedReports) {
      mdLines.push(`- **${r.planName}**: ${r.crashReason ?? "VSCode exited before any steps could execute"}`);
    }
  }

  return { mdLines, failed, passedPlans, failedPlans, crashedPlans };
}

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
  .option("--vsix <paths>", "Comma-separated VSIX file paths to install (overrides marketplace versions)")
  .option("--override <kv...>", "Override setup fields (e.g. --override extensionPath=../../vscode-java extension=redhat.java)")
  .action(async (planPath: string, opts: { attach?: string; interactive?: boolean; output?: string; llm?: boolean; vsix?: string; override?: string[] }) => {
    try {
      const plan = loadTestPlan(planPath);

      // Apply --override key=value pairs to setup fields
      if (opts.override) {
        for (const kv of opts.override) {
          const eqIdx = kv.indexOf("=");
          if (eqIdx < 1) {
            console.error(`⚠️  Invalid override (expected key=value): ${kv}`);
            continue;
          }
          const key = kv.substring(0, eqIdx);
          const value = kv.substring(eqIdx + 1);
          if (key in plan.setup) {
            // Handle empty string as "unset" for optional fields
            if (value === "") {
              (plan.setup as unknown as Record<string, unknown>)[key] = undefined;
            } else {
              // Resolve path-like fields relative to cwd
              const pathFields = ["extensionPath", "workspace", "file"];
              (plan.setup as unknown as Record<string, unknown>)[key] = pathFields.includes(key)
                ? path.resolve(value)
                : value;
            }
            console.log(`   ⚙️  Override: setup.${key} = ${value || "(unset)"}`);
          } else {
            console.error(`⚠️  Unknown setup field: ${key}`);
          }
        }
      }

      // Append --vsix paths to plan's vsix list
      if (opts.vsix) {
        const vsixPaths = opts.vsix.split(",").map(p => p.trim()).filter(Boolean);
        plan.setup.vsix = [...(plan.setup.vsix ?? []), ...vsixPaths];
      }

      console.log(`📋 Test Plan: ${plan.name}`);
      console.log(`   Extension: ${plan.setup.extension}`);
      console.log(`   Steps: ${plan.steps.length}`);
      if (plan.setup.vsix?.length) {
        console.log(`   VSIX: ${plan.setup.vsix.join(", ")}`);
      }

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

    const { mdLines, failed: failedNames, failedPlans, crashedPlans } = generateSummary(reports);

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
        mdLines.push(``);
        mdLines.push(`### 🤖 AI Analysis`);
        mdLines.push(``);
        mdLines.push(analysis);
      }
    }

    // Save summary.md
    if (outputBase) {
      fs.mkdirSync(outputBase, { recursive: true });
      const mdPath = path.join(outputBase, "summary.md");
      fs.writeFileSync(mdPath, mdLines.join("\n"));
      console.log(`📄 Summary → ${mdPath}`);
    }

    process.exit(failedNames.length > 0 ? 1 : 0);
  });

program
  .command("analyze <dir>")
  .description("Analyze existing test results and generate aggregate summary with LLM")
  .option("--output <dir>", "Output directory for summary (default: same as input dir)")
  .option("--no-llm", "Skip LLM analysis")
  .action(async (dir: string, opts: { output?: string; llm?: boolean }) => {
    const { LLMClient } = await import("../operators/llmClient.js");
    const resolvedDir = path.resolve(dir);
    const outputBase = opts.output ? path.resolve(opts.output) : resolvedDir;

    // Scan for results.json in subdirectories
    const reports: Array<any> = [];
    const entries = fs.readdirSync(resolvedDir, { withFileTypes: true });
    for (const entry of entries.filter(e => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
      const jsonPath = path.join(resolvedDir, entry.name, "results.json");
      if (fs.existsSync(jsonPath)) {
        const report = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
        reports.push(report);
      }
    }

    if (reports.length === 0) {
      console.error(`❌ No results.json found in subdirectories of ${resolvedDir}`);
      process.exit(1);
    }

    console.log(`📋 Found ${reports.length} test result(s)\n`);

    const { mdLines, failed, passedPlans, failedPlans, crashedPlans } = generateSummary(reports);

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
        mdLines.push(``);
        mdLines.push(`### 🤖 AI Analysis`);
        mdLines.push(``);
        mdLines.push(analysis);
      }
    }

    // Save summary.md
    fs.mkdirSync(outputBase, { recursive: true });
    const mdPath = path.join(outputBase, "summary.md");
    fs.writeFileSync(mdPath, mdLines.join("\n"));
    console.log(`📄 Summary → ${mdPath}`);

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
