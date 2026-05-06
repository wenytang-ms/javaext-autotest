/**
 * Default timing constants shared across operator modules.
 *
 * Keep these in one place so behavior can be tuned without hunting through
 * verifier / runner / resolver source.
 */

/** Default `verify*` polling deadline when a step does not specify `timeout`. */
export const DEFAULT_VERIFY_TIMEOUT_S = 30;

/** Default deadline for tree-item / editor-tab presence checks. */
export const DEFAULT_TREE_ITEM_TIMEOUT_S = 15;

/** Default `waitForLanguageServer` timeout. */
export const DEFAULT_LANGUAGE_SERVER_TIMEOUT_MS = 120_000;

/** Default `waitForTestDiscovery` timeout. */
export const DEFAULT_TEST_DISCOVERY_TIMEOUT_MS = 300_000;

/** Standard polling cadence inside verifier loops. */
export const DEFAULT_POLL_INTERVAL_MS = 1000;

/** Slower polling cadence used when reading status-bar problems. */
export const PROBLEMS_POLL_INTERVAL_MS = 3000;
