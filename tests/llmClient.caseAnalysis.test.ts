import { afterEach, describe, expect, it, vi } from "vitest";
import { LLMClient } from "../src/operators/llmClient.js";
import type { CaseAnalysis, TestPlan, TestReport } from "../src/types.js";

afterEach(() => {
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
    action: "wait",
    target: "language server",
    verify: "Problems contains 0 errors",
  }, {
    id: "apply-code-action",
    action: "executeCommand",
    command: "java.apply.workspaceEdit",
    verify: "code action completed",
  }],
};

function report(status: "pass" | "fail" = "fail"): TestReport {
  const failed = status === "fail";
  return {
    planName: plan.name,
    duration: 3_000,
    crashed: false,
    results: [{
      stepId: "ls-ready",
      action: "wait",
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
      action: "executeCommand",
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

  it("audits successful cases for false-pass risk", async () => {
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
    });

    await expect(client.analyzeCase({
      plan,
      report: report("pass"),
    })).resolves.toEqual(expected);

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(request.messages[0].content).toContain("For a passing case");
    expect(request.messages[1].content[0].text).toContain('"passed": 2');
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

  it("summarizes case diagnoses, false-pass risks, and full legacy failure reasons", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: vi.fn().mockResolvedValue({
        choices: [{
          finish_reason: "stop",
          message: { content: "Matrix summary" },
        }],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
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
    });

    await expect(client.summarizeCaseResults([
      failedReport,
      passedReport,
      legacyReport,
    ])).resolves.toBe("Matrix summary");

    const request = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    const prompt = request.messages[1].content;
    expect(prompt).toContain("NoSuchFieldError:ConstructorDeclaration.constructorCall");
    expect(prompt).toContain("Java Basic Editing [Windows]");
    expect(prompt).toContain("The verifier matched stale output.");
    expect(prompt).toContain("ROOT_TOKEN_AT_END");
  });
});
