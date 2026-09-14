import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  Diagnostic,
  EvidenceArtifact,
  EvidenceBundleManifest,
  EvidenceLog,
  FailureEvidence,
  InstalledExtensionEvidence,
  ProbeSnapshot,
  RunEvidence,
  StepResult,
  TestPlan,
} from "../types.js";
import type { VscodeDriver } from "../drivers/vscodeDriver.js";

const MAX_LOG_TAIL_BYTES = 64 * 1024;
const MAX_LOG_SCAN_BYTES = 4 * 1024 * 1024;
const MAX_SIGNATURE_LENGTH = 600;

function readJsonFile<T>(filePath: string | null): T | null {
  if (!filePath || !fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function portableRelativePath(from: string, to: string): string {
  return path.relative(from, to).replaceAll("\\", "/");
}

function listFiles(root: string, predicate: (filePath: string) => boolean): string[] {
  if (!fs.existsSync(root)) return [];

  const matches: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pending.push(entryPath);
      } else if (entry.isFile() && predicate(entryPath)) {
        matches.push(entryPath);
      }
    }
  }
  return matches;
}

function redactSecrets(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;"'\\]+/gi, "$1<redacted>")
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret)\s*[:=]\s*)[^\s,;"'\\]+/gi, "$1<redacted>")
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "<redacted-token>")
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/g, "$1<redacted>@")
    .replace(/([A-Za-z]:\\Users\\)[^\\\r\n"]+/g, "$1<user>")
    .replace(/(file:\/\/\/[A-Za-z](?::|%3A)\/Users\/)[^/\s"]+/gi, "$1<user>")
    .replace(/((?:file:\/\/)?\/(?:home|Users)\/)[^/\s"]+/g, "$1<user>");
}

function sanitizeEvidence<T>(value: T): T {
  if (typeof value === "string") return redactSecrets(value) as T;
  if (Array.isArray(value)) return value.map(sanitizeEvidence) as T;
  if (!value || typeof value !== "object") return value;

  const sanitized: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = /authorization|api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|credential/i.test(key)
      ? "<redacted>"
      : sanitizeEvidence(entry);
  }
  return sanitized as T;
}

function writeEvidenceJson(filePath: string, value: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(sanitizeEvidence(value), null, 2));
}

function readFileRange(filePath: string, start: number, length: number): string {
  const buffer = Buffer.alloc(length);
  const descriptor = fs.openSync(filePath, "r");
  try {
    fs.readSync(descriptor, buffer, 0, length, start);
  } finally {
    fs.closeSync(descriptor);
  }
  return buffer.toString("utf8");
}

function readLogEvidence(filePath: string): string {
  const stat = fs.statSync(filePath);
  const scanStart = Math.max(0, stat.size - MAX_LOG_SCAN_BYTES);
  const scanned = redactSecrets(readFileRange(filePath, scanStart, stat.size - scanStart));
  if (scanned.length <= MAX_LOG_TAIL_BYTES) return scanned;

  const excerpts: string[] = [];
  const seen = new Set<number>();
  const marker = /Lombok can't parse|NoSuch(?:Field|Method)Error|Internal compiler error|(?:Exception|Error):/gi;
  for (const match of scanned.matchAll(marker)) {
    const start = Math.max(0, (match.index ?? 0) - 1_500);
    const bucket = Math.floor(start / 1_000);
    if (seen.has(bucket)) continue;
    seen.add(bucket);
    excerpts.push(scanned.slice(start, start + 10_000));
  }

  const tail = scanned.slice(-16_000);
  const combined = [...excerpts.slice(-5), tail].join("\n\n--- log excerpt ---\n\n");
  return combined.length <= MAX_LOG_TAIL_BYTES
    ? combined
    : combined.slice(-MAX_LOG_TAIL_BYTES);
}

function readAutoTestVersion(): string | undefined {
  const packagePath = fileURLToPath(new URL("../../package.json", import.meta.url));
  const metadata = readJsonFile<{ version?: string }>(packagePath);
  return metadata?.version;
}

function readJavaVersion(): string | undefined {
  const executable = process.env.JAVA_HOME
    ? path.join(process.env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java")
    : "java";
  const result = spawnSync(executable, ["-version"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  const output = `${result.stderr ?? ""}\n${result.stdout ?? ""}`.trim();
  return output || undefined;
}

function collectInstalledExtensions(extensionsDir: string | null): InstalledExtensionEvidence[] {
  if (!extensionsDir || !fs.existsSync(extensionsDir)) return [];

  const extensions: InstalledExtensionEvidence[] = [];
  for (const entry of fs.readdirSync(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const packagePath = path.join(extensionsDir, entry.name, "package.json");
    const metadata = readJsonFile<{
      publisher?: string;
      name?: string;
      version?: string;
    }>(packagePath);
    if (!metadata?.publisher || !metadata.name) continue;
    extensions.push({
      id: `${metadata.publisher}.${metadata.name}`,
      version: metadata.version,
    });
  }
  return extensions.sort((left, right) => left.id.localeCompare(right.id));
}

function collectBundledArtifacts(extensionsDir: string | null): string[] {
  if (!extensionsDir) return [];

  return listFiles(
    extensionsDir,
    (filePath) => /(?:^|[\\/])(?:lombok-[^\\/]+\.jar|org\.eclipse\.jdt(?:\.ls)?\.core_[^\\/]+\.jar)$/i.test(filePath),
  )
    .map((filePath) => path.basename(filePath))
    .sort();
}

function normalizeSignature(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, MAX_SIGNATURE_LENGTH);
}

export function extractFailureSignatures(texts: string[]): string[] {
  const signatures = new Set<string>();
  const patterns = [
    /Lombok can't parse this source:[^\r\n]*/gi,
    /(?:java\.)?[\w.$]*(?:Error|Exception):[^\r\n]*/g,
    /Internal compiler error:[^\r\n]*/gi,
  ];

  for (const text of texts) {
    for (const pattern of patterns) {
      pattern.lastIndex = 0;
      for (const match of text.matchAll(pattern)) {
        const signature = normalizeSignature(match[0]);
        if (signature) signatures.add(signature);
      }
    }
  }
  return [...signatures];
}

export class EvidenceCollector {
  constructor(
    private readonly driver: VscodeDriver,
    private readonly outputDir: string | null,
  ) {}

  async captureFailureEvidence(stepId: string): Promise<FailureEvidence> {
    const collectionErrors: string[] = [];
    try {
      await this.driver.refreshProbeSnapshot();
    } catch (e) {
      collectionErrors.push(`Probe refresh failed: ${(e as Error).message}`);
    }

    const probePath = this.driver.getProbeSnapshotPath();
    const probe = readJsonFile<ProbeSnapshot>(probePath);
    if (!probe) {
      collectionErrors.push(`Probe snapshot is unavailable or invalid${probePath ? `: ${probePath}` : ""}`);
    }
    let problemCounts: FailureEvidence["problemCounts"];
    try {
      problemCounts = await this.driver.getProblemsCount();
    } catch (e) {
      collectionErrors.push(`Problems count collection failed: ${(e as Error).message}`);
    }
    const diagnostics = probe?.diagnostics ?? [];
    let visibleProblems: Diagnostic[] = [];
    if (diagnostics.length === 0) {
      try {
        visibleProblems = await this.driver.getProblems();
      } catch (e) {
        collectionErrors.push(`Visible Problems collection failed: ${(e as Error).message}`);
      }
    }
    const evidence = sanitizeEvidence<FailureEvidence>({
      capturedAt: new Date().toISOString(),
      ...(collectionErrors.length > 0 ? { collectionErrors } : {}),
      problemCounts,
      diagnostics,
      ...(visibleProblems.length > 0 ? { visibleProblems } : {}),
      ...(probe?.activeEditor ? { activeEditor: probe.activeEditor } : {}),
      signatures: extractFailureSignatures([
        ...diagnostics.map((diagnostic) => diagnostic.message),
        ...visibleProblems.map((diagnostic) => diagnostic.message),
      ]),
    });

    if (this.outputDir) {
      const diagnosticsDir = path.join(this.outputDir, "evidence", "diagnostics");
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      const safeStepId = stepId.replace(/[^a-z0-9-]+/gi, "-");
      writeEvidenceJson(
        path.join(diagnosticsDir, `${safeStepId}-evidence.json`),
        evidence,
      );
    }
    return evidence;
  }

  collectRunEvidence(additionalErrors: string[] = []): RunEvidence {
    const collectionErrors = [...additionalErrors];
    const userDataDir = this.driver.getUserDataDir();
    const extensionsDir = this.driver.getExtensionsDir();
    const probePath = this.driver.getProbeSnapshotPath();
    const probe = readJsonFile<ProbeSnapshot>(probePath);
    if (!probe) {
      collectionErrors.push(`Probe snapshot is unavailable or invalid${probePath ? `: ${probePath}` : ""}`);
    }
    const logs = this.collectJdtLogs(userDataDir);
    const installedExtensions = probe?.extensions?.length
      ? probe.extensions
      : collectInstalledExtensions(extensionsDir);
    const bundledArtifacts = collectBundledArtifacts(extensionsDir);
    const signatures = extractFailureSignatures([
      ...(probe?.diagnostics.map((diagnostic) => diagnostic.message) ?? []),
      ...logs.map((log) => log.tail),
    ]);

    const evidence = sanitizeEvidence<RunEvidence>({
      capturedAt: new Date().toISOString(),
      ...(collectionErrors.length > 0
        ? { collectionErrors: [...new Set(collectionErrors)] }
        : {}),
      environment: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        javaHome: process.env.JAVA_HOME,
        javaVersion: readJavaVersion(),
        autoTestVersion: readAutoTestVersion(),
        githubRunId: process.env.GITHUB_RUN_ID,
        githubJob: process.env.GITHUB_JOB,
        runnerOs: process.env.RUNNER_OS,
        vscode: probe?.vscode,
      },
      installedExtensions,
      bundledArtifacts,
      logs,
      signatures,
    });

    if (this.outputDir) {
      const evidenceDir = path.join(this.outputDir, "evidence");
      fs.mkdirSync(evidenceDir, { recursive: true });
      writeEvidenceJson(path.join(evidenceDir, "environment.json"), evidence);
      if (probe) {
        writeEvidenceJson(path.join(evidenceDir, "probe-final.json"), probe);
      }
    }
    return evidence;
  }

  writeBundle(
    plan: TestPlan,
    results: StepResult[],
    runEvidence: RunEvidence | undefined,
    crashed: boolean,
  ): string | undefined {
    if (!this.outputDir) return undefined;

    const evidenceDir = path.join(this.outputDir, "evidence");
    fs.mkdirSync(evidenceDir, { recursive: true });
    const scenarioPath = path.join(evidenceDir, "scenario.json");
    const executionPath = path.join(evidenceDir, "execution.json");
    writeEvidenceJson(scenarioPath, plan);
    writeEvidenceJson(executionPath, { results });

    const artifacts: EvidenceArtifact[] = [
      this.createArtifact("scenario", scenarioPath),
      this.createArtifact("execution", executionPath),
    ];
    const environmentPath = path.join(evidenceDir, "environment.json");
    if (fs.existsSync(environmentPath)) {
      artifacts.push(this.createArtifact("environment", environmentPath));
    }
    const probePath = path.join(evidenceDir, "probe-final.json");
    if (fs.existsSync(probePath)) {
      artifacts.push(this.createArtifact("probe", probePath));
    }

    const diagnosticsDir = path.join(evidenceDir, "diagnostics");
    if (fs.existsSync(diagnosticsDir)) {
      for (const fileName of fs.readdirSync(diagnosticsDir).sort()) {
        const artifactPath = path.join(diagnosticsDir, fileName);
        if (fs.statSync(artifactPath).isFile()) {
          artifacts.push(this.createArtifact("diagnostics", artifactPath, undefined, {
            stepId: fileName.replace(/-evidence\.json$/i, ""),
          }));
        }
      }
    }
    for (const log of runEvidence?.logs ?? []) {
      if (!log.artifactPath) continue;
      const artifactPath = path.join(this.outputDir, log.artifactPath);
      if (fs.existsSync(artifactPath)) {
        artifacts.push(this.createArtifact("log", artifactPath, log.kind));
      }
    }

    const screenshotDir = path.join(this.outputDir, "screenshots");
    if (fs.existsSync(screenshotDir)) {
      for (const fileName of fs.readdirSync(screenshotDir).filter((name) => name.endsWith(".png")).sort()) {
        const artifactPath = path.join(screenshotDir, fileName);
        const standardMatch = fileName.match(/^\d+_(.+)_(before|after|error)\.png$/);
        const subMatch = fileName.match(/^\d+_(.+)_sub_\d+_.+\.png$/);
        artifacts.push(this.createArtifact("screenshot", artifactPath, fileName, {
          ...(standardMatch ? {
            stepId: standardMatch[1],
            phase: standardMatch[2] as "before" | "after" | "error",
          } : subMatch ? {
            stepId: subMatch[1],
            phase: "sub" as const,
          } : {}),
        }));
      }
    }

    const collectionErrors = [
      ...(runEvidence?.collectionErrors ?? []),
      ...results.flatMap((result) => result.evidence?.collectionErrors ?? []),
    ];
    const hasFailures = results.some((result) => result.status === "fail" || result.status === "error");
    const manifest: EvidenceBundleManifest = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      planName: plan.name,
      declaredVerdict: crashed ? "crashed" : hasFailures ? "failed" : "passed",
      artifacts,
      ...(collectionErrors.length > 0
        ? { collectionErrors: [...new Set(collectionErrors)] }
        : {}),
    };
    const manifestPath = path.join(evidenceDir, "manifest.json");
    writeEvidenceJson(manifestPath, manifest);
    return portableRelativePath(this.outputDir, manifestPath);
  }

  private collectJdtLogs(userDataDir: string | null): EvidenceLog[] {
    if (!userDataDir) return [];

    const workspaceStorage = path.join(userDataDir, "User", "workspaceStorage");
    const logPaths = listFiles(workspaceStorage, (filePath) => {
      const normalized = filePath.replace(/\\/g, "/");
      return normalized.endsWith("/redhat.java/jdt_ws/.metadata/.log");
    });
    const logsDir = this.outputDir ? path.join(this.outputDir, "evidence", "logs") : null;
    if (logsDir) fs.mkdirSync(logsDir, { recursive: true });

    return logPaths.map((sourcePath, index) => {
      const artifactPath = logsDir
        ? path.join(logsDir, `jdtls-${index + 1}.log`)
        : undefined;
      const tail = readLogEvidence(sourcePath);
      if (artifactPath) {
        fs.writeFileSync(artifactPath, tail, "utf8");
      }
      return {
        kind: "jdtls" as const,
        sourcePath: portableRelativePath(userDataDir, sourcePath),
        artifactPath: artifactPath && this.outputDir
          ? portableRelativePath(this.outputDir, artifactPath)
          : undefined,
        sizeBytes: fs.statSync(sourcePath).size,
        tail,
      };
    });
  }

  private createArtifact(
    type: EvidenceArtifact["type"],
    artifactPath: string,
    label?: string,
    metadata: Pick<EvidenceArtifact, "stepId" | "phase"> = {},
  ): EvidenceArtifact {
    return {
      type,
      path: portableRelativePath(this.outputDir!, artifactPath),
      ...(label ? { label } : {}),
      ...metadata,
      sizeBytes: fs.statSync(artifactPath).size,
    };
  }
}
