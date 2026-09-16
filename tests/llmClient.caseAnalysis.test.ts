import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/operators/llmClient.js";
import type { CaseAnalysis, TestPlan, TestReport } from "../src/types.js";

beforeEach(() => {
  vi.stubEnv("AUTOTEST_CASE_ANALYSIS_MAX_TOKENS", undefined);
  vi.stubEnv("AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS", undefined);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const plan: TestPlan = {
  name: "Java Basic Editing",
  setup: {
    extension: "redhat.java",
    workspace: "fixtures/basic",
    settings: {
      "service.apiKey": "plan-secret-value",
    },
  },
  steps: [{
    id: "ls-ready",
    action: "waitForLanguageServer",
    verify: "Problems contains 0 errors",
  }, {
    id: "apply-code-action",
    action: "executeVSCodeCommand java.apply.workspaceEdit",
    verify: "code action completed",
  }],
};

function report(status: "pass" | "fail" = "fail"): TestReport {
  const failed = status === "fail";
  return {
    planName: plan.name,
    startTime: "2026-09-12T09:59:58.000Z",
    endTime: "2026-09-12T10:00:01.000Z",
    duration: 3_000,
    crashed: false,
    results: [{
      stepId: "ls-ready",
      action: "waitForLanguageServer",
      status,
      reason: failed ? "Expected 0 errors, got 3" : "Problems contains 0 errors",
      duration: 1_000,
      evidence: failed ? {
        capturedAt: "2026-09-12T10:00:00.000Z",
        diagnostics: [{
          severity: "error",
          message: "java.lang.NoSuchFieldError: ConstructorDeclaration.constructorCall",
          source: "Java",
          file: "C:\\Users\\private-user\\workspace\\Foo.java",
          uri: "file:///c%3A/Users/private-user/workspace/Foo.java",
        }],
        signatures: [
          "java.lang.NoSuchFieldError: ConstructorDeclaration.constructorCall",
        ],
      } : undefined,
    }, {
      stepId: "apply-code-action",
      action: "executeVSCodeCommand java.apply.workspaceEdit",
      status: failed ? "error" : "pass",
      reason: failed ? "Code action not found" : "code action completed",
      duration: 2_000,
    }],
    summary: {
      total: 2,
      passed: failed ? 0 : 2,
      failed: failed ? 1 : 0,
      skipped: 0,
      errors: failed ? 1 : 0,
    },
    evidence: {
      capturedAt: "2026-09-12T10:00:01.000Z",
      environment: {
        platform: "win32",
        arch: "x64",
        nodeVersion: "v22.0.0",
      },
      installedExtensions: [{
        id: "redhat.java",
        version: "1.57.2026091208",
      }],
      bundledArtifacts: [
        "org.eclipse.jdt.core_3.48.0.v20260911-1206.jar",
        "lombok-1.18.39-4050.jar",
      ],
      logs: [{
        kind: "jdtls",
        sourcePath: "workspaceStorage/id/redhat.java/jdt_ws/.metadata/.log",
        sizeBytes: 2_000,
        tail: [
          "java.lang.NoSuchFieldError: ConstructorDeclaration.constructorCall",
          "api-key=super-secret-value",
        ].join("\n"),
      }],
      signatures: [
        "java.lang.NoSuchFieldError: ConstructorDeclaration.constructorCall",
      ],
    },
  };
}

function mockCompletion(content: string, finishReason = "stop") {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: vi.fn().mockResolvedValue({
      choices: [{ finish_reason: finishReason, message: { content } }],
    }),
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("LLMClient case and matrix analysis", () => {
  it("sends the full scenario, execution evidence, logs, versions, and screenshots for failure RCA", async () => {
    const expected: CaseAnalysis = {
      schemaVersion: 1,
      kind: "failure-root-cause",
      assessment: "confirmed-failure",
      summary: "The language server failed before the code action step.",
      earliestDivergence: {
        stepId: "ls-ready",
        observation: "NoSuchFieldError appeared while the language server initialized.",
      },
      rootCauses: [{
        fingerprint: "NoSuchFieldError:ConstructorDeclaration.constructorCall",
        summary: "Bundled Lombok is binary-incompatible with JDT Core.",
        suspectedComponent: "redhat.java bundled Lombok/JDT Core integration",
        directFailureSteps: ["ls-ready"],
        cascadingFailureSteps: ["apply-code-action"],
        evidence: [{
          artifact: "evidence/diagnostics/ls-ready-evidence.json",
          observation: "ConstructorDeclaration.constructorCall is missing.",
        }, {
          artifact: "evidence/logs/jdtls-1.log",
          observation: "The same exception is present in the JDT LS log.",
        }],
        confidence: 0.98,
        recommendations: ["Update the bundled Lombok build or disable Lombok support as an A/B test."],
      }],
      falsePassRisks: [],
      evidenceGaps: [],
      confidence: 0.98,
    };
    const response = {
      ...expected,
      rootCauses: expected.rootCauses.map((rootCause) => ({
        ...rootCause,
        evidence: rootCause.evidence.map((citation) => ({
          ...citation,
          location: null,
        })),
      })),
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(response) },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      deployment: "gpt-4.1",
    });

    await expect(client.analyzeCase({
      plan,
      report: report(),
      evidenceManifestPath: "evidence/manifest.json",
      evidenceManifest: {
        schemaVersion: 1,
        generatedAt: "2026-09-12T10:00:02.000Z",
        planName: plan.name,
        declaredVerdict: "failed",
        artifacts: [{
          type: "diagnostics",
          path: "evidence/diagnostics/ls-ready-evidence.json",
          stepId: "ls-ready",
        }, {
          type: "log",
          path: "evidence/logs/jdtls-1.log",
          label: "jdtls",
        }],
      },
      screenshots: [{
        label: "01_ls-ready_after.png",
        base64: "ZmFrZS1wbmc=",
      }],
    })).resolves.toEqual(expected);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.max_completion_tokens).toBe(4_000);
    expect(request.response_format.json_schema.name).toBe("case_analysis");
    const prompt = request.messages[1].content[0].text;
    expect(prompt).toContain("complete E2E scenario");
    expect(prompt).toContain("apply-code-action");
    expect(prompt).toContain("ConstructorDeclaration.constructorCall");
    expect(prompt).toContain("redhat.java");
    expect(prompt).toContain("lombok-1.18.39-4050.jar");
    expect(prompt).toContain("evidence/diagnostics/ls-ready-evidence.json");
    expect(prompt).not.toContain("private-user");
    expect(prompt).not.toContain("super-secret-value");
    expect(prompt).not.toContain("plan-secret-value");
    expect(prompt).toContain("api-key=<redacted>");
    expect(prompt).toContain("<user>");
    expect(request.messages[1].content[2].image_url.url).toBe(
      "data:image/png;base64,ZmFrZS1wbmc=",
    );
  });

  it.each([
    { source: "default", env: undefined, sdk: undefined, tokens: 4_000 },
    { source: "environment", env: "6000", sdk: undefined, tokens: 6_000 },
    { source: "padded environment", env: " 5000 ", sdk: undefined, tokens: 5_000 },
    { source: "minimum positive value", env: "1", sdk: undefined, tokens: 1 },
    { source: "SDK", env: undefined, sdk: 7_000, tokens: 7_000 },
    { source: "SDK over environment", env: "6000", sdk: 7_000, tokens: 7_000 },
    { source: "SDK over invalid environment", env: "invalid", sdk: 5_000, tokens: 5_000 },
  ])("audits successful cases with the $source token budget", async ({ env, sdk, tokens }) => {
    vi.stubEnv("AUTOTEST_CASE_ANALYSIS_MAX_TOKENS", env);
    const expected: CaseAnalysis = {
      schemaVersion: 1,
      kind: "pass-audit",
      assessment: "suspected-false-pass",
      summary: "The steps passed, but the final state was not independently verified.",
      earliestDivergence: {
        observation: "The final command has no independent state assertion.",
      },
      rootCauses: [],
      falsePassRisks: ["The verifier only checked that the command completed."],
      evidenceGaps: ["No deterministic final-state artifact was captured."],
      confidence: 0.75,
    };
    const response = {
      ...expected,
      earliestDivergence: {
        stepId: null,
        observation: expected.earliestDivergence.observation,
      },
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          finish_reason: "stop",
          message: { content: JSON.stringify(response) },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      caseAnalysisMaxTokens: sdk,
    });

    await expect(client.analyzeCase({
      plan,
      report: report("pass"),
    })).resolves.toEqual(expected);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.max_completion_tokens).toBe(tokens);
    expect(request.messages[0].content).toContain("For a passing case");
    expect(request.messages[1].content[0].text).toContain('"passed": 2');
  });

  it.each([
    "", " ", "0", "-1", "1.5", "4k", "4000tokens", "NaN", "Infinity",
    "0x1000", "1e3", "9007199254740992",
  ])("rejects invalid environment token budget %j before requesting analysis", async (value) => {
    vi.stubEnv("AUTOTEST_CASE_ANALYSIS_MAX_TOKENS", value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
    });

    await expect(client.analyzeCase({
      plan,
      report: report(),
    })).rejects.toThrow(
      "Case analysis token limit must be a positive safe integer. "
      + "Check LLMClientOptions.caseAnalysisMaxTokens or AUTOTEST_CASE_ANALYSIS_MAX_TOKENS.",
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid SDK token budget %s without falling back to the environment", async (value) => {
    vi.stubEnv("AUTOTEST_CASE_ANALYSIS_MAX_TOKENS", "6000");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      caseAnalysisMaxTokens: value,
    });

    await expect(client.analyzeCase({
      plan,
      report: report(),
    })).rejects.toThrow("Case analysis token limit must be a positive safe integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not apply or validate the case budget for step verification and summaries", async () => {
    vi.stubEnv("AUTOTEST_CASE_ANALYSIS_MAX_TOKENS", "invalid");
    const verification = { passed: true, reasoning: "Expected state is visible.", confidence: 0.9 };
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ finish_reason: "stop", message: { content: "Summary" } }],
      }),
    }).mockResolvedValueOnce({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{ message: { content: JSON.stringify(verification) } }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      caseAnalysisMaxTokens: 0,
    });

    await expect(client.verifyStep("before", "after", "wait", "Expected state is visible"))
      .resolves.toEqual(verification);
    await expect(client.summarizeResults([])).resolves.toBe("Summary");
    await expect(client.summarizeCaseResults([])).resolves.toBe("Summary");
    expect(fetchMock.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)).max_completion_tokens
    )).toEqual([800, 600, 8_000]);
  });

  it("surfaces truncated structured responses instead of parsing incomplete JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          finish_reason: "length",
          message: { content: "{\"schemaVersion\":1,\"outcome\":\"fail\"" },
        }],
      }),
    }));
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
    });

    await expect(client.analyzeCase({
      plan,
      report: report(),
    })).rejects.toThrow("truncated");
  });

  it.each(["text", "structured"] as const)("summarizes case diagnoses and full legacy failure reasons (%s)", async (format) => {
    const structured = {
      tldr: "- Investigate the shared compiler failure and suspected false pass.",
      details: "Matrix summary",
    };
    const fetchMock = mockCompletion(
      format === "text" ? "Matrix summary" : JSON.stringify(structured),
    );
    const failedReport = report();
    failedReport.evidence!.environment.runnerOs = "Windows";
    failedReport.analysis = {
      schemaVersion: 1,
      mode: "case",
      case: {
        schemaVersion: 1,
        kind: "failure-root-cause",
        assessment: "confirmed-failure",
        summary: "Compiler initialization failed.",
        earliestDivergence: {
          stepId: "ls-ready",
          observation: "The language server emitted NoSuchFieldError.",
        },
        rootCauses: [{
          fingerprint: "NoSuchFieldError:ConstructorDeclaration.constructorCall",
          summary: "Lombok and JDT Core are binary-incompatible.",
          suspectedComponent: "language-server bundle",
          directFailureSteps: ["ls-ready"],
          cascadingFailureSteps: ["apply-code-action"],
          evidence: [{
            artifact: "evidence/logs/jdtls-1.log",
            observation: "The exception names the missing field.",
          }],
          confidence: 0.98,
          recommendations: ["Run once with Lombok support disabled."],
        }],
        falsePassRisks: [],
        evidenceGaps: [],
        confidence: 0.98,
      },
    };
    const passedReport = report("pass");
    passedReport.planName = "Java Debugger";
    passedReport.analysis = {
      schemaVersion: 1,
      mode: "case",
      case: {
        schemaVersion: 1,
        kind: "pass-audit",
        assessment: "suspected-false-pass",
        summary: "The debug action may have been a no-op.",
        earliestDivergence: {
          observation: "No debugger state artifact was captured.",
        },
        rootCauses: [],
        falsePassRisks: ["The verifier matched stale output."],
        evidenceGaps: ["No stopped-thread state was recorded."],
        confidence: 0.7,
      },
    };
    const legacyReport = report();
    legacyReport.planName = "Legacy Case";
    legacyReport.results[0]!.reason = `${"x".repeat(250)} ROOT_TOKEN_AT_END`;
    legacyReport.analysis = undefined;

    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      caseAnalysisMaxTokens: 0,
    });

    const reports = [
      failedReport,
      passedReport,
      legacyReport,
    ];
    const analysis = format === "text"
      ? client.summarizeCaseResults(reports)
      : client.summarizeCaseResultsStructured(reports);
    await expect(analysis).resolves.toEqual(format === "text" ? "Matrix summary" : structured);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(request.max_completion_tokens).toBe(8_000);
    if (format === "structured") {
      expect(request.response_format.json_schema.name).toBe("aggregate_analysis");
      expect(request.response_format.json_schema.strict).toBe(true);
      expect(request.response_format.json_schema.schema.required).toEqual(["tldr", "details"]);
      expect(request.messages[1].content).not.toContain("under 500 words");
      expect(request.messages[1].content).toContain("NOT a list of");
    } else {
      expect(request.response_format).toBeUndefined();
    }
    const prompt = request.messages[1].content;
    expect(prompt).toContain("NoSuchFieldError:ConstructorDeclaration.constructorCall");
    expect(prompt).toContain("Java Basic Editing [Windows]");
    expect(prompt).toContain("The verifier matched stale output.");
    expect(prompt).toContain("ROOT_TOKEN_AT_END");
    expect(prompt).toContain('"recordedFailures"');
    expect(prompt).toContain("Expected 0 errors, got 3");
    expect(prompt).toContain('"runtimeSignalsRef"');
    expect(prompt).toContain('"reference":"case-1"');
    expect(prompt).toContain("not independently confirmed facts");
    expect(prompt).toContain("candidate groups, not proof");
    expect(prompt).toContain("contradict");
    expect(prompt).not.toContain("private-user");
  });

  it("deduplicates recorded observations without losing step attribution, bounds, or redaction", async () => {
    const r = report();
    r.results[0].llmVerification = {
      passed: false,
      reasoning: "The screenshot may show an incomplete import.",
      confidence: 0.9,
    };
    r.results[1].evidence = structuredClone(r.results[0].evidence);
    r.results[1].evidence!.capturedAt = "2026-09-12T10:00:01.000Z";
    r.evidence!.collectionErrors = ["A runtime log could not be read."];
    r.evidence!.signatures = [
      `${"x".repeat(2_050)}SHOULD_BE_TRUNCATED`,
      "api-key=synthetic-secret",
      ...Array.from({ length: 10 }, (_, index) => `signature-${index + 2}`),
    ];
    const duplicate = structuredClone(r);
    duplicate.planName = "Another Case";
    const reports = [r, duplicate];
    const original = JSON.stringify(reports);
    const fetchMock = mockCompletion(JSON.stringify({ tldr: "- Review evidence.", details: "Inspect the first divergence." }));
    const client = new LLMClient({ endpoint: "https://example.openai.azure.com", apiKey: "test-key" });

    await client.summarizeCaseResultsStructured(reports);
    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt: string = request.messages[1].content;
    const cases = JSON.parse(prompt.split("Cases:\n")[1].split("\n\nShared recorded observations:")[0]);
    const observations = JSON.parse(prompt.split("Shared recorded observations:\n")[1].split("\n\nCandidate groups")[0]);

    expect(cases[0].runtimeSignalsRef).toBe(cases[1].runtimeSignalsRef);
    const first = cases[0].recordedFailures[0];
    const second = cases[0].recordedFailures[1];
    expect(first.evidence.diagnosticsRef).toBe(second.evidence.diagnosticsRef);
    expect(first.evidence.diagnosticsRef).toBe(cases[1].recordedFailures[0].evidence.diagnosticsRef);
    expect(first.evidence.capturedAt).not.toBe(second.evidence.capturedAt);
    expect(first.stepId).toBe("ls-ready");
    expect(second.stepId).toBe("apply-code-action");
    expect(first.llmVerification.reasoning).toContain("incomplete import");
    expect(observations).toHaveLength(3);
    expect(prompt.match(/ConstructorDeclaration\.constructorCall/g)).toHaveLength(2);
    expect(prompt).toContain("not inferred root-cause");
    expect(prompt).toContain("A runtime log could not be read.");
    expect(prompt).not.toContain("SHOULD_BE_TRUNCATED");
    expect(prompt).not.toContain("synthetic-secret");
    expect(prompt).not.toContain("private-user");
    expect(prompt).toContain("<redacted>");
    const signals = observations.find((item: { reference: string }) => item.reference === cases[0].runtimeSignalsRef).value;
    expect(signals.signatures).toHaveLength(10);
    expect(signals.signatures[0]).toContain("[truncated");
    expect(JSON.stringify(reports)).toBe(original);
  });

  it.each([
    "null",
    "[]",
    '{"details":"Diagnosis"}',
    '{"tldr":"Conclusion"}',
    '{"tldr":"","details":"Diagnosis"}',
    '{"tldr":"Conclusion","details":"   "}',
    '{"tldr":["Conclusion"],"details":"Diagnosis"}',
  ])("rejects an incomplete structured aggregate instead of rendering a blank TL;DR: %s", async (content) => {
    mockCompletion(content);
    const client = new LLMClient({ endpoint: "https://example.openai.azure.com", apiKey: "test-key" });

    await expect(client.summarizeCaseResultsStructured([report()]))
      .rejects.toThrow("Aggregate analysis must contain non-empty tldr and details strings");
  });

  it("surfaces truncated aggregate responses", async () => {
    mockCompletion('{"tldr":"Incomplete', "length");
    const client = new LLMClient({ endpoint: "https://example.openai.azure.com", apiKey: "test-key" });

    await expect(client.summarizeCaseResultsStructured([report()])).rejects.toThrow("truncated");
  });

  it("surfaces malformed aggregate JSON", async () => {
    mockCompletion("Not JSON");
    const client = new LLMClient({ endpoint: "https://example.openai.azure.com", apiKey: "test-key" });

    await expect(client.summarizeCaseResultsStructured([report()]))
      .rejects.toThrow("Could not parse Azure OpenAI JSON response");
  });

  it("reports missing configuration without issuing an aggregate request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({ endpoint: "", apiKey: "" });

    await expect(client.summarizeCaseResultsStructured([report()])).rejects.toThrow("LLM not configured");
    await expect(client.summarizeCaseResults([report()]))
      .resolves.toBe("LLM not configured — skipping aggregate analysis");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    { source: "default", env: undefined, sdk: undefined, expected: 8_000 },
    { source: "environment", env: "16000", sdk: undefined, expected: 16_000 },
    { source: "padded environment", env: " 12000 ", sdk: undefined, expected: 12_000 },
    { source: "minimum positive value", env: "1", sdk: undefined, expected: 1 },
    { source: "SDK", env: undefined, sdk: 24_000, expected: 24_000 },
    { source: "SDK over environment", env: "16000", sdk: 12_000, expected: 12_000 },
    { source: "SDK over invalid environment", env: "invalid", sdk: 12_000, expected: 12_000 },
  ])("uses the $source aggregate budget for both SDK summary methods", async ({ env, sdk, expected }) => {
    vi.stubEnv("AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS", env);
    const content = { tldr: "- Inspect the failure.", details: "The runtime did not initialize." };
    const fetchMock = mockCompletion(JSON.stringify(content));
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      caseAnalysisMaxTokens: 0,
      aggregateAnalysisMaxTokens: sdk,
    });

    await expect(client.summarizeCaseResultsStructured([report()])).resolves.toEqual(content);
    await expect(client.summarizeCaseResults([report()])).resolves.toBe(JSON.stringify(content));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).max_completion_tokens))
      .toEqual([expected, expected]);
  });

  it.each([
    "", " ", "0", "-1", "1.5", "8k", "8000tokens", "NaN", "Infinity",
    "0x1000", "1e3", "9007199254740992",
  ])("rejects invalid aggregate environment budget %j without issuing a request", async (value) => {
    vi.stubEnv("AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS", value);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({ endpoint: "https://example.openai.azure.com", apiKey: "test-key" });
    const message = "Aggregate analysis token limit must be a positive safe integer. "
      + "Check LLMClientOptions.aggregateAnalysisMaxTokens or AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS.";

    await expect(client.summarizeCaseResultsStructured([report()])).rejects.toThrow(message);
    await expect(client.summarizeCaseResults([report()])).resolves.toBe(`LLM analysis failed: ${message}`);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1,
  ])("rejects invalid aggregate SDK budget %s instead of falling back", async (value) => {
    vi.stubEnv("AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS", "8000");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      aggregateAnalysisMaxTokens: value,
    });

    await expect(client.summarizeCaseResultsStructured([report()]))
      .rejects.toThrow("Aggregate analysis token limit must be a positive safe integer");
    await expect(client.summarizeCaseResults([report()]))
      .resolves.toContain("Aggregate analysis token limit must be a positive safe integer");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not validate or apply aggregate configuration to case, step, or legacy requests", async () => {
    vi.stubEnv("AUTOTEST_AGGREGATE_ANALYSIS_MAX_TOKENS", "invalid");
    const client = new LLMClient({
      endpoint: "https://example.openai.azure.com",
      apiKey: "test-key",
      aggregateAnalysisMaxTokens: 0,
    });
    const analysis: CaseAnalysis = {
      schemaVersion: 1,
      kind: "pass-audit",
      assessment: "confirmed-pass",
      summary: "Expected outcomes have supporting evidence.",
      earliestDivergence: { observation: "None identified." },
      rootCauses: [],
      falsePassRisks: [],
      evidenceGaps: [],
      confidence: 0.9,
    };
    const caseFetch = mockCompletion(JSON.stringify(analysis));
    await expect(client.analyzeCase({ plan, report: report("pass") })).resolves.toEqual(analysis);
    expect(JSON.parse(String(caseFetch.mock.calls[0]?.[1]?.body)).max_completion_tokens).toBe(4_000);

    const verification = { passed: true, reasoning: "Expected state is visible.", confidence: 0.9 };
    const stepFetch = mockCompletion(JSON.stringify(verification));
    await expect(client.verifyStep("before", "after", "wait", "Expected state is visible"))
      .resolves.toEqual(verification);
    expect(JSON.parse(String(stepFetch.mock.calls[0]?.[1]?.body)).max_completion_tokens).toBe(800);

    const legacyFetch = mockCompletion("Summary");
    await expect(client.summarizeResults([])).resolves.toBe("Summary");
    expect(JSON.parse(String(legacyFetch.mock.calls[0]?.[1]?.body)).max_completion_tokens).toBe(600);
  });
});
