import { stripVTControlCharacters } from "node:util";
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

interface SummaryCase {
  reference: string;
  label: string;
  report: TestReport;
}

function escapeHtml(value: string): string {
  return stripVTControlCharacters(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function markdownText(value: string): string {
  return escapeHtml(value).replace(/([\\`*_[\]|])/g, "\\$1").replace(/\r?\n/g, "<br>");
}

function failedCase(report: TestReport): boolean {
  return !!report.crashed || report.summary.failed + report.summary.errors > 0;
}

function renderCaseEvidence(entry: SummaryCase): string[] {
  const { report, label, reference } = entry;
  const analysis = report.analysis?.case;
  if (!analysis) {
    return [
      "",
      `<a id="${reference}"></a>`,
      `#### ${markdownText(label)}`,
      "",
      `**Runner verdict:** ${failedCase(report) ? "failed" : "passed"}`,
      "",
      "**Case analysis unavailable.**",
      `<pre>${escapeHtml(report.analysis?.error || "No saved case analysis was found in this report.")}</pre>`,
    ];
  }

  const observedSteps = new Set(report.results.map((step) => step.stepId));
  const stepReference = (stepId: string) =>
    `<code>${escapeHtml(stepId)}</code>${observedSteps.has(stepId) ? "" : " (not present in recorded execution)"}`;
  const lines = [
    "",
    `<a id="${reference}"></a>`,
    `#### ${markdownText(label)}`,
    "",
    `**Runner verdict:** ${failedCase(report) ? "failed" : "passed"} · **AI assessment:** ${analysis.assessment}`,
    "",
    `**Saved case analysis (AI):** ${markdownText(analysis.summary)}`,
    "",
    `**Model-reported confidence (not calibrated):** ${analysis.confidence}`,
    "",
    `**Earliest divergence reported by AI:** ${analysis.earliestDivergence.stepId ? `${stepReference(analysis.earliestDivergence.stepId)} — ` : ""}${markdownText(analysis.earliestDivergence.observation)}`,
  ];
  for (const [index, cause] of analysis.rootCauses.entries()) {
    lines.push(
      "",
      `**Hypothesis ${index + 1}:** ${markdownText(cause.summary)}`,
      "",
      `- Suspected component: ${markdownText(cause.suspectedComponent)}`,
      `- Reported fingerprint: <code>${escapeHtml(cause.fingerprint)}</code>`,
      `- Model-reported confidence (not calibrated): ${cause.confidence}`,
      `- Direct failures (AI mapping): ${cause.directFailureSteps.map(stepReference).join(", ") || "Not identified"}`,
      `- Cascading failures (AI mapping): ${cause.cascadingFailureSteps.map(stepReference).join(", ") || "None identified"}`,
      "",
      "**Evidence cited by the case model:**",
    );
    if (cause.evidence.length === 0) {
      lines.push("No supporting citations were recorded for this hypothesis.");
    }
    for (const citation of cause.evidence) {
      lines.push(
        `- <code>${escapeHtml(citation.artifact)}</code>${citation.location ? ` at <code>${escapeHtml(citation.location)}</code>` : ""}: ${markdownText(citation.observation)}`,
      );
    }
    if (cause.recommendations.length > 0) {
      lines.push("", "**Suggested confirming actions:**");
      lines.push(...cause.recommendations.map((action) => `- ${markdownText(action)}`));
    }
  }
  if (analysis.falsePassRisks.length > 0) {
    lines.push("", "**Audit warnings, not confirmed failures:**");
    lines.push(...analysis.falsePassRisks.map((risk) => `- ${markdownText(risk)}`));
  }
  if (analysis.evidenceGaps.length > 0) {
    lines.push("", "**Evidence gaps reported by the case model:**");
    lines.push(...analysis.evidenceGaps.map((gap) => `- ${markdownText(gap)}`));
  }
  const snapshots = report.results.flatMap(({ stepId, evidence }) => evidence ? [{ stepId, evidence }] : []);
  if (snapshots.length > 0) {
    lines.push("", "<details>", "<summary>Recorded diagnostic snapshots</summary>");
    for (const { stepId, evidence } of snapshots) {
      lines.push(
        "",
        `**Recorded diagnostic snapshot at ${stepReference(stepId)}:**`,
        "",
        `Problem counts: ${evidence.problemCounts?.errors ?? "not recorded"} errors, ${evidence.problemCounts?.warnings ?? "not recorded"} warnings; ${evidence.diagnostics.length} diagnostic message(s) captured.`,
      );
      for (const diagnostic of evidence.diagnostics) {
        lines.push(
          `- ${markdownText(diagnostic.severity)}${diagnostic.source ? ` (${markdownText(diagnostic.source)})` : ""}${diagnostic.file ? ` in <code>${escapeHtml(diagnostic.file)}</code>` : ""}: ${markdownText(diagnostic.message)}`,
        );
      }
      if (evidence.collectionErrors?.length) {
        lines.push("", "**Evidence collection errors:**", ...evidence.collectionErrors.map((error) => `- ${markdownText(error)}`));
      }
    }
    lines.push("", "</details>");
  }
  for (const [name, value] of [
    ["Case analysis", report.analysis?.caseAnalysisPath],
    ["Evidence manifest", report.analysis?.evidenceManifest],
  ]) {
    if (value) lines.push("", `${name} within this case's artifact: <code>${escapeHtml(value)}</code>`);
  }
  if (report.analysis?.error) {
    lines.push("", "**Additional analysis error:**", `<pre>${escapeHtml(report.analysis.error)}</pre>`);
  }
  return lines;
}

function renderCaseSection(title: string, cases: SummaryCase[], expand: boolean): string[] {
  if (cases.length === 0) return [];
  return [
    "",
    `<details${expand ? " open" : ""}>`,
    `<summary>${escapeHtml(title)} (${cases.length})</summary>`,
    "",
    ...cases.flatMap(renderCaseEvidence),
    "",
    "</details>",
  ];
}

function renderEvidenceDetails(cases: SummaryCase[], summary: CaseSummaryResult): string[] {
  const failed = cases.filter(({ report }) => failedCase(report));
  const passed = cases.filter(({ report }) => !failedCase(report));
  const analyzed = cases.filter(({ report }) => report.analysis?.case);
  const failureAnalyses = failed.filter(({ report }) => report.analysis?.case);
  const warnings = passed.filter(({ report }) =>
    report.analysis?.case && report.analysis.case.assessment !== "confirmed-pass"
  );
  const otherAnalyses = passed.filter(({ report }) => report.analysis?.case?.assessment === "confirmed-pass");
  const missing = cases.filter(({ report }) => !report.analysis?.case);
  const lines = [
    "",
    "### Analysis coverage",
    "",
    "| Coverage | Cases |",
    "|----------|-------|",
    `| Saved case analyses | ${analyzed.length}/${cases.length} |`,
    `| Failed cases with analysis | ${failureAnalyses.length}/${failed.length} |`,
    `| Passing cases with an audit | ${passed.filter(({ report }) => report.analysis?.case).length}/${passed.length} |`,
    `| Suspected false passes (AI warnings) | ${passed.filter(({ report }) => report.analysis?.case?.assessment === "suspected-false-pass").length} |`,
    `| Cases without analysis | ${missing.length} |`,
    "",
    "AI diagnoses, assessments, and confidence are model opinions, not independently confirmed facts. Audit warnings do not change runner verdicts.",
  ];
  if (summary.kind === "complete") {
    lines.push("", "### Cross-case synthesis (AI)", "", summary.analysis.details);
  } else {
    lines.push(
      "",
      "Cross-case synthesis is unavailable. Saved case analyses are shown independently below; no shared root cause is inferred from matching labels.",
    );
  }
  lines.push(
    ...renderCaseSection("Saved failure diagnoses and evidence", failureAnalyses, summary.kind === "unavailable"),
    ...renderCaseSection("Passing-case audit warnings and inconclusive assessments", warnings, summary.kind === "unavailable"),
    ...renderCaseSection("Other saved pass audits", otherAnalyses, false),
  );
  if (missing.length > 0) {
    lines.push("", "### Cases without analysis", ...missing.flatMap(renderCaseEvidence));
  }
  return lines;
}

function renderRawFailures(cases: SummaryCase[]): string[] {
  const failures = cases.filter(({ report }) => failedCase(report));
  if (failures.length === 0) return [];
  const lines = [
    "",
    "<details>",
    "<summary>Raw execution failures (complete recorded reasons)</summary>",
    "",
    "### Failed Steps",
  ];
  for (const entry of failures) {
    for (const step of entry.report.results.filter((step) => step.status === "fail" || step.status === "error")) {
      lines.push(
        "",
        `**${markdownText(entry.label)}** → <code>${escapeHtml(step.stepId)}</code>`,
        "",
        `Action: <code>${escapeHtml(step.action)}</code>`,
        "",
        `<pre>${escapeHtml(step.reason || "No failure reason was recorded.")}</pre>`,
      );
    }
  }
  if (failures.some(({ report }) => report.crashed)) {
    lines.push("", "### Crashes");
    for (const { report, label } of failures.filter(({ report }) => report.crashed)) {
      lines.push("", `**${markdownText(label)}**`, "", `<pre>${escapeHtml(report.crashReason || "No crash reason was recorded.")}</pre>`);
    }
  }
  lines.push("", "</details>");
  return lines;
}

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
  const cases = reports.map((report, index): SummaryCase => {
    const platform = report.evidence?.environment.runnerOs ?? report.evidence?.environment.platform;
    return {
      reference: `case-${index + 1}`,
      label: platform ? `${report.planName} [${platform}]` : report.planName,
      report,
    };
  });

  const overviewLines = [
    "## E2E Test Results",
    "",
    "| Status | Test Plan | Steps | Duration |",
    "|--------|-----------|-------|----------|",
  ];
  for (const entry of cases) {
    const r = entry.report;
    const icon = r.crashed ? "💥" : r.summary.failed + r.summary.errors > 0 ? "❌" : "✅";
    const status = r.crashed ? "CRASH" : `${r.summary.passed}/${r.summary.total}`;
    const dur = `${(r.duration / 1000).toFixed(1)}s`;
    const name = mode === "case" ? `[${markdownText(entry.label)}](#${entry.reference})` : r.planName;
    overviewLines.push(`| ${icon} | ${name} | ${status} | ${dur} |`);
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
        : `**AI analysis unavailable:** ${markdownText(caseSummary.reason)}`,
      "",
      ...overviewLines,
      "",
      "## Detailed Analysis",
    ];
    mdLines.push(...renderEvidenceDetails(cases, caseSummary), ...renderRawFailures(cases));
    if (caseSummary.kind === "unavailable" && failed.length === 0) {
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
