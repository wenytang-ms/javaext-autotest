/**
 * LLMClient — Azure OpenAI integration for screenshot-based verification.
 *
 * Compares before/after screenshots with the action performed and verify description
 * to determine if a test step executed correctly.
 *
 * Configuration via environment variables:
 *   AZURE_OPENAI_ENDPOINT     — e.g. https://myresource.openai.azure.com/
 *   AZURE_OPENAI_API_KEY      — API key
 *   AZURE_OPENAI_DEPLOYMENT   — deployment name, e.g. gpt-4.1
 *   AZURE_OPENAI_API_VERSION  — optional, defaults to 2024-12-01-preview
 */

import type { VerificationResult } from "../types.js";

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

export interface LLMClientOptions {
  endpoint?: string;
  apiKey?: string;
  deployment?: string;
  apiVersion?: string;
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

  /** Check if the LLM client is configured and ready to use */
  isConfigured(): boolean {
    return !!(this.endpoint && this.apiKey);
  }

  /**
   * Verify a test step by comparing before/after screenshots.
   *
   * @param beforeBase64 — screenshot before the action (PNG base64)
   * @param afterBase64 — screenshot after the action (PNG base64)
   * @param action — the action that was performed
   * @param verifyDescription — expected outcome description
   */
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

    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;

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
            {
              type: "text",
              text: "BEFORE:",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${beforeBase64}`,
                detail: "high",
              },
            },
            {
              type: "text",
              text: "AFTER:",
            },
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
      max_completion_tokens: 400,
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

      // Parse JSON from response (handle potential markdown fences)
      const jsonStr = content.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const result = JSON.parse(jsonStr) as VerificationResult;

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

  /**
   * Generate an aggregate analysis of multiple test plan results.
   * Identifies patterns, root causes, and actionable recommendations.
   */
  async summarizeResults(reports: Array<{
    planName: string;
    duration: number;
    crashed?: boolean;
    crashReason?: string;
    summary: { total: number; passed: number; failed: number; errors: number };
    failedSteps?: Array<{ stepId: string; action: string; reason?: string }>;
  }>): Promise<string> {
    if (!this.isConfigured()) {
      return "LLM not configured — skipping aggregate analysis";
    }

    const reportSummary = reports.map(r => {
      const status = r.crashed ? "CRASHED" : r.summary.failed + r.summary.errors > 0 ? "FAILED" : "PASSED";
      let line = `${status} | ${r.planName} | ${r.summary.passed}/${r.summary.total} steps | ${(r.duration / 1000).toFixed(1)}s`;
      if (r.crashed) line += ` | Crash: ${r.crashReason}`;
      if (r.failedSteps?.length) {
        line += `\n  Failed steps:`;
        for (const s of r.failedSteps) {
          line += `\n    - [${s.stepId}] ${s.action}: ${s.reason?.substring(0, 150) ?? "unknown"}`;
        }
      }
      return line;
    }).join("\n");

    const totalPlans = reports.length;
    const passed = reports.filter(r => !r.crashed && r.summary.failed + r.summary.errors === 0).length;
    const crashed = reports.filter(r => r.crashed).length;
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

    const url = `${this.endpoint.replace(/\/$/, "")}/openai/deployments/${this.deployment}/chat/completions?api-version=${this.apiVersion}`;
    const body = {
      messages: [
        { role: "system", content: "You are a test infrastructure analyst. Analyze E2E test results and provide actionable insights. Be concise and specific." },
        { role: "user", content: prompt },
      ],
      max_completion_tokens: 600,
    };

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "api-key": this.apiKey },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text();
      return `LLM analysis failed (${response.status}): ${errorText.slice(0, 200)}`;
    }

    const data = await response.json() as { choices: Array<{ message: { content: string } }> };
    return data.choices?.[0]?.message?.content ?? "No analysis generated";
  }
}
