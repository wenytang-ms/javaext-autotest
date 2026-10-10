import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ArtifactCollectionManifest,
  ArtifactCollectionSummary,
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
  const redactValue = (_: string, prefix: string, secret: string): string => {
    const quote = secret.startsWith('"') || secret.startsWith("'") ? secret[0] : "";
    return `${prefix}${quote}<redacted>${quote}`;
  };
  return value
    .replace(/(authorization["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:(?:bearer|basic)\s+)?[^\s,;"'\\]+)/gi, redactValue)
    .replace(/((?:api[-_ ]?key|access[-_ ]?token|client[-_ ]?secret|password|credential)["']?\s*[:=]\s*)("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\s,;"'\\]+)/gi, redactValue)
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,})\b/g, "<redacted-token>")
    .replace(/(https?:\/\/[^:/\s]+:)[^@\s]+@/g, "$1<redacted>@")
    .replace(/([A-Za-z]:\\Users\\)[^\\\r\n"]+/g, "$1<user>")
    .replace(/(file:\/\/\/[A-Za-z](?::|%3A)\/Users\/)[^/\s"]+/gi, "$1<user>")
    .replace(/((?:file:\/\/)?\/(?:home|Users)\/)[^/\s"]+/g, "$1<user>");
}

export function sanitizeEvidence<T>(value: T): T {
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

export function formatErrorEvidence(error: unknown): string {
  let remainingEntries = 32;
  function details(value: unknown, level: number): unknown {
    if (level > 4) return "<cause depth limit>";
    if (remainingEntries-- <= 0) return "<error entry limit>";
    if (!value || typeof value !== "object") return String(value).slice(0, 32_768);
    const record = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const key of ["name", "message", "stack", "code", "statusCode", "status", "errno", "syscall", "hostname", "address", "port", "exitCode", "signal"]) {
      const entry = record[key];
      if (typeof entry === "string") result[key] = entry.slice(0, 32_768);
      else if (typeof entry === "number") result[key] = entry;
    }
    if (record.cause !== undefined) result.cause = details(record.cause, level + 1);
    if (Array.isArray(record.errors)) {
      result.errors = record.errors.slice(0, 8).map(entry => details(entry, level + 1));
      if (record.errors.length > 8) result.errorsTruncated = record.errors.length - 8;
    }
    return Object.keys(result).length ? result : { thrownValue: String(value) };
  }
  return JSON.stringify(sanitizeEvidence(details(error, 0)), null, 2).slice(0, MAX_LOG_TAIL_BYTES);
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

export function extractFailureSignatures(texts: string[], generic = false): string[] {
  const signatures = new Set<string>();
  const patterns = generic ? [/[\w.$]*(?:Error|Exception):[^\r\n]*/g] : [
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
  private runnerFailure: string | undefined;

  constructor(
    private readonly driver: VscodeDriver,
    private readonly outputDir: string | null,
    private readonly logDirectory?: string | null,
    private readonly genericArtifacts = false,
  ) {}

  recordRunnerFailure(error: unknown): void {
    this.runnerFailure = formatErrorEvidence(error);
  }

  resetRunnerFailure(): void {
    this.runnerFailure = undefined;
  }

  async captureFailureEvidence(stepId: string, attempt?: number): Promise<FailureEvidence> {
    if (attempt !== undefined && (!Number.isSafeInteger(attempt) || attempt < 1)) {
      throw new Error(`Invalid evidence attempt: ${attempt}`);
    }
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
      ], this.genericArtifacts),
    });

    if (this.outputDir) {
      const safeStepId = stepId.replace(/[^a-z0-9-]+/gi, "-");
      const stepKey = `${safeStepId.slice(0, 80)}-${createHash("sha256").update(stepId).digest("hex").slice(0, 12)}`;
      const diagnosticsDir = path.join(
        this.outputDir, "evidence", "diagnostics",
        ...(attempt === undefined ? [] : [stepKey]),
      );
      fs.mkdirSync(diagnosticsDir, { recursive: true });
      const artifactPath = path.join(
        diagnosticsDir,
        attempt === undefined ? `${safeStepId}-evidence.json` : `attempt-${attempt}.json`,
      );
      evidence.artifactPath = portableRelativePath(this.outputDir, artifactPath);
      writeEvidenceJson(artifactPath, evidence);
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
    const logs = [
      ...(this.genericArtifacts ? [] : this.collectJdtLogs(userDataDir)),
      ...(this.genericArtifacts ? [] : this.collectVscodeLogs(userDataDir, collectionErrors)),
      ...this.collectRunnerLogs(),
    ];
    const installedExtensions = probe?.extensions?.length
      ? probe.extensions
      : collectInstalledExtensions(extensionsDir);
    const bundledArtifacts = this.genericArtifacts ? [] : collectBundledArtifacts(extensionsDir);
    const signatures = extractFailureSignatures([
      ...(probe?.diagnostics.map((diagnostic) => diagnostic.message) ?? []),
      ...logs.map((log) => log.tail),
    ], this.genericArtifacts);

    const evidence = sanitizeEvidence<RunEvidence>({
      capturedAt: new Date().toISOString(),
      ...(collectionErrors.length > 0
        ? { collectionErrors: [...new Set(collectionErrors)] }
        : {}),
      environment: {
        platform: os.platform(),
        arch: os.arch(),
        nodeVersion: process.version,
        ...(this.genericArtifacts ? {} : { javaHome: process.env.JAVA_HOME, javaVersion: readJavaVersion() }),
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

  attachArtifacts(
    evidence: RunEvidence,
    manifest: ArtifactCollectionManifest,
    summary: ArtifactCollectionSummary,
    caseOutputDir: string,
  ): void {
    const queues = manifest.sources.map(source =>
      source.files.filter(file => file.evidence === "tail" && file.format === "text")
        .map(file => ({ sourceId: source.id, file })),
    );
    const files: Array<(typeof queues)[number][number]> = [];
    const longestQueue = queues.reduce((max, queue) => Math.max(max, queue.length), 0);
    for (let index = 0; index < longestQueue; index++) {
      for (const queue of queues) if (queue[index]) files.push(queue[index]);
    }
    const logs: EvidenceLog[] = [];
    let remainingBytes = 256 * 1024;
    for (const { sourceId, file } of files) {
      if (logs.length >= 20 || remainingBytes <= 0) break;
      try {
        const length = Math.min(file.storedBytes, MAX_LOG_TAIL_BYTES, remainingBytes);
        let tail = readFileRange(path.join(caseOutputDir, file.path), file.storedBytes - length, length);
        while (Buffer.byteLength(tail) > length) tail = tail.slice((tail.codePointAt(0) ?? 0) > 0xffff ? 2 : 1);
        remainingBytes -= Buffer.byteLength(tail);
        logs.push({
          kind: sourceId, sourcePath: file.sourcePath, artifactPath: file.path,
          sizeBytes: file.sizeBytes, tail,
          ...(length < file.storedBytes ? { tailTruncated: true } : {}),
        });
      } catch (error) {
        evidence.collectionErrors = [
          ...(evidence.collectionErrors ?? []),
          `Artifact evidence failed (${file.path}): ${(error as Error).message}`,
        ];
      }
    }
    evidence.logs.push(...logs);
    evidence.artifactCollection = summary;
    if (files.length > logs.length) evidence.artifactEvidenceOmitted = files.length - logs.length;
    evidence.collectionErrors = [...new Set([
      ...(evidence.collectionErrors ?? []), ...(summary.collectionErrors ?? []),
    ])];
    if (!evidence.collectionErrors.length) delete evidence.collectionErrors;
    evidence.signatures = [...new Set([
      ...evidence.signatures, ...extractFailureSignatures(logs.map(log => log.tail), this.genericArtifacts),
    ])];
    if (this.outputDir) writeEvidenceJson(path.join(this.outputDir, "evidence", "environment.json"), evidence);
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
    const stepArtifacts = new Map<string, Pick<EvidenceArtifact, "stepId" | "attempt" | "phase">>();
    for (const result of results) {
      const attempts = result.attempts?.length ? result.attempts : [result];
      for (const entry of attempts) {
        const metadata = {
          stepId: result.stepId,
          ...("attempt" in entry ? { attempt: entry.attempt } : {}),
        };
        if (entry.evidence?.artifactPath) {
          stepArtifacts.set(entry.evidence.artifactPath, metadata);
        }
        for (const screenshot of entry.screenshots ?? []) {
          stepArtifacts.set(screenshot.path, { ...metadata, phase: screenshot.phase });
        }
      }
    }
    if (fs.existsSync(diagnosticsDir)) {
      for (const artifactPath of listFiles(diagnosticsDir, (file) => file.endsWith(".json")).sort()) {
        const metadata = stepArtifacts.get(portableRelativePath(this.outputDir, artifactPath));
        artifacts.push(this.createArtifact("diagnostics", artifactPath, undefined, metadata ?? {
          stepId: path.basename(artifactPath).replace(/-evidence\.json$/i, ""),
        }));
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
        const standardMatch = fileName.match(/^\d+_(.+)_(before|after|verified|error)\.png$/);
        const subMatch = fileName.match(/^\d+_(.+)_sub_\d+_.+\.png$/);
        const metadata = stepArtifacts.get(portableRelativePath(this.outputDir, artifactPath));
        artifacts.push(this.createArtifact("screenshot", artifactPath, fileName, metadata ?? {
          ...(standardMatch ? {
            stepId: standardMatch[1],
            phase: standardMatch[2] as "before" | "after" | "verified" | "error",
          } : subMatch ? {
            stepId: subMatch[1],
            phase: "sub" as const,
          } : {}),
        }));
      }
    }

    const collectionErrors = [
      ...(runEvidence?.collectionErrors ?? []),
      ...results.flatMap((result) => [
        ...(result.collectionErrors ?? []),
        ...(result.evidence?.collectionErrors ?? []),
        ...(result.attempts ?? []).flatMap((attempt) => [
          ...(attempt.collectionErrors ?? []),
          ...(attempt.evidence?.collectionErrors ?? []),
        ]),
      ]),
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
      ...(runEvidence?.artifactCollection ? { artifactCollection: runEvidence.artifactCollection } : {}),
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
    return logPaths.map((sourcePath, index) => {
      const tail = readLogEvidence(sourcePath);
      return {
        kind: "jdtls" as const,
        sourcePath: portableRelativePath(userDataDir, sourcePath),
        artifactPath: this.writeLog(`jdtls-${index + 1}.log`, tail),
        sizeBytes: fs.statSync(sourcePath).size,
        tail,
      };
    });
  }

  private collectVscodeLogs(userDataDir: string | null, collectionErrors: string[]): EvidenceLog[] {
    if (!this.logDirectory || !userDataDir) return [];
    const paths = listFiles(path.join(userDataDir, "logs"), file => file.endsWith(".log")).sort().slice(-20);
    const logs: EvidenceLog[] = [];
    for (const [index, sourcePath] of paths.entries()) {
      try {
        const tail = readLogEvidence(sourcePath);
        logs.push({
          kind: "vscode",
          sourcePath: portableRelativePath(userDataDir, sourcePath),
          artifactPath: this.writeLog(`vscode-${index + 1}.log`, tail),
          sizeBytes: fs.statSync(sourcePath).size,
          tail,
        });
      } catch (error) {
        collectionErrors.push(`VS Code log collection failed (${sourcePath}): ${(error as Error).message}`);
      }
    }
    return logs;
  }

  private collectRunnerLogs(): EvidenceLog[] {
    if (!this.logDirectory) return [];
    const entries = [
      { kind: "runner-launch", text: JSON.stringify(sanitizeEvidence(this.driver.getLaunchDiagnostics()), null, 2) },
      ...(this.runnerFailure ? [{ kind: "runner-failure", text: this.runnerFailure }] : []),
    ];
    return entries.filter(entry => entry.text !== "[]").map(({ kind, text }) => ({
      kind, sourcePath: kind,
      artifactPath: this.writeLog(`${kind}.log`, text),
      sizeBytes: Buffer.byteLength(text), tail: text,
    }));
  }

  private writeLog(name: string, text: string): string | undefined {
    const evidenceDirectory = this.outputDir ? path.join(this.outputDir, "evidence", "logs") : null;
    for (const directory of new Set([evidenceDirectory, this.logDirectory])) {
      if (!directory) continue;
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(path.join(directory, name), text, "utf8");
    }
    return evidenceDirectory && this.outputDir
      ? portableRelativePath(this.outputDir, path.join(evidenceDirectory, name))
      : this.logDirectory ? name : undefined;
  }

  private createArtifact(
    type: EvidenceArtifact["type"],
    artifactPath: string,
    label?: string,
    metadata: Pick<EvidenceArtifact, "stepId" | "attempt" | "phase"> = {},
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
