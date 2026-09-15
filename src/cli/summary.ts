import { LLMClient } from "../operators/llmClient.js";
import type { AggregateAnalysis, AnalysisMode, TestReport } from "../types.js";

interface SummaryOptions {
  llm?: boolean;
  analysisMode?: AnalysisMode;
}

interface GeneratedSummary {
  mdLines: string[];
  failed: string[];
  passedPlans: number;
  failedPlans: number;
  crashedPlans: number;
}

type SummaryClient = Pick<
  LLMClient,
  "isConfigured" | "summarizeResults" | "summarizeCaseResultsStructured"
>;

type CaseSummaryResult =
  | { kind: "complete"; analysis: AggregateAnalysis }
  | { kind: "unavailable"; reason: string };

export async function generateSummary(
  reports: TestReport[],
  options: SummaryOptions = {},
  llmClient?: SummaryClient,
): Promise<GeneratedSummary> {
  const mode = options.analysisMode ?? "legacy";
  const totalPlans = reports.length;
  const passedPlans = reports.filter((r) => !r.crashed && r.summary.failed + r.summary.errors === 0).length;
  const crashedPlans = reports.filter((r) => r.crashed).length;
  const failedPlans = totalPlans - passedPlans - crashedPlans;
  const failed: string[] = [];

  const overviewLines = [
    "## E2E Test Results",
    "",
    "| Status | Test Plan | Steps | Duration |",
    "|--------|-----------|-------|----------|",
  ];
  for (const r of reports) {
    const icon = r.crashed ? "💥" : r.summary.failed + r.summary.errors > 0 ? "❌" : "✅";
    const status = r.crashed ? "CRASH" : `${r.summary.passed}/${r.summary.total}`;
    const dur = `${(r.duration / 1000).toFixed(1)}s`;
    overviewLines.push(`| ${icon} | ${r.planName} | ${status} | ${dur} |`);
    console.log(`  ${icon} ${r.planName}: ${status}`);
    if (r.crashed || r.summary.failed + r.summary.errors > 0) {
      failed.push(r.planName);
    }
  }
  overviewLines.push(
    "",
    `**Total: ${totalPlans}** — ✅ ${passedPlans} passed · ❌ ${failedPlans} failed · 💥 ${crashedPlans} crashed`,
  );
  console.log(`\n  Total: ${totalPlans} | ✅ ${passedPlans} | ❌ ${failedPlans} | 💥 ${crashedPlans}`);

  const detailLines: string[] = [];
  const allFailedSteps = reports.flatMap((r) =>
    (r.results ?? [])
      .filter((s) => s.status === "fail" || s.status === "error")
      .map((s) => ({ plan: r.planName, ...s }))
  );
  if (allFailedSteps.length > 0) {
    detailLines.push("", "### Failed Steps", "");
    for (const s of allFailedSteps) {
      detailLines.push(`- **${s.plan}** → \`${s.stepId}\`: ${s.reason?.substring(0, 150) ?? "unknown"}`);
    }
  }
  const crashedReports = reports.filter((r) => r.crashed);
  if (crashedReports.length > 0) {
    detailLines.push("", "### Crashes", "");
    for (const r of crashedReports) {
      detailLines.push(`- **${r.planName}**: ${r.crashReason ?? "VSCode exited before any steps could execute"}`);
    }
  }

  let caseSummary: CaseSummaryResult = {
    kind: "unavailable",
    reason: options.llm === false
      ? "LLM analysis was disabled (--no-llm)."
      : "Azure OpenAI is not configured.",
  };
  let legacyAnalysis: string | undefined;
  if (
    options.llm !== false
    && mode !== "evidence-only"
    && (failedPlans + crashedPlans > 0 || mode === "case")
  ) {
    const llm = llmClient ?? new LLMClient();
    if (llm.isConfigured()) {
      console.log("\n🤖 Generating LLM analysis...");
      if (mode === "case") {
        try {
          const analysis = await llm.summarizeCaseResultsStructured(reports);
          caseSummary = { kind: "complete", analysis };
          console.log(`\n📝 LLM Analysis:\n${analysis.tldr}\n\n${analysis.details}`);
        } catch (error) {
          const reason = `LLM analysis failed: ${error instanceof Error ? error.message : String(error)}`;
          caseSummary = { kind: "unavailable", reason };
          console.warn(reason);
        }
      } else {
        legacyAnalysis = await llm.summarizeResults(reports.map((r) => ({
          planName: r.planName,
          duration: r.duration,
          crashed: r.crashed,
          crashReason: r.crashReason,
          summary: r.summary,
          failedSteps: r.results
            ?.filter((s) => s.status === "fail" || s.status === "error")
            .map((s) => ({ stepId: s.stepId, action: s.action, reason: s.reason })),
        })));
        console.log(`\n📝 LLM Analysis:\n${legacyAnalysis}`);
      }
    }
  }

  let mdLines: string[];
  if (mode === "case") {
    mdLines = [
      "## AI Analysis — TL;DR",
      "",
      caseSummary.kind === "complete"
        ? caseSummary.analysis.tldr
        : `**AI analysis unavailable:** ${caseSummary.reason}`,
      "",
      ...overviewLines,
      "",
      "## Detailed Analysis",
    ];
    if (caseSummary.kind === "complete") {
      mdLines.push("", caseSummary.analysis.details);
    }
    mdLines.push(...detailLines);
    if (caseSummary.kind === "unavailable" && detailLines.length === 0) {
      mdLines.push("", "No failed steps or crashes were recorded.");
    }
  } else {
    mdLines = [...overviewLines, ...detailLines];
    if (legacyAnalysis !== undefined) {
      mdLines.push("", "### 🤖 AI Analysis", "", legacyAnalysis);
    }
  }

  return { mdLines, failed, passedPlans, failedPlans, crashedPlans };
}
