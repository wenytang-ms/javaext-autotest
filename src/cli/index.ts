#!/usr/bin/env node
/**
 * AutoTest CLI — AI-driven VSCode extension E2E testing tool.
 *
 * Usage:
 *   autotest run <test-plan.yaml>        Execute a test plan
 *   autotest validate <test-plan.yaml>   Validate test plan format
 */

import { Command, Option } from "commander";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadTestPlan, validateTestPlanFile } from "../operators/planParser.js";
import { TestRunner } from "../operators/testRunner.js";
import type { AnalysisMode } from "../types.js";
import { generateSummary } from "./summary.js";

/**
 * Minimal .env loader (no external dependency).
 * Looks for a `.env` file in the current working directory and any directory
 * passed via AUTOTEST_ENV_DIR or `--env-file`. Existing `process.env` entries
 * are NOT overridden so the shell env still wins.
 *
 * Supported syntax: KEY=value, KEY="value", KEY='value'. Lines starting with
 * `#` and blank lines are ignored. Inline `#` comments after an unquoted value
 * are stripped.
 */
function loadDotEnv(envPath: string): boolean {
  if (!fs.existsSync(envPath)) return false;
  let content: string;
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    return false;
  }
  let count = 0;
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 1) continue;
    const key = line.substring(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.substring(eq + 1).trim();
    // Strip surrounding quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.substring(1, value.length - 1);
    } else {
      // Strip inline comments only for unquoted values
      const hashIdx = value.indexOf(" #");
      if (hashIdx >= 0) value = value.substring(0, hashIdx).trim();
    }
    if (!(key in process.env)) {
      process.env[key] = value;
      count++;
    }
  }
  if (count > 0) {
    console.log(`🔑 Loaded ${count} env var(s) from ${envPath}`);
  }
  return count > 0;
}

// Auto-load .env from CWD at CLI startup (before any subcommand runs).
loadDotEnv(path.resolve(process.cwd(), ".env"));

const packageMetadata = JSON.parse(
  fs.readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as { version: string };

const program = new Command();

function analysisModeOption(): Option {
  return new Option(
    "--analysis-mode <mode>",
    "Analysis pipeline: legacy, case, or evidence-only",
  )
    .choices(["legacy", "case", "evidence-only"])
    .default("legacy");
}

program
  .name("autotest")
  .description("AI-driven VSCode extension E2E testing framework")
  .version(packageMetadata.version);

program
  .command("run <plan>")
  .description("Execute a test plan against VSCode")
  .option("--attach <port>", "Connect to an existing VSCode via CDP port")
  .option("--interactive", "Step-by-step execution with manual confirmation")
  .option("--output <dir>", "Output directory (default: ./test-results/<plan-name>)")
  .option("--no-llm", "Skip LLM verification (auto-pass all verify fields)")
  .addOption(analysisModeOption())
  .option("--vsix <paths>", "Comma-separated VSIX file paths to install (overrides marketplace versions)")
  .option("--pre-release", "Install pre-release versions of marketplace extensions (default: stable)")
  .option("--override <kv...>", "Override setup fields (e.g. --override extensionPath=../../vscode-java extension=redhat.java)")
  .action(async (planPath: string, opts: { attach?: string; interactive?: boolean; output?: string; llm?: boolean; analysisMode: AnalysisMode; vsix?: string; preRelease?: boolean; override?: string[] }) => {
    try {
      const plan = loadTestPlan(planPath);

      // Apply --pre-release flag
      if (opts.preRelease) {
        plan.setup.preRelease = true;
      }

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

      const runner = new TestRunner(plan, {
        outputDir,
        noLLM: opts.llm === false,
        analysisMode: opts.analysisMode,
      });

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
  .addOption(analysisModeOption())
  .option("--exclude <plans>", "Comma-separated plan names to exclude", "java-fresh-import")
  .option("--vsix <paths>", "Comma-separated VSIX file paths to install for all plans")
  .option("--pre-release", "Install pre-release versions of marketplace extensions (default: stable)")
  .option("--override <kv...>", "Override setup fields for all plans (e.g. --override extensionPath=../../vscode-java)")
  .action(async (dir: string, opts: { output?: string; llm?: boolean; analysisMode: AnalysisMode; exclude?: string; vsix?: string; preRelease?: boolean; override?: string[] }) => {
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

        // Apply --pre-release flag
        if (opts.preRelease) {
          plan.setup.preRelease = true;
        }

        // Apply --vsix to each plan
        if (opts.vsix) {
          const vsixPaths = opts.vsix.split(",").map(p => p.trim()).filter(Boolean);
          plan.setup.vsix = [...(plan.setup.vsix ?? []), ...vsixPaths];
        }

        // Apply --override key=value pairs to each plan
        if (opts.override) {
          for (const kv of opts.override) {
            const eqIdx = kv.indexOf("=");
            if (eqIdx < 1) continue;
            const key = kv.substring(0, eqIdx);
            const value = kv.substring(eqIdx + 1);
            if (key in plan.setup) {
              const pathFields = ["extensionPath", "workspace", "file"];
              if (value === "") {
                (plan.setup as unknown as Record<string, unknown>)[key] = undefined;
              } else {
                (plan.setup as unknown as Record<string, unknown>)[key] = pathFields.includes(key)
                  ? path.resolve(value)
                  : value;
              }
            }
          }
        }

        const outputDir = path.join(outputBase, planName);
        const runner = new TestRunner(plan, {
          outputDir,
          noLLM: opts.llm === false,
          analysisMode: opts.analysisMode,
        });

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

    const { mdLines, failed: failedNames } = await generateSummary(reports, opts);

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
  .option("--report-only", "Write the summary without failing the command for failed cases")
  .addOption(analysisModeOption())
  .action(async (dir: string, opts: { output?: string; llm?: boolean; reportOnly?: boolean; analysisMode: AnalysisMode }) => {
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

    const { mdLines, failed } = await generateSummary(reports, opts);

    // Save summary.md
    fs.mkdirSync(outputBase, { recursive: true });
    const mdPath = path.join(outputBase, "summary.md");
    fs.writeFileSync(mdPath, mdLines.join("\n"));
    console.log(`📄 Summary → ${mdPath}`);

    process.exit(!opts.reportOnly && failed.length > 0 ? 1 : 0);
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
