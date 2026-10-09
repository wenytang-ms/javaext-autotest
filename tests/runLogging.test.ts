import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withRunLogging } from "../src/operators/runLogging.js";

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, writeFileSync: vi.fn(actual.writeFileSync) };
});

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-log-output-"));
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

function contents(directory = root): string {
  return fs.readFileSync(path.join(directory, "autotest.log"), "utf8");
}

describe("scoped console-file logging", () => {
  it("tees both streams, redacts split secrets and flushes the final partial line", async () => {
    const stdout = process.stdout.write;
    const stderr = process.stderr.write;
    await withRunLogging(root, async () => {
      process.stdout.write("api-key=");
      process.stdout.write("placeholder-log-secret\n");
      process.stderr.write("password=placeholder-password\n");
      process.stdout.write("last partial line");
    });
    expect(contents()).toBe("api-key=<redacted>\npassword=<redacted>\nlast partial line");
    expect(stdout).toHaveBeenCalledWith("api-key=", undefined, undefined);
    expect(stderr).toHaveBeenCalled();
    expect(process.stdout.write).toBe(stdout);
    expect(process.stderr.write).toBe(stderr);
  });

  it("keeps complete output rather than only a tail, including split UTF-8 buffers", async () => {
    const text = "complete-output\n".repeat(10_000);
    const unicode = Buffer.from("\u2603\n");
    await withRunLogging(root, async () => {
      process.stdout.write(text);
      process.stdout.write(unicode.subarray(0, 1));
      process.stdout.write(unicode.subarray(1));
    });
    expect(contents()).toBe(text + "\u2603\n");
  });

  it("isolates overlapping async runs and restores streams only after both finish", async () => {
    const stdout = process.stdout.write;
    const first = path.join(root, "first");
    const second = path.join(root, "second");
    let continueFirst!: () => void;
    const wait = new Promise<void>(resolve => { continueFirst = resolve; });
    const firstRun = withRunLogging(first, async () => {
      process.stdout.write("first-start\n");
      await wait;
      process.stdout.write("first-end\n");
    });
    await withRunLogging(second, async () => {
      process.stderr.write("second-only\n");
    });
    expect(process.stdout.write).not.toBe(stdout);
    continueFirst();
    await firstRun;
    expect(contents(first)).toBe("first-start\nfirst-end\n");
    expect(contents(second)).toBe("second-only\n");
    expect(process.stdout.write).toBe(stdout);
  });

  it("restores streams when the action throws", async () => {
    const stdout = process.stdout.write;
    await expect(withRunLogging(root, async () => {
      process.stderr.write("failing action\n");
      throw new Error("action failed");
    })).rejects.toThrow("action failed");
    expect(contents()).toBe("failing action\n");
    expect(process.stdout.write).toBe(stdout);
  });

  it("surfaces write failures after execution rather than interrupting test actions", async () => {
    const stdout = process.stdout.write;
    let actionFinished = false;
    vi.mocked(fs.writeFileSync).mockImplementationOnce(() => { throw new Error("disk write failed"); });
    await expect(withRunLogging(root, async () => {
      process.stdout.write("logged action\n");
      actionFinished = true;
    })).rejects.toThrow("Could not write AutoTest log");
    expect(actionFinished).toBe(true);
    expect(process.stdout.write).toBe(stdout);
  });

  it("clears only previous owned log files, preserving unrelated files", async () => {
    fs.writeFileSync(path.join(root, "runner-failure.log"), "stale failure");
    fs.writeFileSync(path.join(root, "vscode-2.log"), "stale component");
    fs.writeFileSync(path.join(root, "notes.txt"), "keep this");
    await withRunLogging(root, async () => { process.stdout.write("new run\n"); });
    expect(contents()).toBe("new run\n");
    expect(fs.existsSync(path.join(root, "runner-failure.log"))).toBe(false);
    expect(fs.existsSync(path.join(root, "vscode-2.log"))).toBe(false);
    expect(fs.readFileSync(path.join(root, "notes.txt"), "utf8")).toBe("keep this");
  });

  it("redacts quoted credentials without breaking log JSON syntax", async () => {
    await withRunLogging(root, async () => {
      process.stdout.write(JSON.stringify({
        authorization: "Bearer quoted-token-placeholder",
        password: 'quoted "password" placeholder',
        api_key: "quoted-api-placeholder",
      }) + "\n");
    });
    expect(JSON.parse(contents())).toEqual({
      authorization: "<redacted>", password: "<redacted>", api_key: "<redacted>",
    });
  });
});
