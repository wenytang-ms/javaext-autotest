import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { generateSummary } from "../src/cli/summary.js";
import type { LLMClient } from "../src/operators/llmClient.js";
import type { TestReport } from "../src/types.js";

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
      details: "### Shared cause\nRuntime initialization explains the dependent failures.",
    }),
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
      "### Shared cause",
      "### Failed Steps",
      "### Crashes",
    ];
    const positions = sections.map((section) => markdown.indexOf(section));

    expect(positions[0]).toBe(0);
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
    expect(markdown).toContain("- **Failed** → `verify`: Expected runtime to be ready");
    expect(markdown).toContain("- **Crashed**: VSCode exited during launch");
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
});
