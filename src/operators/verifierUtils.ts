import {
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_VERIFY_TIMEOUT_S,
} from "./defaults.js";
import type { TestStep } from "../types.js";

export type VerifyResult = { passed: boolean; reason?: string };

/**
 * Compute the polling deadline for a verifier loop.
 *
 * Uses `step.timeout` (seconds) if set, otherwise `DEFAULT_VERIFY_TIMEOUT_S`.
 */
export function computeDeadline(step: TestStep): number {
  return Date.now() + (step.timeout ?? DEFAULT_VERIFY_TIMEOUT_S) * 1000;
}

/**
 * Poll `check` repeatedly until it returns a passing result or the deadline expires.
 *
 * `check` returns one of:
 *   - `{ done: true, result }` — finalize and return `result`
 *   - `{ done: false }` — wait `pollIntervalMs` then retry
 *
 * If the deadline elapses without `done: true`, returns `onTimeout()`.
 */
export async function pollUntil<T>(
  step: TestStep,
  options: {
    check: () => Promise<{ done: true; result: T } | { done: false }>;
    onTimeout: () => Promise<T>;
    pollIntervalMs?: number;
    waitFn: (seconds: number) => Promise<void>;
  },
): Promise<T> {
  const deadline = computeDeadline(step);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  while (Date.now() < deadline) {
    const outcome = await options.check();
    if (outcome.done) return outcome.result;
    await options.waitFn(pollIntervalMs / 1000);
  }
  return options.onTimeout();
}
