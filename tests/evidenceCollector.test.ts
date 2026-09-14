import { afterEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { VscodeDriver } from "../src/drivers/vscodeDriver.js";
import { EvidenceCollector, extractFailureSignatures } from "../src/operators/evidenceCollector.js";
import type { ProbeSnapshot } from "../src/types.js";

const temporaryDirectories: string[] = [];

function createTemporaryDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-evidence-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("EvidenceCollector", () => {
  it("collects probe diagnostics, extension versions, bundled jars, and redacted JDT logs", async () => {
    const root = createTemporaryDirectory();
    const userDataDir = path.join(root, "user-data");
    const extensionsDir = path.join(root, "extensions");
    const outputDir = path.join(root, "results");
    const probePath = path.join(userDataDir, "User", "autotest-probe.json");
    const redhatExtension = path.join(extensionsDir, "redhat.java-1.57.2026091208");
    const logPath = path.join(
      userDataDir,
      "User",
      "workspaceStorage",
      "workspace-id",
      "redhat.java",
      "jdt_ws",
      ".metadata",
      ".log",
    );

    fs.mkdirSync(path.dirname(probePath), { recursive: true });
    fs.mkdirSync(path.join(redhatExtension, "server", "plugins"), { recursive: true });
    fs.mkdirSync(path.join(redhatExtension, "lombok"), { recursive: true });
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(
      path.join(redhatExtension, "package.json"),
      JSON.stringify({
        publisher: "redhat",
        name: "java",
        version: "1.57.2026091208",
      }),
    );
    fs.writeFileSync(
      path.join(redhatExtension, "server", "plugins", "org.eclipse.jdt.core_3.48.0.v20260911-1206.jar"),
      "",
    );
    fs.writeFileSync(
      path.join(redhatExtension, "lombok", "lombok-1.18.39-4050.jar"),
      "",
    );

    const diagnosticMessage = [
      "Lombok can't parse this source:",
      "java.lang.NoSuchFieldError: Class org.eclipse.jdt.internal.compiler.ast.ConstructorDeclaration",
      "does not have member field 'org.eclipse.jdt.internal.compiler.ast.ExplicitConstructorCall constructorCall'",
    ].join("\n");
    fs.writeFileSync(
      logPath,
      `${diagnosticMessage}\napi-key=super-secret-value\n`,
    );

    const probe: ProbeSnapshot = {
      schemaVersion: 1,
      capturedAt: "2026-09-12T10:00:00.000Z",
      vscode: {
        version: "1.137.0",
        appName: "Visual Studio Code",
        appHost: "desktop",
        uiKind: 1,
      },
      process: {
        platform: "win32",
        arch: "x64",
        nodeVersion: "v22.0.0",
        execPath: "Code.exe",
      },
      workspaceFolders: ["file:///workspace"],
      diagnostics: [{
        uri: "file:///workspace/Foo.java",
        file: "C:\\Users\\private-user\\workspace\\Foo.java",
        severity: "error",
        message: diagnosticMessage,
        source: "Java",
        range: {
          start: { line: 1, character: 1 },
          end: { line: 1, character: 2 },
        },
      }],
      extensions: [{
        id: "redhat.java",
        version: "1.57.2026091208",
        isActive: true,
      }],
    };
    fs.writeFileSync(probePath, JSON.stringify(probe));

    const driver = {
      refreshProbeSnapshot: vi.fn().mockResolvedValue(undefined),
      getProbeSnapshotPath: vi.fn().mockReturnValue(probePath),
      getProblemsCount: vi.fn().mockResolvedValue({ errors: 3, warnings: 0 }),
      getProblems: vi.fn().mockResolvedValue([]),
      getUserDataDir: vi.fn().mockReturnValue(userDataDir),
      getExtensionsDir: vi.fn().mockReturnValue(extensionsDir),
    } as unknown as VscodeDriver;
    const collector = new EvidenceCollector(driver, outputDir);

    const stepEvidence = await collector.captureFailureEvidence("ls-ready");
    const runEvidence = collector.collectRunEvidence();
    fs.mkdirSync(path.join(outputDir, "screenshots"), { recursive: true });
    fs.writeFileSync(path.join(outputDir, "screenshots", "01_ls-ready_before.png"), "png");
    fs.writeFileSync(path.join(outputDir, "screenshots", "02_ls-ready_after.png"), "png");
    const manifestPath = collector.writeBundle({
      name: "Java Basic Editing",
      setup: {
        extension: "redhat.java",
        workspace: "fixtures/basic",
        settings: {
          "service.apiKey": "scenario-secret-value",
        },
      },
      steps: [{
        id: "ls-ready",
        action: "wait",
        verify: "Problems contains 0 errors",
      }],
    }, [{
      stepId: "ls-ready",
      action: "wait",
      status: "fail",
      reason: "Expected 0 errors, got 3",
      duration: 1_000,
      evidence: stepEvidence,
    }], runEvidence, false);

    expect(stepEvidence.collectionErrors).toBeUndefined();
    expect(stepEvidence.problemCounts).toEqual({ errors: 3, warnings: 0 });
    expect(stepEvidence.diagnostics[0]?.message).toContain("NoSuchFieldError");
    expect(stepEvidence.signatures?.join("\n")).toContain("NoSuchFieldError");
    expect(runEvidence.environment.vscode?.version).toBe("1.137.0");
    expect(runEvidence.collectionErrors).toBeUndefined();
    expect(runEvidence.installedExtensions).toContainEqual(expect.objectContaining({
      id: "redhat.java",
      version: "1.57.2026091208",
    }));
    expect(runEvidence.bundledArtifacts).toEqual(expect.arrayContaining([
      "lombok-1.18.39-4050.jar",
      "org.eclipse.jdt.core_3.48.0.v20260911-1206.jar",
    ]));
    expect(runEvidence.logs).toHaveLength(1);
    expect(runEvidence.logs[0]?.tail).toContain("NoSuchFieldError");
    expect(runEvidence.logs[0]?.tail).not.toContain("super-secret-value");
    expect(runEvidence.logs[0]?.tail).toContain("<redacted>");
    expect(fs.readFileSync(
      path.join(outputDir, runEvidence.logs[0]!.artifactPath!),
      "utf8",
    )).not.toContain("super-secret-value");
    expect(manifestPath).toBe("evidence/manifest.json");
    expect(fs.existsSync(path.join(outputDir, "evidence", "diagnostics", "ls-ready-evidence.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "evidence", "environment.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "evidence", "scenario.json"))).toBe(true);
    expect(fs.existsSync(path.join(outputDir, "evidence", "execution.json"))).toBe(true);
    const scenario = fs.readFileSync(
      path.join(outputDir, "evidence", "scenario.json"),
      "utf8",
    );
    expect(scenario).not.toContain("scenario-secret-value");
    expect(scenario).toContain("<redacted>");
    const diagnosticArtifact = fs.readFileSync(
      path.join(outputDir, "evidence", "diagnostics", "ls-ready-evidence.json"),
      "utf8",
    );
    expect(diagnosticArtifact).not.toContain("private-user");
    expect(diagnosticArtifact).toContain("<user>");
    const manifest = JSON.parse(fs.readFileSync(
      path.join(outputDir, "evidence", "manifest.json"),
      "utf8",
    ));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.planName).toBe("Java Basic Editing");
    expect(manifest.declaredVerdict).toBe("failed");
    expect(manifest.artifacts).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "scenario", path: "evidence/scenario.json" }),
      expect.objectContaining({ type: "probe", path: "evidence/probe-final.json" }),
      expect.objectContaining({
        type: "diagnostics",
        path: "evidence/diagnostics/ls-ready-evidence.json",
        stepId: "ls-ready",
      }),
      expect.objectContaining({ type: "log", label: "jdtls" }),
      expect.objectContaining({
        type: "screenshot",
        path: "screenshots/01_ls-ready_before.png",
        stepId: "ls-ready",
        phase: "before",
      }),
    ]));
  });

  it("extracts recurring exception signatures from multiline evidence", () => {
    const signatures = extractFailureSignatures([
      "Internal compiler error: java.lang.RuntimeException: Internal Error compiling Foo.java",
      "java.lang.NoSuchFieldError: ConstructorDeclaration.constructorCall",
    ]);

    expect(signatures).toEqual(expect.arrayContaining([
      expect.stringContaining("Internal compiler error"),
      expect.stringContaining("NoSuchFieldError"),
    ]));
  });

  it("records probe failures while retaining DOM fallback evidence", async () => {
    const driver = {
      refreshProbeSnapshot: vi.fn().mockRejectedValue(new Error("command unavailable")),
      getProbeSnapshotPath: vi.fn().mockReturnValue("missing-probe.json"),
      getProblemsCount: vi.fn().mockResolvedValue({ errors: 1, warnings: 0 }),
      getProblems: vi.fn().mockResolvedValue([{
        severity: "error",
        message: "Visible fallback error",
      }]),
    } as unknown as VscodeDriver;
    const collector = new EvidenceCollector(driver, null);

    const evidence = await collector.captureFailureEvidence("failed-step");

    expect(evidence.collectionErrors).toEqual(expect.arrayContaining([
      expect.stringContaining("Probe refresh failed"),
      expect.stringContaining("Probe snapshot is unavailable"),
    ]));
    expect(evidence.visibleProblems).toEqual([{
      severity: "error",
      message: "Visible fallback error",
    }]);
  });
});
