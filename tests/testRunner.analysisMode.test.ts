import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TestRunner } from "../src/operators/testRunner.js";
import type { TestPlan } from "../src/types.js";

const plan: TestPlan = {
  name: "Analysis mode gating",
  setup: {
    extension: "publisher.extension",
  },
  steps: [{
    id: "open",
    action: "open",
    target: "README.md",
  }],
};

describe("TestRunner analysis modes", () => {
  it("keeps evidence collection and the probe disabled by default", () => {
    const runner = new TestRunner(plan, { noLLM: true });

    expect(runner["analysisMode"]).toBe("legacy");
    expect(runner["evidenceCollector"]).toBeNull();
    expect(runner["driver"]["options"].enableEvidenceProbe).toBe(false);
  });

  it("enables evidence collection and the probe only for opt-in modes", () => {
    const caseRunner = new TestRunner(plan, {
      noLLM: true,
      analysisMode: "case",
    });
    const evidenceRunner = new TestRunner(plan, {
      analysisMode: "evidence-only",
    });

    expect(caseRunner["evidenceCollector"]).not.toBeNull();
    expect(caseRunner["driver"]["options"].enableEvidenceProbe).toBe(true);
    expect(evidenceRunner["evidenceCollector"]).not.toBeNull();
    expect(evidenceRunner["driver"]["options"].enableEvidenceProbe).toBe(true);
    expect(evidenceRunner["llm"]).toBeNull();
  });

  it("selects representative failure screenshots including an intermediate state", () => {
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), "autotest-case-screenshots-"));
    try {
      const screenshotDir = path.join(outputDir, "screenshots");
      fs.mkdirSync(screenshotDir);
      for (const fileName of [
        "01_open_before.png",
        "02_open_sub_01-menu.png",
        "03_open_error.png",
        "04_finish_before.png",
        "05_finish_after.png",
      ]) {
        fs.writeFileSync(path.join(screenshotDir, fileName), fileName);
      }
      const runner = new TestRunner(plan, {
        outputDir,
        noLLM: true,
        analysisMode: "case",
      });

      const screenshots = runner["collectCaseScreenshots"]([{
        stepId: "open",
        action: "open",
        status: "error",
        reason: "failed",
        duration: 10,
      }, {
        stepId: "finish",
        action: "wait",
        status: "pass",
        duration: 10,
      }]);

      expect(screenshots.map((screenshot) => screenshot.label)).toEqual([
        "01_open_before.png",
        "02_open_sub_01-menu.png",
        "03_open_error.png",
        "05_finish_after.png",
      ]);
    } finally {
      fs.rmSync(outputDir, { recursive: true, force: true });
    }
  });
});
