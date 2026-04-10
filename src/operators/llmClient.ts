/**
 * LLMClient — Azure OpenAI integration for screenshot-based verification.
 *
 * Sends a screenshot (base64) + natural language verify description to GPT-4o,
 * receives a structured pass/fail judgment.
 *
 * Configuration via environment variables:
 *   AZURE_OPENAI_ENDPOINT     — e.g. https://myresource.openai.azure.com/
 *   AZURE_OPENAI_API_KEY      — API key
 *   AZURE_OPENAI_DEPLOYMENT   — deployment name, e.g. gpt-4o
 *   AZURE_OPENAI_API_VERSION  — optional, defaults to 2024-12-01-preview
 */

import type { VerificationResult } from "../types.js";

const SYSTEM_PROMPT = `You are a VSCode UI test verifier. You will receive a screenshot of VSCode and a natural language description of the expected state.

Your job:
1. Analyze the screenshot carefully.
2. Determine if the described expectation is met.
3. Return a JSON object with exactly these fields:
   - "passed": boolean — true if the expectation is met
   - "reasoning": string — brief explanation of what you observed
   - "confidence": number — 0 to 1, how confident you are

Rules:
- Focus only on what the description asks about. Ignore unrelated UI elements.
- If the screenshot is unclear or the description is ambiguous, set confidence < 0.7.
- Be strict: if the description says "X is visible" and X is not clearly visible, fail it.
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
    this.deployment = options.deployment ?? process.env.AZURE_OPENAI_DEPLOYMENT ?? "gpt-4o";
    this.apiVersion = options.apiVersion ?? process.env.AZURE_OPENAI_API_VERSION ?? "2024-12-01-preview";
  }

  /** Check if the LLM client is configured and ready to use */
  isConfigured(): boolean {
    return !!(this.endpoint && this.apiKey);
  }

  /**
   * Verify a screenshot against a natural language description.
   * Returns a structured verification result.
   */
  async verifyScreenshot(
    screenshotBase64: string,
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
              text: `Verify this expectation: "${verifyDescription}"`,
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${screenshotBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
      max_tokens: 300,
      temperature: 0.1,
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
      };
    } catch (e) {
      const message = (e as Error).message;
      // On parse errors or network errors, return a low-confidence pass
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
}
