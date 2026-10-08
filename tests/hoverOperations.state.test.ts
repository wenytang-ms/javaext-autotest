import { afterEach, describe, expect, it, vi } from "vitest";
import { observeHoverAction } from "../src/drivers/operations/hoverOperations.js";

afterEach(() => vi.unstubAllGlobals());

function element(text: string, visible = true, disabled = false) {
  return {
    textContent: text,
    getBoundingClientRect: () => ({ width: visible ? 100 : 0, height: 20 }),
    closest: () => disabled ? {} : null,
  };
}

function configure(actions: ReturnType<typeof element>[], contents: ReturnType<typeof element>[]) {
  let notify: (() => void) | undefined;
  const observe = vi.fn();
  const disconnect = vi.fn();
  vi.stubGlobal("MutationObserver", class {
    constructor(callback: () => void) { notify = callback; }
    observe = observe;
    disconnect = disconnect;
  });
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", display: "block" }));
  vi.stubGlobal("document", {
    body: {},
    querySelectorAll: (selector: string) => selector.includes(".action-label") ? actions : contents,
  });
  return {
    observe,
    disconnect,
    update(nextActions: typeof actions, nextContents: typeof contents) {
      actions = nextActions;
      contents = nextContents;
      if (!notify) throw new Error("Hover observer has not been attached");
      notify();
    },
  };
}

describe("hover action readiness", () => {
  it("does not treat a loading popup as readiness", () => {
    configure([], [element("Loading...")]);
    expect(observeHoverAction("Go to Super Implementation").read()).toBe(false);
  });

  it("requires a real action, not matching documentation text", () => {
    configure([], [element("Go to Super Implementation")]);
    expect(observeHoverAction("Go to Super Implementation").read()).toBe(false);
  });

  it("ignores hidden and disabled command links", () => {
    configure([
      element("Go to Super Implementation", false),
      element("Go to Super Implementation", true, true),
    ], [element("Loading...")]);
    expect(observeHoverAction("Go to Super Implementation").read()).toBe(false);
  });

  it("matches the exact normalized action label", () => {
    configure([element("  Go to  SUPER Implementation  ")], [element("greet()")]);
    expect(observeHoverAction("Go to Super Implementation").read()).toBe("ready");
    expect(observeHoverAction("Super Implementation").read()).toBe(false);
  });

  it("detects popup loss rather than reporting success", () => {
    const dom = configure([], [element("Loading...")]);
    const monitor = observeHoverAction("Go to Super Implementation");
    dom.update([], [element("Loading...", false)]);
    expect(monitor.read()).toBe("lost");
  });

  it("does not restore before the first popup has appeared", () => {
    configure([], []);
    const monitor = observeHoverAction("Go to Super Implementation");
    expect(monitor.opened).toBe(false);
    expect(monitor.read()).toBe(false);
  });

  it("retains a popup appearance and loss between driver polls", () => {
    const dom = configure([], []);
    const monitor = observeHoverAction("Go to Super Implementation");
    dom.update([], [element("Loading...")]);
    dom.update([], []);
    expect(monitor.opened).toBe(true);
    expect(monitor.read()).toBe("lost");
  });

  it("keeps waiting while an observed popup is still loading", () => {
    const dom = configure([], []);
    const monitor = observeHoverAction("Go to Super Implementation");
    dom.update([], [element("Loading...")]);
    expect(monitor.opened).toBe(true);
    expect(monitor.read()).toBe(false);
    dom.update([], [element("Searching...")]);
    expect(monitor.read()).toBe(false);
  });

  it("disconnects its observer when the operation ends", () => {
    const dom = configure([], []);
    const monitor = observeHoverAction("Go to Super Implementation");
    expect(dom.observe).toHaveBeenCalledOnce();
    monitor.disconnect();
    expect(dom.disconnect).toHaveBeenCalledOnce();
  });
});
