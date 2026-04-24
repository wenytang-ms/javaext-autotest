/**
 * Test Plan parser — loads and validates YAML test plans.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import yaml from "js-yaml";
import type { RepoClone, TestPlan, TestStep } from "../types.js";

export function loadTestPlan(filePath: string): TestPlan {
  const absolutePath = path.resolve(filePath);
  if (!fs.existsSync(absolutePath)) {
    throw new Error(`Test plan not found: ${absolutePath}`);
  }

  const planDir = path.dirname(absolutePath);
  const content = fs.readFileSync(absolutePath, "utf-8");
  const raw = yaml.load(content) as Record<string, unknown>;

  return validateTestPlan(raw, planDir);
}

function validateTestPlan(raw: Record<string, unknown>, planDir: string): TestPlan {
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error("Test plan must have a 'name' field");
  }

  if (!raw.setup || typeof raw.setup !== "object") {
    throw new Error("Test plan must have a 'setup' section");
  }

  const setup = raw.setup as Record<string, unknown>;
  if (!setup.extension || typeof setup.extension !== "string") {
    throw new Error("Test plan setup must specify an 'extension'");
  }

  if (!raw.steps || !Array.isArray(raw.steps) || raw.steps.length === 0) {
    throw new Error("Test plan must have at least one step");
  }

  const steps: TestStep[] = (raw.steps as Record<string, unknown>[]).map((step, index) => {
    if (!step.action || typeof step.action !== "string") {
      throw new Error(`Step ${index + 1} must have an 'action' field`);
    }
    return {
      id: (step.id as string) ?? `step-${index + 1}`,
      action: step.action as string,
      verify: step.verify as string | undefined,
      verifyFile: step.verifyFile as TestStep["verifyFile"],
      verifyNotification: step.verifyNotification as string | undefined,
      verifyEditor: step.verifyEditor as TestStep["verifyEditor"],
      verifyProblems: step.verifyProblems as TestStep["verifyProblems"],
      verifyCompletion: step.verifyCompletion as TestStep["verifyCompletion"],
      verifyDialog: step.verifyDialog as TestStep["verifyDialog"],
      verifyTreeItem: step.verifyTreeItem as TestStep["verifyTreeItem"],
      verifyEditorTab: step.verifyEditorTab as TestStep["verifyEditorTab"],
      timeout: step.timeout as number | undefined,
      waitBefore: step.waitBefore as number | undefined,
    };
  });

  return {
    name: raw.name as string,
    description: raw.description as string | undefined,
    setup: {
      extension: setup.extension as string,
      extensionPath: setup.extensionPath
        ? path.resolve(planDir, setup.extensionPath as string)
        : undefined,
      extensions: setup.extensions as string[] | undefined,
      vsix: Array.isArray(setup.vsix)
        ? (setup.vsix as string[]).map(v => path.resolve(planDir, v))
        : undefined,
      vscodeVersion: (setup.vscodeVersion as "stable" | "insiders") ?? "insiders",
      workspace: setup.workspace
        ? path.resolve(planDir, setup.workspace as string)
        : undefined,
      file: setup.file
        ? path.resolve(planDir, setup.file as string)
        : undefined,
      repos: parseRepos(setup.repos, planDir),
      settings: setup.settings as Record<string, unknown> | undefined,
      timeout: setup.timeout as number | undefined,
      workspaceTrust: parseWorkspaceTrust(setup.workspaceTrust),
    },
    steps,
  };
}

/** Validate test plan without loading — for CLI `validate` command */
export function validateTestPlanFile(filePath: string): { valid: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    loadTestPlan(filePath);
    return { valid: true, errors: [] };
  } catch (e) {
    errors.push((e as Error).message);
    return { valid: false, errors };
  }
}

function parseRepos(raw: unknown, planDir: string): RepoClone[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((r: Record<string, unknown>) => ({
    url: r.url as string,
    path: r.path ? path.resolve(planDir, r.path as string) : undefined,
    branch: r.branch as string | undefined,
  }));
}

function parseWorkspaceTrust(raw: unknown): "trusted" | "untrusted" | "disabled" | undefined {
  if (!raw) return undefined;
  const value = String(raw).toLowerCase();
  const valid = ["trusted", "untrusted", "disabled"];
  if (!valid.includes(value)) {
    throw new Error(`Invalid workspaceTrust value: "${raw}". Must be one of: ${valid.join(", ")}`);
  }
  return value as "trusted" | "untrusted" | "disabled";
}
