import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/cli/summary.js";
import type { LLMClient } from "../src/operators/llmClient.js";
import type { CaseAnalysis, TestReport } from "../src/types.js";

beforeEach(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => vi.restoreAllMocks());

function report(planName: string, status: "pass" | "fail" = "pass"): TestReport {
  return {
    planName,
    startTime: "2026-09-15T00:00:00.000Z",
    endTime: "2026-09-15T00:00:01.000Z",
    duration: 1_000,
    results: [{
      stepId: "verify",
      action: "wait",
      status,
      reason: status === "fail" ? "Expected runtime to be ready" : "Runtime is ready",
      duration: 1_000,
    }],
    summary: {
      total: 1,
      passed: status === "pass" ? 1 : 0,
      failed: status === "fail" ? 1 : 0,
      errors: 0,
      skipped: 0,
    },
  };
}

function client() {
  return {
    isConfigured: vi.fn<LLMClient["isConfigured"]>().mockReturnValue(true),
    summarizeResults: vi.fn<LLMClient["summarizeResults"]>().mockResolvedValue("Legacy diagnosis"),
    summarizeCaseResultsStructured: vi.fn<LLMClient["summarizeCaseResultsStructured"]>().mockResolvedValue({
      tldr: "- Investigate runtime initialization first.",
      details: "#### Shared cause\nRuntime initialization explains the dependent failures.",
    }),
  };
}

function withAnalysis(r: TestReport, assessment?: CaseAnalysis["assessment"]): TestReport {
  const failed = r.summary.failed + r.summary.errors > 0 || r.crashed;
  return {
    ...r,
    analysis: {
      schemaVersion: 1,
      mode: "case",
      evidenceManifest: "evidence/manifest.json",
      caseAnalysisPath: "analysis/case-analysis.json",
      case: {
        schemaVersion: 1,
        kind: failed ? "failure-root-cause" : "pass-audit",
        assessment: assessment ?? (failed ? "confirmed-failure" : "confirmed-pass"),
        summary: failed ? "Parser initialization may explain the failure." : "Review the recorded final-state evidence.",
        earliestDivergence: { stepId: "verify", observation: "Inspect the first runtime verification." },
        rootCauses: failed ? [{
          fingerprint: "parser-initialization",
          summary: "A parser component may be incompatible.",
          suspectedComponent: "runtime parser",
          directFailureSteps: ["verify"],
          cascadingFailureSteps: ["finish"],
          evidence: [{
            artifact: "evidence/logs/runtime.log",
            location: "line 12",
            observation: "Runtime could not load Parser.v2.",
          }],
          confidence: 0.8,
          recommendations: ["Compare the bundled parser and runtime versions."],
        }] : [],
        falsePassRisks: assessment === "suspected-false-pass" ? ["A stale UI state may have matched."] : [],
        evidenceGaps: ["No independent final-state trace was saved."],
        confidence: 0.8,
      },
    },
  };
}

describe("aggregate Markdown summaries", () => {
  it("puts TL;DR first, followed by the table, AI details, and original failure/crash details", async () => {
    const crashed: TestReport = {
      ...report("Crashed"),
      crashed: true,
      crashReason: "VSCode exited during launch",
      results: [],
      summary: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
    };
    const reports = [report("Passed"), report("Failed", "fail"), crashed];
    const original = JSON.stringify(reports);
    const llm = client();
    const summary = await generateSummary(reports, { analysisMode: "case" }, llm);
    const markdown = summary.mdLines.join("\n");
    const sections = [
      "## AI Analysis — TL;DR",
      "- Investigate runtime initialization first.",
      "## E2E Test Results",
      "| Status | Test Plan | Steps | Duration |",
      "## Detailed Analysis",
      "#### Shared cause",
      "### Failed Steps",
      "### Crashes",
    ];
    const positions = sections.map((section) => markdown.indexOf(section));

    expect(positions[0]).toBe(0);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(markdown).toContain("**Failed** → <code>verify</code>");
    expect(markdown).toContain("<pre>Expected runtime to be ready</pre>");
    expect(markdown).toContain("<pre>VSCode exited during launch</pre>");
    expect(summary).toMatchObject({
      failed: ["Failed", "Crashed"],
      passedPlans: 1,
      failedPlans: 1,
      crashedPlans: 1,
    });
    expect(llm.summarizeCaseResultsStructured).toHaveBeenCalledTimes(1);
    expect(llm.summarizeCaseResultsStructured).toHaveBeenCalledWith(reports);
    expect(llm.summarizeResults).not.toHaveBeenCalled();
    expect(JSON.stringify(reports)).toBe(original);
  });

  it("analyzes passing cases without allowing a suspected false pass to change the verdict", async () => {
    const llm = client();
    llm.summarizeCaseResultsStructured.mockResolvedValue({
      tldr: "- A false pass is suspected.",
      details: "The final state lacks independent evidence.",
    });

    const summary = await generateSummary([report("Passed")], { analysisMode: "case" }, llm);

    expect(summary.mdLines[0]).toBe("## AI Analysis — TL;DR");
    expect(summary.mdLines.join("\n")).toContain("A false pass is suspected.");
    expect(summary.failed).toEqual([]);
    expect(summary.passedPlans).toBe(1);
    expect(llm.summarizeCaseResultsStructured).toHaveBeenCalledTimes(1);
  });

  it.each(["disabled", "unconfigured"] as const)("makes %s analysis explicit while retaining deterministic details", async (unavailable) => {
    const llm = client();
    llm.isConfigured.mockReturnValue(unavailable !== "unconfigured");
    const summary = await generateSummary([report("Failed", "fail")], {
      analysisMode: "case",
      llm: unavailable !== "disabled",
    }, llm);
    const markdown = summary.mdLines.join("\n");

    expect(summary.mdLines[0]).toBe("## AI Analysis — TL;DR");
    expect(markdown).toContain("**AI analysis unavailable:**");
    expect(markdown).toContain(unavailable === "disabled" ? "--no-llm" : "not configured");
    expect(markdown).toContain("## E2E Test Results");
    expect(markdown).toContain("### Failed Steps");
    expect(markdown).toContain("Expected runtime to be ready");
    expect(summary.failed).toEqual(["Failed"]);
    expect(llm.summarizeCaseResultsStructured).not.toHaveBeenCalled();
    expect(llm.summarizeResults).not.toHaveBeenCalled();
  });

  it.each(["fail", "pass"] as const)("retains %s verdicts when aggregate analysis fails", async (status) => {
    const llm = client();
    llm.summarizeCaseResultsStructured.mockRejectedValue(new Error("Completion response was truncated"));

    const summary = await generateSummary([report("Case", status)], { analysisMode: "case" }, llm);
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("**AI analysis unavailable:** LLM analysis failed: Completion response was truncated");
    expect(markdown).toContain("## E2E Test Results");
    expect(markdown).toContain("## Detailed Analysis");
    expect(summary.failed).toEqual(status === "fail" ? ["Case"] : []);
    expect(console.warn).toHaveBeenCalledWith("LLM analysis failed: Completion response was truncated");
    if (status === "fail") {
      expect(markdown).toContain("Expected runtime to be ready");
    } else {
      expect(markdown).toContain("No failed steps or crashes were recorded.");
    }
  });

  it("preserves the legacy Markdown layout and text analysis API by default", async () => {
    const llm = client();
    const summary = await generateSummary([report("Failed", "fail")], {}, llm);

    expect(summary.mdLines).toEqual([
      "## E2E Test Results",
      "",
      "| Status | Test Plan | Steps | Duration |",
      "|--------|-----------|-------|----------|",
      "| ❌ | Failed | 0/1 | 1.0s |",
      "",
      "**Total: 1** — ✅ 0 passed · ❌ 1 failed · 💥 0 crashed",
      "",
      "### Failed Steps",
      "",
      "- **Failed** → `verify`: Expected runtime to be ready",
      "",
      "### 🤖 AI Analysis",
      "",
      "Legacy diagnosis",
    ]);
    expect(llm.summarizeResults).toHaveBeenCalledWith([expect.objectContaining({
      failedSteps: [{ stepId: "verify", action: "wait", reason: "Expected runtime to be ready" }],
    })]);
    expect(llm.summarizeCaseResultsStructured).not.toHaveBeenCalled();
  });

  it.each(["legacy", "evidence-only"] as const)("does not introduce AI calls or a new layout for passing %s reports", async (analysisMode) => {
    const llm = client();
    const summary = await generateSummary([report("Passed")], { analysisMode }, llm);

    expect(summary.mdLines[0]).toBe("## E2E Test Results");
    expect(summary.mdLines.join("\n")).not.toContain("AI Analysis");
    expect(llm.isConfigured).not.toHaveBeenCalled();
    expect(llm.summarizeResults).not.toHaveBeenCalled();
    expect(llm.summarizeCaseResultsStructured).not.toHaveBeenCalled();
  });

  it("keeps evidence-only failures free of LLM calls", async () => {
    const llm = client();
    const summary = await generateSummary([report("Failed", "fail")], { analysisMode: "evidence-only" }, llm);

    expect(summary.mdLines[0]).toBe("## E2E Test Results");
    expect(summary.mdLines).toContain("### Failed Steps");
    expect(llm.isConfigured).not.toHaveBeenCalled();
  });

  it("renders saved RCA, audits, coverage, and missing-analysis errors when aggregation fails", async () => {
    const failed = withAnalysis(report("Failed", "fail"));
    failed.evidence = {
      capturedAt: "2026-09-16T00:00:00.000Z",
      environment: { platform: "win32", runnerOs: "Windows", arch: "x64", nodeVersion: "v22" },
      installedExtensions: [],
      bundledArtifacts: [],
      logs: [],
      signatures: [],
    };
    failed.results[0].evidence = {
      capturedAt: "2026-09-16T00:00:00.000Z",
      problemCounts: { errors: 1, warnings: 0 },
      collectionErrors: ["An additional output channel was unavailable."],
      diagnostics: [{
        severity: "error",
        message: "Runtime could not load Parser.v2.",
        source: "Runtime",
        file: "src/App.java",
      }],
    };
    const missing = report("No audit");
    missing.analysis = { schemaVersion: 1, mode: "case", error: "Azure OpenAI API error 500" };
    const reports = [
      failed,
      withAnalysis(report("Warning"), "suspected-false-pass"),
      withAnalysis(report("Audited")),
      missing,
    ];
    const original = JSON.stringify(reports);
    const llm = client();
    llm.summarizeCaseResultsStructured.mockRejectedValue(new Error("Truncated"));

    const summary = await generateSummary(reports, { analysisMode: "case" }, llm);
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("| Saved case analyses | 3/4 |");
    expect(markdown).toContain("| Failed cases with analysis | 1/1 |");
    expect(markdown).toContain("| Passing cases with an audit | 2/3 |");
    expect(markdown).toContain("| Suspected false passes (AI warnings) | 1 |");
    expect(markdown).toContain("| Cases without analysis | 1 |");
    expect(markdown).toContain("[Failed \\[Windows\\]](#case-1)");
    expect(markdown).toContain('<a id="case-1"></a>');
    expect(markdown).toContain("<details open>\n<summary>Saved failure diagnoses and evidence (1)</summary>");
    expect(markdown).toContain("A parser component may be incompatible.");
    expect(markdown).toContain("Problem counts: 1 errors, 0 warnings; 1 diagnostic message(s) captured.");
    expect(markdown).toContain("<code>src/App.java</code>: Runtime could not load Parser.v2.");
    expect(markdown).toContain("Direct failures (AI mapping): <code>verify</code>");
    expect(markdown).toContain("Cascading failures (AI mapping): <code>finish</code> (not present in recorded execution)");
    expect(markdown).toContain("<code>evidence/logs/runtime.log</code> at <code>line 12</code>");
    expect(markdown).toContain("Compare the bundled parser and runtime versions.");
    expect(markdown).toContain("<details>\n<summary>Recorded diagnostic snapshots</summary>");
    expect(markdown).toContain("An additional output channel was unavailable.");
    expect(markdown.indexOf("Compare the bundled parser")).toBeLessThan(markdown.indexOf("<summary>Recorded diagnostic snapshots"));
    expect(markdown.match(/<details(?: open)?>/g)?.length).toBe(markdown.match(/<\/details>/g)?.length);
    expect(markdown).toContain("No independent final-state trace was saved.");
    expect(markdown).toContain("<code>analysis/case-analysis.json</code>");
    expect(markdown).toContain("A stale UI state may have matched.");
    expect(markdown).toContain("model opinions, not independently confirmed facts");
    expect(markdown).toContain("Azure OpenAI API error 500");
    expect(summary.failed).toEqual(["Failed"]);
    expect(JSON.stringify(reports)).toBe(original);
  });

  it("retains saved evidence with a successful cross-case synthesis instead of replacing it with prose", async () => {
    const summary = await generateSummary([withAnalysis(report("Failed", "fail"))], { analysisMode: "case" }, client());
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("### Cross-case synthesis (AI)");
    expect(markdown).toContain("Runtime initialization explains the dependent failures.");
    expect(markdown).toContain("<details>\n<summary>Saved failure diagnoses and evidence (1)</summary>");
    expect(markdown).toContain("Evidence cited by the case model");
    expect(markdown).toContain("Runtime could not load Parser.v2.");
    expect(markdown.indexOf("### Cross-case synthesis")).toBeLessThan(markdown.indexOf("Saved failure diagnoses"));
    expect(markdown.indexOf("Saved failure diagnoses")).toBeLessThan(markdown.indexOf("Raw execution failures"));
  });

  it("does not merge independently saved hypotheses using a shared fingerprint without supporting evidence", async () => {
    const first = withAnalysis(report("First", "fail"));
    const second = withAnalysis(report("Second", "fail"));
    first.analysis!.case!.rootCauses[0].evidence = [];
    second.analysis!.case!.rootCauses[0].evidence = [];
    second.analysis!.case!.rootCauses[0].summary = "A different component may be responsible.";
    const llm = client();

    const summary = await generateSummary([first, second], { analysisMode: "case", llm: false }, llm);
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("no shared root cause is inferred from matching labels");
    expect(markdown.match(/\*\*Hypothesis 1:\*\*/g)).toHaveLength(2);
    expect(markdown).toContain("A parser component may be incompatible.");
    expect(markdown).toContain("A different component may be responsible.");
    expect(markdown.match(/No supporting citations were recorded/g)).toHaveLength(2);
    expect(llm.isConfigured).not.toHaveBeenCalled();
  });

  it("folds full failure reasons without a 150-character cut or allowing embedded HTML to close the section", async () => {
    const r = report("Plan | <tag>", "fail");
    r.results[0].reason = `${"long ".repeat(100)}FINAL_EVIDENCE_TOKEN\n</details><script>not markup</script>\n\u001b[31mred\u001b[0m`;

    const summary = await generateSummary([r], { analysisMode: "case", llm: false });
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("<details>\n<summary>Raw execution failures (complete recorded reasons)</summary>");
    expect(markdown).toContain(`${"long ".repeat(100)}FINAL_EVIDENCE_TOKEN`);
    expect(markdown).toContain("&lt;/details&gt;&lt;script&gt;not markup&lt;/script&gt;");
    expect(markdown).not.toContain("<script>");
    expect(markdown).not.toContain("\u001b[31m");
    expect(markdown).toContain("Plan \\| &lt;tag&gt;");
  });

  it("labels inconclusive pass audits separately from confirmed failures", async () => {
    const summary = await generateSummary([withAnalysis(report("Uncertain"), "inconclusive")], {
      analysisMode: "case",
      llm: false,
    });
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("Passing-case audit warnings and inconclusive assessments (1)");
    expect(markdown).toContain("**Runner verdict:** passed · **AI assessment:** inconclusive");
    expect(markdown).toContain("| Suspected false passes (AI warnings) | 0 |");
    expect(summary.failed).toEqual([]);
  });

  it("makes missing crash reasons and aggregate errors explicit without treating errors as report markup", async () => {
    const crashed: TestReport = {
      ...report("Crashed"),
      crashed: true,
      crashReason: "",
      results: [],
      summary: { total: 0, passed: 0, failed: 0, errors: 0, skipped: 0 },
    };
    const llm = client();
    llm.summarizeCaseResultsStructured.mockRejectedValue(new Error("<details>upstream error</details>"));

    const summary = await generateSummary([crashed], { analysisMode: "case" }, llm);
    const markdown = summary.mdLines.join("\n");

    expect(markdown).toContain("LLM analysis failed: &lt;details&gt;upstream error&lt;/details&gt;");
    expect(markdown).toContain("<pre>No crash reason was recorded.</pre>");
    expect(markdown).toContain("| Cases without analysis | 1 |");
    expect(markdown).toContain("No saved case analysis was found in this report.");
    expect(summary.crashedPlans).toBe(1);
    expect(summary.failed).toEqual(["Crashed"]);
  });
});
