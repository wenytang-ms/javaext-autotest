import { describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { debugOperations } from "../src/drivers/operations/debugOperations.js";

function createReader(panelVisible = false) {
  const originalSource = "package demo;\n\nclass App {}\n";
  const editor = { text: originalSource };
  const panel = {
    isVisible: vi.fn(async () => panelVisible),
    waitFor: vi.fn(async () => {
      if (!panelVisible) throw new Error("Output panel did not become visible");
    }),
  };
  const outputTab = {
    first: vi.fn().mockReturnThis(),
    filter: vi.fn().mockReturnThis(),
    click: vi.fn().mockResolvedValue(undefined),
  };
  const dropdown = {
    count: vi.fn().mockResolvedValue(1),
    selectOption: vi.fn().mockResolvedValue(undefined),
  };
  const lines = {
    textContent: vi.fn().mockResolvedValue("REOPEN_INSERTION_CONFIRMED"),
  };
  const page = {
    locator: vi.fn((selector: string) => {
      if (selector === ".part.panel") return { first: () => panel };
      if (selector === ".part.panel select.monaco-select-box") {
        return { first: () => dropdown };
      }
      if (selector === ".part.panel .monaco-editor .view-lines") {
        return { first: () => lines };
      }
      return outputTab;
    }),
    keyboard: {
      press: vi.fn(async (key: string) => {
        if (key === "Control+j") editor.text = editor.text.replace("\n", "");
      }),
    },
    waitForTimeout: vi.fn().mockResolvedValue(undefined),
  } as unknown as Page;
  const runCommandFromPalette = vi.fn(async (label: string) => {
    if (label !== "View: Toggle Output") throw new Error(`Unexpected command: ${label}`);
    panelVisible = true;
  });
  const context = {
    getPage: () => page,
    getProblemsCount: vi.fn(),
    goToLine: vi.fn(),
    runCommandFromPalette,
  };

  return { context, editor, originalSource, panel, dropdown, lines };
}

describe("debugOperations output channel", () => {
  it("opens hidden Output without joining lines in the active macOS editor", async () => {
    const reader = createReader();

    const text = await debugOperations.getOutputChannelText.call(reader.context, "Java 27 AutoTest");

    expect(reader.editor.text).toBe(reader.originalSource);
    expect(text).toBe("REOPEN_INSERTION_CONFIRMED");
    expect(reader.context.runCommandFromPalette).toHaveBeenCalledTimes(1);
    expect(reader.dropdown.selectOption).toHaveBeenCalledWith({ label: "Java 27 AutoTest" });
  });

  it("reads the selected channel without toggling an already visible panel", async () => {
    const reader = createReader(true);

    const text = await debugOperations.getOutputChannelText.call(reader.context, "Java 27 AutoTest");

    expect(text).toBe("REOPEN_INSERTION_CONFIRMED");
    expect(reader.context.runCommandFromPalette).not.toHaveBeenCalled();
    expect(reader.editor.text).toBe(reader.originalSource);
    expect(reader.dropdown.selectOption).toHaveBeenCalledWith({ label: "Java 27 AutoTest" });
  });

  it("fails explicitly if the Output panel does not become visible", async () => {
    const reader = createReader();
    reader.context.runCommandFromPalette.mockResolvedValue(undefined);

    await expect(
      debugOperations.getOutputChannelText.call(reader.context, "Java 27 AutoTest"),
    ).rejects.toThrow("Output panel did not become visible");
    expect(reader.lines.textContent).not.toHaveBeenCalled();
  });
});
