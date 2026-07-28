/** Deployment transaction confirmation tests. */

import { describe, expect, test, vi } from "vitest";

import {
  DEPLOY_TX_POLL_INTERVAL_MS,
  DEPLOY_TX_TIMEOUT_MS,
  waitForCommittedTransaction,
  waitForTransactionConfirmations,
} from "./tx-lifecycle";

const TX_HASH = `0x${"ab".repeat(32)}`;

describe("deployment transaction lifecycle", () => {
  test("waits for a committed response", async () => {
    const waitTransaction = vi.fn(async () => ({ status: "committed" }));

    await waitForCommittedTransaction({ waitTransaction }, TX_HASH);

    expect(waitTransaction).toHaveBeenCalledWith(
      TX_HASH,
      0,
      DEPLOY_TX_TIMEOUT_MS,
      DEPLOY_TX_POLL_INTERVAL_MS
    );
  });

  test("rejects an empty wait result", async () => {
    await expect(waitForCommittedTransaction({
      waitTransaction: vi.fn(async () => undefined),
    }, TX_HASH)).rejects.toThrow("Timed out waiting for committed transaction");
  });

  test("propagates node rejection and timeout errors", async () => {
    const rejection = new Error("transaction rejected");
    await expect(waitForCommittedTransaction({
      waitTransaction: vi.fn(async () => { throw rejection; }),
    }, TX_HASH)).rejects.toBe(rejection);
  });

  test("retries transient RPC failures without rebroadcasting", async () => {
    const committed = { status: "committed", blockNumber: 42 };
    const waitTransaction = vi.fn()
      .mockRejectedValueOnce(new Error("fetch failed"))
      .mockResolvedValueOnce(committed);
    const onTransientRetry = vi.fn();

    await expect(waitForTransactionConfirmations(
      { waitTransaction },
      TX_HASH,
      { onTransientRetry }
    )).resolves.toBe(committed);

    expect(waitTransaction).toHaveBeenCalledTimes(2);
    expect(onTransientRetry).toHaveBeenCalledWith(1, 4, expect.any(Error));
  });

  test("reports an unknown status after exhausting transient retries", async () => {
    const waitTransaction = vi.fn(async () => {
      throw new Error("connect ETIMEDOUT");
    });

    await expect(waitForTransactionConfirmations(
      { waitTransaction },
      TX_HASH,
      { transientRetries: 1 }
    )).rejects.toThrow(
      "was broadcast, but confirmation status is unknown after transient RPC failures"
    );

    expect(waitTransaction).toHaveBeenCalledTimes(2);
  });
});
