/**
 * Transaction Lifecycle Tests
 * ===========================
 * Ensures broadcast transactions are not reported as successful until CCC
 * returns a committed transaction response.
 */

import { describe, expect, test, vi } from "vitest";

import {
  areTransactionControlsLocked,
  CONCURRENT_TRANSACTION_MESSAGE,
  ConcurrentTransactionError,
  createContextAwareRequestGate,
  createTransactionExclusionGuard,
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

describe("transaction exclusion guard", () => {
  test("locks controls on any in-flight transaction regardless of its scope", () => {
    // The disabling signal is deliberately scope-blind; only rendering is scoped.
    expect(
      areTransactionControlsLocked({ status: "confirming" })
    ).toBe(true);
    expect(areTransactionControlsLocked({ status: "idle" })).toBe(false);
    expect(areTransactionControlsLocked({ status: "success" })).toBe(false);
    expect(areTransactionControlsLocked({ status: "error" })).toBe(false);
    expect(areTransactionControlsLocked({ status: "success" }, true)).toBe(true);
  });

  test("rejects a second action started while another is still running", async () => {
    const guard = createTransactionExclusionGuard();
    const pending = deferred<string>();
    const first = guard.guard(async () => pending.promise);
    const second = guard.guard(async () => "second");

    const firstRun = first();
    await Promise.resolve();
    expect(guard.isHeld()).toBe(true);

    await expect(second()).rejects.toThrow(ConcurrentTransactionError);
    await expect(second()).rejects.toThrow(CONCURRENT_TRANSACTION_MESSAGE);

    pending.resolve("first");
    await expect(firstRun).resolves.toBe("first");
    expect(guard.isHeld()).toBe(false);
  });

  test("releases the guard after success and after a thrown builder error", async () => {
    const guard = createTransactionExclusionGuard();

    await expect(guard.guard(async () => "ok")()).resolves.toBe("ok");
    expect(guard.isHeld()).toBe(false);

    const failing = guard.guard(async () => {
      throw new Error("wallet signing rejected");
    });
    await expect(failing()).rejects.toThrow("wallet signing rejected");
    expect(guard.isHeld()).toBe(false);

    // A released guard admits the next action; a canceled prompt is recoverable.
    await expect(guard.guard(async () => "next")()).resolves.toBe("next");
  });

  test("holds across a multi-transaction run until the whole sequence ends", async () => {
    const guard = createTransactionExclusionGuard();
    const steps = [deferred<void>(), deferred<void>(), deferred<void>()];
    const heldDuringRun: boolean[] = [];

    // Stands in for a bounded maintenance run: one guarded call, N signed batches.
    const batch = guard.guard(async () => {
      for (const step of steps) {
        await step.promise;
        heldDuringRun.push(guard.isHeld());
      }
      return steps.length;
    });
    const other = guard.guard(async () => "other");

    const run = batch();
    await Promise.resolve();

    for (const step of steps) {
      // No other action may start between lane signatures.
      await expect(other()).rejects.toThrow(ConcurrentTransactionError);
      step.resolve();
      await Promise.resolve();
    }

    await expect(run).resolves.toBe(3);
    expect(heldDuringRun).toEqual([true, true, true]);
    expect(guard.isHeld()).toBe(false);
    await expect(other()).resolves.toBe("other");
  });

  test("releases the guard when a mid-batch transaction throws", async () => {
    const guard = createTransactionExclusionGuard();
    const partialBatch = guard.guard(async () => {
      throw new Error("finalized 2 of 8 lanes; rerun to continue");
    });

    await expect(partialBatch()).rejects.toThrow("finalized 2 of 8 lanes");
    expect(guard.isHeld()).toBe(false);
  });
});

describe("context-aware request gate", () => {
  test("coalesces concurrent requests for the same context", async () => {
    const gate = createContextAwareRequestGate<string>((left, right) => left === right);
    const pending = deferred<void>();
    const request = vi.fn(() => pending.promise);

    const first = gate.run("anonymous", request);
    const second = gate.run("anonymous", request);

    expect(second).toBe(first);
    expect(request).toHaveBeenCalledOnce();

    pending.resolve();
    await expect(first).resolves.toBeUndefined();
  });

  test("runs a changed wallet context after the active request", async () => {
    const gate = createContextAwareRequestGate<string>((left, right) => left === right);
    const anonymous = deferred<void>();
    const executionOrder: string[] = [];

    const first = gate.run("anonymous", async () => {
      executionOrder.push("anonymous:start");
      await anonymous.promise;
      executionOrder.push("anonymous:end");
    });
    const connected = gate.run("wallet-a", async () => {
      executionOrder.push("wallet-a");
    });

    expect(executionOrder).toEqual(["anonymous:start"]);
    anonymous.resolve();
    await Promise.all([first, connected]);
    expect(executionOrder).toEqual(["anonymous:start", "anonymous:end", "wallet-a"]);
  });

  test("still runs a changed context after the active request rejects", async () => {
    const gate = createContextAwareRequestGate<string>((left, right) => left === right);
    const failed = deferred<void>();
    const connectedRequest = vi.fn(async () => undefined);

    const first = gate.run("anonymous", () => failed.promise);
    const connected = gate.run("wallet-a", connectedRequest);
    failed.reject(new Error("anonymous scan failed"));

    await expect(first).rejects.toThrow("anonymous scan failed");
    await expect(connected).resolves.toBeUndefined();
    expect(connectedRequest).toHaveBeenCalledOnce();
  });
});
