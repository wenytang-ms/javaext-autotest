import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { sanitizeEvidence } from "./evidenceCollector.js";
import type { LoggingOptions } from "../types.js";

export function parseLoggingOptions(raw: unknown, baseDir = process.cwd()): LoggingOptions | undefined {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("logging must be an object with enabled and/or outputDir");
  }
  if ("enabled" in raw && raw.enabled !== undefined && typeof raw.enabled !== "boolean") {
    throw new Error("logging.enabled must be a boolean");
  }
  if ("outputDir" in raw && raw.outputDir !== undefined
    && (typeof raw.outputDir !== "string" || !raw.outputDir.trim())) {
    throw new Error("logging.outputDir must be a non-empty string");
  }
  const unknown = Object.keys(raw).find(key => key !== "enabled" && key !== "outputDir");
  if (unknown) throw new Error(`Unknown logging option: ${unknown}`);
  return {
    ...("enabled" in raw && typeof raw.enabled === "boolean" ? { enabled: raw.enabled } : {}),
    ...("outputDir" in raw && typeof raw.outputDir === "string"
      ? { outputDir: path.resolve(baseDir, raw.outputDir) } : {}),
  };
}

class LogSink {
  private descriptor: number;
  private decoder = new StringDecoder("utf8");
  private pending = "";
  private closed = false;
  private error: Error | undefined;

  constructor(private readonly filePath: string) {
    this.descriptor = fs.openSync(filePath, "wx", 0o600);
  }

  write(chunk: string | Uint8Array): void {
    if (this.closed || this.error) return;
    const text = typeof chunk === "string"
      ? chunk : this.decoder.write(Buffer.from(chunk));
    this.pending += text;
    const end = this.pending.lastIndexOf("\n");
    if (end >= 0) {
      this.persist(this.pending.slice(0, end + 1));
      this.pending = this.pending.slice(end + 1);
    }
    if (this.pending.length > 64 * 1024) {
      this.persist(this.pending);
      this.pending = "";
    }
  }

  private persist(text: string): void {
    if (this.error) return;
    try {
      fs.writeFileSync(this.descriptor, sanitizeEvidence(text), "utf8");
    } catch (cause) {
      this.error = new Error(`Could not write AutoTest log: ${this.filePath}`, { cause });
    }
  }

  close(): void {
    this.persist(this.pending + this.decoder.end());
    this.closed = true;
    fs.closeSync(this.descriptor);
    if (this.error) throw this.error;
  }
}

const logContext = new AsyncLocalStorage<LogSink>();
let activeCaptures = 0;
let restoreStreams: (() => void) | undefined;

function captureStream(stream: NodeJS.WriteStream): () => void {
  const original = stream.write;
  const write: typeof stream.write = function (
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean {
    const result = Reflect.apply(original, stream, [chunk, encodingOrCallback, callback]) as boolean;
    logContext.getStore()?.write(chunk);
    return result;
  };
  stream.write = write;
  return () => {
    if (stream.write === write) stream.write = original;
  };
}

export async function withRunLogging<T>(directory: string, action: () => Promise<T>): Promise<T> {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (/^(?:autotest\.log|environment\.json|runner-(?:launch|failure)\.log|(?:jdtls|vscode)-\d+\.log)$/.test(entry.name)) {
      if (!entry.isFile()) throw new Error(`Log output path is not a regular file: ${path.join(directory, entry.name)}`);
      fs.unlinkSync(path.join(directory, entry.name));
    }
  }
  const sink = new LogSink(path.join(directory, "autotest.log"));
  if (activeCaptures++ === 0) {
    const restoreStdout = captureStream(process.stdout);
    const restoreStderr = captureStream(process.stderr);
    restoreStreams = () => { restoreStdout(); restoreStderr(); };
  }
  try {
    return await logContext.run(sink, action);
  } finally {
    try {
      sink.close();
    } finally {
      if (--activeCaptures === 0) {
        restoreStreams?.();
        restoreStreams = undefined;
      }
    }
  }
}
