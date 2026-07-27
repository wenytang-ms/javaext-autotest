import { afterEach, describe, expect, it, vi } from "vitest";
import type { Page } from "@playwright/test";
import { commandOperations } from "../src/drivers/operations/commandOperations.js";

describe("commandOperations terminal text", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reads each xterm buffer through a unique temporary selector", async () => {
    const attributes = [new Map<string, string>(), new Map<string, string>()];
    const terminals = attributes.map((values) => ({
      getAttribute: vi.fn((name: string) => values.get(name) ?? null),
      setAttribute: vi.fn((name: string, value: string) => values.set(name, value)),
      removeAttribute: vi.fn((name: string) => values.delete(name)),
    }));
    const getTerminalBuffer = vi.fn(async (selector: string) => [`buffer ${selector}`]);
    vi.stubGlobal("window", { driver: { getTerminalBuffer } });
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn().mockReturnValue(terminals),
    });

    const panel = {
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const terminalRows = {
      evaluateAll: vi.fn().mockResolvedValue([]),
    };
    const terminalWrappers = {
      count: vi.fn().mockResolvedValue(0),
    };
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === ".part.panel") {
          return { first: vi.fn().mockReturnValue(panel) };
        }
        if (selector === ".terminal-wrapper:visible") return terminalWrappers;
        return terminalRows;
      }),
      evaluate: vi.fn(async (callback: () => Promise<string[]>) => callback()),
      keyboard: { press: vi.fn() },
      waitForTimeout: vi.fn(),
    } as unknown as Page;

    const text = await commandOperations.getTerminalText.call({
      getPage: () => page,
      resolveWorkspacePlaceholders: (value: unknown) => value,
      assignKeybindingForCommand: vi.fn(),
    });

    expect(getTerminalBuffer).toHaveBeenNthCalledWith(
      1,
      '[data-autotest-terminal-index="0"]',
    );
    expect(getTerminalBuffer).toHaveBeenNthCalledWith(
      2,
      '[data-autotest-terminal-index="1"]',
    );
    expect(text).toContain('buffer [data-autotest-terminal-index="0"]');
    expect(text).toContain('buffer [data-autotest-terminal-index="1"]');
    expect(terminals[0].removeAttribute).toHaveBeenCalledWith("data-autotest-terminal-index");
    expect(terminals[1].removeAttribute).toHaveBeenCalledWith("data-autotest-terminal-index");
  });

  it("reads an xterm buffer directly when the smoke-test driver is unavailable", async () => {
    const terminal = {
      xterm: {
        buffer: {
          active: {
            length: 2,
            getLine: vi.fn((line: number) => ({
              translateToString: vi.fn().mockReturnValue(
                line === 0 ? "Executing task: gradle: tasks" : "BUILD SUCCESSFUL",
              ),
            })),
          },
        },
      },
    };
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn().mockReturnValue([terminal]),
    });

    const panel = {
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const terminalRows = {
      evaluateAll: vi.fn().mockResolvedValue([]),
    };
    const terminalWrappers = {
      count: vi.fn().mockResolvedValue(0),
    };
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === ".part.panel") {
          return { first: vi.fn().mockReturnValue(panel) };
        }
        if (selector === ".terminal-wrapper:visible") return terminalWrappers;
        return terminalRows;
      }),
      evaluate: vi.fn(async (callback: () => Promise<string[]>) => callback()),
      keyboard: { press: vi.fn() },
      waitForTimeout: vi.fn(),
    } as unknown as Page;

    const text = await commandOperations.getTerminalText.call({
      getPage: () => page,
      resolveWorkspacePlaceholders: (value: unknown) => value,
      assignKeybindingForCommand: vi.fn(),
    });

    expect(text).toContain("Executing task: gradle: tasks");
    expect(text).toContain("BUILD SUCCESSFUL");
  });

  it("opens the accessible terminal buffer when raw buffers are unavailable", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("document", {
      querySelectorAll: vi.fn().mockReturnValue([]),
    });

    const panel = {
      isVisible: vi.fn().mockResolvedValue(true),
    };
    const terminalRows = {
      evaluateAll: vi.fn().mockResolvedValue([]),
    };
    const terminalWrapper = {
      ariaSnapshot: vi.fn().mockResolvedValue(
        "- textbox: \"Use Alt+F1 for terminal accessibility help\"",
      ),
    };
    const terminalWrappers = {
      count: vi.fn().mockResolvedValue(1),
      nth: vi.fn().mockReturnValue(terminalWrapper),
    };
    const accessibleView = {
      waitFor: vi.fn().mockResolvedValue(undefined),
      locator: vi.fn().mockReturnValue({
        innerText: vi.fn().mockResolvedValue(
          "Tasks runnable from root project 'gradle'",
        ),
      }),
      innerText: vi.fn(),
    };
    const assignKeybindingForCommand = vi.fn().mockResolvedValue("Control+Alt+F2");
    const press = vi.fn();
    const page = {
      locator: vi.fn((selector: string) => {
        if (selector === ".part.panel") {
          return { first: vi.fn().mockReturnValue(panel) };
        }
        if (selector === ".terminal-wrapper:visible") return terminalWrappers;
        if (selector === ".accessible-view:visible") {
          return { first: vi.fn().mockReturnValue(accessibleView) };
        }
        return terminalRows;
      }),
      evaluate: vi.fn(async (callback: () => Promise<string[]>) => callback()),
      keyboard: { press },
      waitForTimeout: vi.fn().mockResolvedValue(undefined),
    } as unknown as Page;

    const text = await commandOperations.getTerminalText.call({
      getPage: () => page,
      resolveWorkspacePlaceholders: (value: unknown) => value,
      assignKeybindingForCommand,
    });

    expect(text).toContain("Tasks runnable from root project 'gradle'");
    expect(assignKeybindingForCommand).toHaveBeenCalledWith(
      "workbench.action.terminal.focusAccessibleBuffer",
      [],
    );
    expect(press).toHaveBeenNthCalledWith(1, "Control+Alt+F2");
    expect(press).toHaveBeenNthCalledWith(2, "Escape");
  });
});
