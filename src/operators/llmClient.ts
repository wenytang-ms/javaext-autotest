/**
 * LLMClient — Azure OpenAI integration for screenshot verification,
 * opt-in case analysis, and aggregate summaries.
 *
 * Configuration via environment variables:
 *   AZURE_OPENAI_ENDPOINT
 *   AZURE_OPENAI_API_KEY
 *   AZURE_OPENAI_DEPLOYMENT
 *   AZURE_OPENAI_API_VERSION
 */

import type {
  CaseAnalysis,
  EvidenceBundleManifest,
  FailureEvidence,
  RunEvidence,
  StepResult,
  TestPlan,
  TestReport,
  VerificationResult,
} from "../types.js";

const SYSTEM_PROMPT = `You are a VSCode UI test verifier. You will receive:
1. A BEFORE screenshot — the state before the action was performed
2. An AFTER screenshot — the state after the action was performed
3. The action that was performed
4. An expected outcome description

Your job:
1. Compare the BEFORE and AFTER screenshots to identify what changed.
2. Determine if the changes are consistent with the described action.
3. Check if the AFTER screenshot satisfies the expected outcome.
4. Look for any anomalies: error dialogs, unexpected popups, UI glitches, or no change when change was expected.

Return a JSON object with exactly these fields:
- "passed": boolean — true if the action executed correctly AND the expected outcome is met
- "reasoning": string — brief explanation of what changed between before/after and whether it matches expectations
- "confidence": number — 0 to 1, how confident you are
- "suggestion": string (only when passed=false) — actionable advice on what might have gone wrong and how to fix it. Consider: wrong UI element targeted, timing issue, missing prerequisite step, incorrect action parameters, or test plan design issue.

Rules:
- Compare the two screenshots carefully. If they look identical but the action should have caused a visible change, that's a failure.
- Focus on the relevant UI area for the action. Ignore unrelated changes (e.g., clock updates).
- Be strict: if the expected outcome says "X is visible" and X is not clearly visible in the AFTER screenshot, fail it.
- Always respond with valid JSON only, no markdown fences.`;

const CASE_ANALYSIS_SYSTEM_PROMPT = `You are an evidence-first E2E test analyst.
The evidence bundle may come from any VS Code extension scenario. Do not assume a
specific product, language server, build tool, or failure category.

For a passing case, audit whether it is a genuine pass or a possible false pass:
- Verify that the scenario's important expected outcomes have positive evidence.
- Look for no-op actions, stale state, weak assertions, hidden errors, and contradictions.

For a failed case, perform root-cause analysis:
1. Reconstruct the scenario and execution chronologically.
2. Identify the earliest divergence from the expected behavior.
3. Separate observable symptoms from likely causes and cascading failures.
4. Cite concrete logs, diagnostics, screenshots, and execution records.
5. Consider alternatives and evidence gaps. Do not invent evidence.
6. Recommend the smallest experiment that could confirm or disprove the diagnosis.

Return only the requested JSON object.`;

const CASE_ANALYSIS_SCHEMA = {
  name: "case_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    properties: {
      schemaVersion: { type: "number", enum: [1] },
      kind: { type: "string", enum: ["pass-audit", "failure-root-cause"] },
      assessment: {
        type: "string",
        enum: ["confirmed-pass", "suspected-false-pass", "confirmed-failure", "inconclusive"],
      },
      summary: { type: "string" },
      earliestDivergence: {
        type: "object",
        additionalProperties: false,
        properties: {
          stepId: { type: ["string", "null"] },
          observation: { type: "string" },
        },
        required: ["stepId", "observation"],
      },
      rootCauses: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            fingerprint: { type: "string" },
            summary: { type: "string" },
            suspectedComponent: { type: "string" },
            directFailureSteps: { type: "array", items: { type: "string" } },
            cascadingFailureSteps: { type: "array", items: { type: "string" } },
            evidence: {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  artifact: { type: "string" },
                  location: { type: ["string", "null"] },
                  observation: { type: "string" },
                },
                required: ["artifact", "location", "observation"],
              },
            },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            recommendations: { type: "array", items: { type: "string" } },
          },
          required: [
            "fingerprint",
            "summary",
            "suspectedComponent",
            "directFailureSteps",
            "cascadingFailureSteps",
            "evidence",
            "confidence",
            "recommendations",
          ],
        },
      },
      falsePassRisks: { type: "array", items: { type: "string" } },
      evidenceGaps: { type: "array", items: { type: "string" } },
      confidence: { type: "number", minimum: 0, maximum: 1 },
    },
    required: [
      "schemaVersion",
      "kind",
      "assessment",
      "summary",
      "earliestDivergence",
      "rootCauses",
      "falsePassRisks",
      "evidenceGaps",
      "confidence",
    ],
  },
};

export interface LLMClientOptions {
  endpoint?: string;
  apiKey?: string;
  deployment?: string;
  apiVersion?: string;
}

export interface CaseScreenshot {
  label: string;
  base64: string;
}

export interface CaseAnalysisInput {
  plan: TestPlan;
  report: TestReport;
  evidenceManifestPath?: string;
  evidenceManifest?: EvidenceBundleManifest;
  screenshots?: CaseScreenshot[];
}

export interface LegacySummaryReport {
  planName: string;
  duration: number;
  crashed?: boolean;
  crashReason?: string;
  summary: { total: number; passed: number; failed: number; errors: number };
  failedSteps?: Array<{ stepId: string; action: string; reason?: string }>;
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"'\\]+/gi, "$1<redacted>")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*)[^\s,;"'\\]+/gi, "$1<redacted>")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "<redacted-token>")
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/g, "$1<redacted>@")
    .replace(/([A-Za-z]:(?:\\\\|\\)Users(?:\\\\|\\))[^\\\r\n"]+/g, "$1<user>")
    .replace(/(file:\/\/\/[A-Za-z](?::|%3A)\/Users\/)[^/\s"]+/gi, "$1<user>")
    .replace(/((?:file:\/\/)?\/(?:home|Users)\/)[^/\s"]+/g, "$1<user>");
}

function sanitizeForLlm(value: unknown): unknown {
  if (typeof value === "string") return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(sanitizeForLlm);
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = /authorization|api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|credential/i.test(key)
      ? "<redacted>"
      : sanitizeForLlm(entry);
  }
  return sanitized;
}

function limitText(value: string | undefined, maxLength: number): string | undefined {
  if (!value) return value;
  const redacted = redactSensitiveText(value);
  if (redacted.length <= maxLength) return redacted;
  return `${redacted.slice(0, maxLength)}\n...[truncated ${redacted.length - maxLength} characters]`;
}

function compactEvidence(evidence: FailureEvidence | undefined): unknown {
  if (!evidence) return undefined;
  const compactDiagnostic = (diagnostic: FailureEvidence["diagnostics"][number]) => ({
    ...diagnostic,
    message: limitText(diagnostic.message, 8_000),
  });
  return {
    capturedAt: evidence.capturedAt,
    collectionErrors: evidence.collectionErrors,
    problemCounts: evidence.problemCounts,
    activeEditor: evidence.activeEditor,
    signatures: evidence.signatures,
    diagnostics: evidence.diagnostics.slice(0, 200).map(compactDiagnostic),
    visibleProblems: evidence.visibleProblems?.slice(0, 100).map(compactDiagnostic),
  };
}

function compactRunEvidence(evidence: RunEvidence | undefined): unknown {
  if (!evidence) return undefined;
  return {
    capturedAt: evidence.capturedAt,
    collectionErrors: evidence.collectionErrors,
    environment: evidence.environment,
    installedExtensions: evidence.installedExtensions,
    bundledArtifacts: evidence.bundledArtifacts,
    signatures: evidence.signatures,
    logs: evidence.logs.map((log) => ({
      kind: log.kind,
      sourcePath: log.sourcePath,
      artifactPath: log.artifactPath,
      sizeBytes: log.sizeBytes,
      tail: limitText(log.tail, 32_000),
    })),
  };
}

function compactStep(step: StepResult): unknown {
  return {
    stepId: step.stepId,
    action: step.action,
    status: step.status,
    reason: limitText(step.reason, 8_000),
    duration: step.duration,
    screenshot: step.screenshot,
    attempts: step.attempts?.map((attempt) => ({
      ...attempt,
      reason: limitText(attempt.reason, 8_000),
      evidence: compactEvidence(attempt.evidence),
    })),
    llmVerification: step.llmVerification,
    evidence: compactEvidence(step.evidence),
  };
}

export class LLMClient {
  private endpoint: string;
  private apiKey: string;
  private deployment: string;
  private apiVersion: string;

  constructor(options: LLMClientOptions = {}) {
    this.endpoint = options.endpoint ?? process.env.AZURE_OPENAI_ENDPOINT ?? "";
    this.apiKey = options.apiKey ?? process.env.AZURE_OPENAI_API_KEY ?? "";
    this.deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4.1";
    this.apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview";
  }

  isConfigured(): boolean {
    return !!(this.endpoint && this.apiKey);
  }

  async verifyStep(
    beforeBase64: string,
    afterBase64: string,
    action: string,
    verifyDescription: string,
  ): Promise<VerificationResult> {
    if (!this.isConfigured()) {
      return {
        passed: true,
        reasoning: "LLM not configured — auto-pass",
        confidence: 0,
      };
    }

    const url = this.getUrl();
    const body = {
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: `Action performed: "${action}"\nExpected outcome: "${verifyDescription}"\n\nCompare the BEFORE and AFTER screenshots below:`,
            },
            { type: "text", text: "BEFORE:" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${beforeBase64}`,
                detail: "high",
              },
            },
            { type: "text", text: "AFTER:" },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${afterBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_completion_tokens: 800,
    };

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey,
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Azure OpenAI API error ${response.status}: ${errorText.slice(0, 200)}`);
      }

      const data = await response.json() as {
        choices: Array<{ message: { content: string } }>;
      };
      const content = data.choices?.[0]?.message?.content ?? "";
      const result = this.parseJson<VerificationResult>(content);
      return {
        passed: !!result.passed,
        reasoning: result.reasoning ?? "No reasoning provided",
        confidence: typeof result.confidence === "number" ? result.confidence : 0.5,
        suggestion: result.suggestion,
      };
    } catch (e) {
      const message = (e as Error).message;
      if (message.includes("JSON")) {
        return {
          passed: true,
          reasoning: `LLM response parse error: ${message}`,
          confidence: 0,
        };
      }
      throw e;
    }
  }

  async analyzeCase(input: CaseAnalysisInput): Promise<CaseAnalysis> {
    if (!this.isConfigured()) {
      throw new Error("LLM not configured");
    }

    const failed = input.report.crashed
      || input.report.summary.failed + input.report.summary.errors > 0;
    const payload = {
      evidenceManifest: {
        path: input.evidenceManifestPath,
        contents: input.evidenceManifest,
      },
      declaredVerdict: failed ? "failed" : "passed",
      scenario: input.plan,
      execution: {
        crashed: input.report.crashed,
        crashReason: limitText(input.report.crashReason, 8_000),
        summary: input.report.summary,
        duration: input.report.duration,
        steps: input.report.results.map(compactStep),
      },
      runtimeEvidence: compactRunEvidence(input.report.evidence),
    };
    const content: Array<Record<string, unknown>> = [{
      type: "text",
      text: `Analyze this complete E2E scenario using the evidence-first pattern. ${
        failed
          ? "The runner declared the case failed; determine the root cause and cascading failures."
          : "The runner declared the case passed; audit whether it may be a false pass."
      }\n\n${JSON.stringify(sanitizeForLlm(payload), null, 2)}`,
    }];
    for (const screenshot of input.screenshots?.slice(0, 4) ?? []) {
      content.push(
        { type: "text", text: `SCREENSHOT: ${screenshot.label}` },
        {
          type: "image_url",
          image_url: {
            url: `data:image/png;base64,${screenshot.base64}`,
            detail: "high",
          },
        },
      );
    }

    const response = await this.requestCompletion({
      messages: [
        { role: "system", content: CASE_ANALYSIS_SYSTEM_PROMPT },
        { role: "user", content },
      ],
      max_completion_tokens: 1_800,
      response_format: {
        type: "json_schema",
        json_schema: CASE_ANALYSIS_SCHEMA,
      },
    });
    const parsed = this.parseJson<CaseAnalysis & {
      earliestDivergence: { stepId: string | null; observation: string };
      rootCauses: Array<CaseAnalysis["rootCauses"][number] & {
        evidence: Array<CaseAnalysis["rootCauses"][number]["evidence"][number] & {
          location: string | null;
        }>;
      }>;
    }>(response.content);
    if (
      parsed.schemaVersion !== 1
      || !parsed.summary
      || !Array.isArray(parsed.rootCauses)
      || !Array.isArray(parsed.falsePassRisks)
      || !Array.isArray(parsed.evidenceGaps)
      || typeof parsed.confidence !== "number"
    ) {
      throw new Error("Azure OpenAI case analysis did not match the expected schema");
    }

    return {
      ...parsed,
      earliestDivergence: {
        ...(parsed.earliestDivergence.stepId
          ? { stepId: parsed.earliestDivergence.stepId }
          : {}),
        observation: parsed.earliestDivergence.observation,
      },
      rootCauses: parsed.rootCauses.map((rootCause) => ({
        ...rootCause,
        evidence: rootCause.evidence.map((citation) => ({
          artifact: citation.artifact,
          ...(citation.location ? { location: citation.location } : {}),
          observation: citation.observation,
        })),
        confidence: Math.max(0, Math.min(1, rootCause.confidence)),
      })),
      confidence: Math.max(0, Math.min(1, parsed.confidence)),
    };
  }

  /**
   * Legacy aggregate analysis. The input and prompt intentionally retain the
   * previous compact reason-only behavior for backward compatibility.
   */
  async summarizeResults(reports: LegacySummaryReport[]): Promise<string> {
    if (!this.isConfigured()) {
      return "LLM not configured — skipping aggregate analysis";
    }

    const reportSummary = reports.map((report) => {
      const status = report.crashed
        ? "CRASHED"
        : report.summary.failed + report.summary.errors > 0
          ? "FAILED"
          : "PASSED";
      let line = `${status} | ${report.planName} | ${report.summary.passed}/${report.summary.total} steps | ${(report.duration / 1000).toFixed(1)}s`;
      if (report.crashed) line += ` | Crash: ${report.crashReason}`;
      if (report.failedSteps?.length) {
        line += "\n  Failed steps:";
        for (const step of report.failedSteps) {
          line += `\n    - [${step.stepId}] ${step.action}: ${step.reason?.substring(0, 150) ?? "unknown"}`;
        }
      }
      return line;
    }).join("\n");

    const totalPlans = reports.length;
    const passed = reports.filter((report) =>
      !report.crashed && report.summary.failed + report.summary.errors === 0
    ).length;
    const crashed = reports.filter((report) => report.crashed).length;
    const failed = totalPlans - passed - crashed;
    const prompt = `Analyze these E2E test results for VSCode Java extensions.

Overall: ${passed}/${totalPlans} passed, ${failed} failed, ${crashed} crashed

Results per test plan:
${reportSummary}

Provide a concise analysis with:
1. **Health Summary** — one-line overall assessment
2. **Anomalies** — patterns like consecutive crashes, suspiciously fast durations, or recurring errors
3. **Root Causes** — likely causes for failures/crashes (e.g., process leak, LS timing, DOM changes)
4. **Recommendations** — specific, actionable fixes (max 3)

Keep it concise (under 300 words). Use plain text, no markdown.`;

    const response = await fetch(this.getUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify({
        messages: [
          {
            role: "system",
            content: "You are a test infrastructure analyst. Analyze E2E test results and provide actionable insights. Be concise and specific.",
          },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 600,
      }),
    });
    if (!response.ok) {
      const errorText = await response.text();
      return `LLM analysis failed (${response.status}): ${errorText.slice(0, 200)}`;
    }

    const data = await response.json() as {
      choices: Array<{ message: { content: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? "No analysis generated";
  }

  async summarizeCaseResults(reports: TestReport[]): Promise<string> {
    if (!this.isConfigured()) {
      return "LLM not configured — skipping aggregate analysis";
    }

    const clusters = new Map<string, {
      cases: Set<string>;
      summaries: Set<string>;
      components: Set<string>;
      evidence: Set<string>;
    }>();
    const cases = reports.map((report) => {
      const runnerOs = report.evidence?.environment.runnerOs
        ?? report.evidence?.environment.platform;
      const caseId = runnerOs ? `${report.planName} [${runnerOs}]` : report.planName;
      for (const rootCause of report.analysis?.case?.rootCauses ?? []) {
        const fingerprint = rootCause.fingerprint.trim() || rootCause.summary.trim();
        const cluster = clusters.get(fingerprint) ?? {
          cases: new Set<string>(),
          summaries: new Set<string>(),
          components: new Set<string>(),
          evidence: new Set<string>(),
        };
        cluster.cases.add(caseId);
        cluster.summaries.add(rootCause.summary);
        cluster.components.add(rootCause.suspectedComponent);
        for (const citation of rootCause.evidence.slice(0, 5)) {
          cluster.evidence.add(`${citation.artifact}${citation.location ? ` ${citation.location}` : ""}: ${citation.observation}`);
        }
        clusters.set(fingerprint, cluster);
      }

      return {
        caseId,
        runnerVerdict: report.crashed
          ? "crashed"
          : report.summary.failed + report.summary.errors > 0
            ? "failed"
            : "passed",
        summary: report.summary,
        caseAnalysis: report.analysis?.case,
        analysisError: report.analysis?.error,
        legacyFailures: report.analysis?.case
          ? undefined
          : report.results
              .filter((step) => step.status === "fail" || step.status === "error")
              .map((step) => ({
                stepId: step.stepId,
                action: step.action,
                reason: limitText(step.reason, 8_000),
                signatures: step.evidence?.signatures,
              })),
      };
    });
    const clusterSummary = [...clusters.entries()].map(([fingerprint, cluster]) => ({
      fingerprint,
      affectedCases: [...cluster.cases],
      caseSummaries: [...cluster.summaries],
      suspectedComponents: [...cluster.components],
      evidenceExamples: [...cluster.evidence].slice(0, 10),
    }));

    const prompt = `Summarize the analyses from an E2E test matrix.
Treat each case analysis as a diagnosis backed by its own evidence. Merge root
causes only when their fingerprints or supporting evidence indicate the same
underlying issue. Highlight suspected false passes, cross-platform patterns,
direct failures versus cascading failures, disagreements, and evidence gaps.

Cases:
${JSON.stringify(sanitizeForLlm(cases), null, 2)}

Pre-grouped exact root-cause fingerprints:
${JSON.stringify(sanitizeForLlm(clusterSummary), null, 2)}

Provide:
1. Overall matrix health
2. Suspected false passes
3. Root-cause clusters ranked by impact
4. Affected cases and platforms
5. Important evidence gaps or contradictory diagnoses
6. Up to three recommended next actions

Keep the summary under 500 words.`;

    try {
      const { content } = await this.requestCompletion({
        messages: [
          {
            role: "system",
            content: "You summarize evidence-backed case analyses without inventing new root causes.",
          },
          { role: "user", content: prompt },
        ],
        max_completion_tokens: 1_200,
      });
      return content;
    } catch (e) {
      return `LLM analysis failed: ${(e as Error).message}`;
    }
  }

  private getUrl(): string {
    return `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
  }

  private async requestCompletion(body: Record<string, unknown>): Promise<{
    content: string;
    finishReason?: string | null;
  }> {
    const response = await fetch(this.getUrl(), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": this.apiKey,
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Azure OpenAI API error ${response.status}: ${errorText.slice(0, 500)}`);
    }

    const data = await response.json() as {
      choices?: Array<{
        finish_reason?: string | null;
        message?: { content?: string | null };
      }>;
    };
    const choice = data.choices?.[0];
    const content = choice?.message?.content?.trim() ?? "";
    if (choice?.finish_reason === "length") {
      throw new Error("Azure OpenAI response was truncated because the completion token limit was reached");
    }
    if (choice?.finish_reason && choice.finish_reason !== "stop") {
      throw new Error(`Azure OpenAI response did not complete normally: ${choice.finish_reason}`);
    }
    if (!content) {
      throw new Error("Azure OpenAI returned an empty response");
    }
    return { content, finishReason: choice?.finish_reason };
  }

  private parseJson<T>(content: string): T {
    const json = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
    try {
      return JSON.parse(json) as T;
    } catch (e) {
      throw new Error(`Could not parse Azure OpenAI JSON response: ${(e as Error).message}`);
    }
  }
}
