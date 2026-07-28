/**
 * Transaction Lifecycle Tests
 * ===========================
 * Ensures broadcast transactions are not reported as successful until CCC
 * returns a committed transaction response.
 */

import { describe, expect, test, vi } from "vitest";

import {
  isTransactionInFlight,
  monitorSubmittedTransaction,
  TX_CONFIRMATIONS,
  TX_CONFIRM_POLL_INTERVAL_MS,
  TX_CONFIRM_TIMEOUT_MS,
  waitForCommittedTransaction,
} from "./txLifecycle";

const TX_HASH = `0x${"ab".repeat(32)}`;

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("transaction lifecycle", () => {
  test("identifies every state that must lock competing transaction actions", () => {
    expect(
      (["building", "signing", "sending", "confirming"] as const).every((status) =>
        isTransactionInFlight(status)
      )
    ).toBe(true);
    expect(
      (["idle", "unconfirmed", "success", "error"] as const).some((status) =>
        isTransactionInFlight(status)
      )
    ).toBe(false);
  });

  test("waits for a committed response with the frontend confirmation policy", async () => {
    const waitTransaction = vi.fn(async () => ({ blockNumber: 42n, status: "committed" }));

    await waitForCommittedTransaction({ waitTransaction }, TX_HASH);

    expect(waitTransaction).toHaveBeenCalledWith(
      TX_HASH,
      TX_CONFIRMATIONS,
      TX_CONFIRM_TIMEOUT_MS,
      TX_CONFIRM_POLL_INTERVAL_MS
    );
  });

  test("does not report success while the committed-state wait is pending", async () => {
    const pending = deferred<unknown>();
    const onCommitted = vi.fn();
    const onUnconfirmed = vi.fn();
    const monitored = monitorSubmittedTransaction({
      client: { waitTransaction: vi.fn(() => pending.promise) },
      txHash: TX_HASH,
      onCommitted,
      onUnconfirmed,
    });

    await Promise.resolve();
    expect(onCommitted).not.toHaveBeenCalled();
    expect(onUnconfirmed).not.toHaveBeenCalled();

    pending.resolve({ blockNumber: 42n, status: "committed" });
    await expect(monitored).resolves.toBe("committed");
    expect(onCommitted).toHaveBeenCalledOnce();
    expect(onUnconfirmed).not.toHaveBeenCalled();
  });

  test("reports a timeout as unconfirmed and never as committed", async () => {
    const timeout = new Error("Transaction confirmation timed out");
    const onCommitted = vi.fn();
    const onUnconfirmed = vi.fn();

    await expect(monitorSubmittedTransaction({
      client: { waitTransaction: vi.fn(async () => { throw timeout; }) },
      txHash: TX_HASH,
      onCommitted,
      onUnconfirmed,
    })).resolves.toBe("unconfirmed");

    expect(onCommitted).not.toHaveBeenCalled();
    expect(onUnconfirmed).toHaveBeenCalledWith(timeout);
  });

  test("treats an empty wait result as unconfirmed", async () => {
    const onCommitted = vi.fn();
    const onUnconfirmed = vi.fn();

    await expect(monitorSubmittedTransaction({
      client: { waitTransaction: vi.fn(async () => undefined) },
      txHash: TX_HASH,
      onCommitted,
      onUnconfirmed,
    })).resolves.toBe("unconfirmed");

    expect(onCommitted).not.toHaveBeenCalled();
    expect(onUnconfirmed).toHaveBeenCalledOnce();
  });
});
