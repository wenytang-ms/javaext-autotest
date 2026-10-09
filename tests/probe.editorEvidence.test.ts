import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vm from "node:vm";
import { fileURLToPath } from "node:url";
import type { ProbeSnapshot } from "../src/types.js";

const source = fs.readFileSync(fileURLToPath(new URL("../probe-extension/extension.cjs", import.meta.url)), "utf8");

function snapshot(buffer: string, disk: string, options: { large?: boolean; missing?: boolean; scheme?: string } = {}) {
  const read = vi.fn(() => {
    if (options.missing) throw new Error("ENOENT: document removed");
    return disk;
  });
  const context = {
    module: { exports: {} }, process, setTimeout, clearTimeout,
    require: (name: string) => name === "node:fs" ? {
      statSync: () => ({ size: options.large ? 300_000 : disk.length }),
      readFileSync: read,
    } : name === "node:path" ? path : {
      languages: { getDiagnostics: () => [] }, extensions: { all: [] },
      workspace: { workspaceFolders: [] },
      env: { appName: "Code", appHost: "desktop", uiKind: 1 }, version: "test",
      window: { activeTextEditor: {
        selection: { active: { line: 1, character: 4 } },
        document: {
          uri: { scheme: options.scheme ?? "file", fsPath: "probe.java", toString: () => "file:///probe.java" },
          languageId: "java", isDirty: buffer !== disk, version: 7, getText: () => buffer,
        },
      } },
    },
  };
  const result: ProbeSnapshot = vm.runInNewContext(`${source}\ncreateSnapshot();`, context);
  return { editor: result.activeEditor!, read };
}

describe("probe editor/disk evidence", () => {
  it("records dirty buffers, disk differences and exact cursor position without changing the document", () => {
    const { editor } = snapshot("class Probe {\nold buffer\n}", "class Probe {\nString probe = StringUtils.cap;\n}");
    expect(editor).toMatchObject({
      isDirty: true, documentVersion: 7, position: { line: 2, character: 5 }, diskMatchesBuffer: false,
    });
    expect(editor.bufferExcerpt).toContain("old buffer");
    expect(editor.diskExcerpt).toContain("StringUtils.cap");
  });

  it("records matching saved text and bounds excerpts", () => {
    const text = "a".repeat(10_000);
    const { editor } = snapshot(text, text);
    expect(editor.diskMatchesBuffer).toBe(true);
    expect(editor.bufferExcerpt!.length).toBeLessThanOrEqual(4096);
    expect(editor.diskExcerpt!.length).toBeLessThanOrEqual(4096);
  });

  it.each([{ large: true }, { missing: true }])("records unavailable disk evidence explicitly (%j)", options => {
    const { editor } = snapshot("buffer", "disk", options);
    expect(editor.diskReadError).toBeTruthy();
    expect(editor.diskMatchesBuffer).toBeUndefined();
  });

  it("does not read disk for untitled documents", () => {
    const { editor, read } = snapshot("buffer", "", { scheme: "untitled" });
    expect(read).not.toHaveBeenCalled();
    expect(editor.diskMatchesBuffer).toBeUndefined();
  });
});
