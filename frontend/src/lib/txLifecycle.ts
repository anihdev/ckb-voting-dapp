/**
 * Transaction confirmation helpers shared by governance action flows.
 * A broadcast transaction is successful only after CCC observes it committed.
 */

import type { TxState, TxStatus } from "./types";

export const TX_CONFIRMATIONS = 0;
export const TX_CONFIRM_TIMEOUT_MS = 180_000;
export const TX_CONFIRM_POLL_INTERVAL_MS = 3_000;

export function isTransactionInFlight(status: TxStatus): boolean {
  return status === "building" || status === "signing" || status === "sending" || status === "confirming";
}

/**
 * True while any surface has a transaction in flight.
 *
 * Deliberately scope-blind. Status *rendering* is scoped so one surface never
 * shows another's transaction, but state-changing *controls* must be disabled
 * everywhere: all governance actions fund from the same wallet change cell, and
 * the hook holds a single exclusion guard, so a control that stays enabled just
 * produces a rejected click. Read-only controls (expanding details, tabs,
 * copying IDs, the timeline picker) must not consult this.
 */
export function areTransactionControlsLocked(
  txState: Pick<TxState, "status">,
  actionInFlight = false
): boolean {
  return actionInFlight || isTransactionInFlight(txState.status);
}

export interface TransactionWaitClient {
  waitTransaction(
    txHash: string,
    confirmations?: number,
    timeout?: number,
    interval?: number
  ): Promise<unknown | undefined>;
}

export interface MonitorSubmittedTransactionParams {
  client: TransactionWaitClient;
  txHash: string;
  onCommitted: () => void | Promise<void>;
  onUnconfirmed: (error: Error) => void | Promise<void>;
}

export class TransactionUnconfirmedError extends Error {
  constructor(txHash: string) {
    super(`Transaction ${txHash} was broadcast, but commitment was not verified`);
    this.name = "TransactionUnconfirmedError";
  }
}

/**
 * Message shown when a second state-changing action is attempted while one is
 * already running. Every governance action funds itself from the same wallet
 * change cell, and any staged governance maintenance flow must hold the lock for
 * its whole sequence, so overlapping runs would double-spend the change cell
 * and clobber the tracked transaction.
 */
export const CONCURRENT_TRANSACTION_MESSAGE =
  "Another governance transaction is already in progress. Wait for it to finish or fail before starting another.";

export class ConcurrentTransactionError extends Error {
  constructor() {
    super(CONCURRENT_TRANSACTION_MESSAGE);
    this.name = "ConcurrentTransactionError";
  }
}

export interface TransactionExclusionGuard {
  /** True while a guarded action is running. */
  isHeld(): boolean;
  /** Wraps an action so only one guarded action can run at a time. */
  guard<A extends unknown[], R>(action: (...args: A) => Promise<R>): (...args: A) => Promise<R>;
}

/**
 * Mutual exclusion for state-changing governance actions.
 *
 * The flag is plain mutable state rather than React state because the check
 * must be atomic within a single tick: two clicks in the same frame would both
 * read a stale `false` from a state value that has not re-rendered yet. Any
 * staged governance maintenance flow holds the guard for its whole sequence,
 * and it is released on every exit path — success, rejection, confirmation
 * timeout, and thrown builder or signing errors — by the `finally`.
 */
export function createTransactionExclusionGuard(): TransactionExclusionGuard {
  let held = false;

  return {
    isHeld: () => held,
    guard<A extends unknown[], R>(action: (...args: A) => Promise<R>) {
      return async (...args: A): Promise<R> => {
        if (held) {
          throw new ConcurrentTransactionError();
        }
        held = true;
        try {
          return await action(...args);
        } finally {
          held = false;
        }
      };
    },
  };
}

export interface ContextAwareRequestGate<Context> {
  /** Coalesces equal requests and queues a fresh run when their context changes. */
  run(context: Context, request: () => Promise<void>): Promise<void>;
}

/**
 * Coordinates read requests whose result depends on a changing wallet context.
 *
 * Equal concurrent requests share one scan. A request for a different signer
 * waits for the active scan and then runs with its own context, so connecting or
 * switching wallets cannot be swallowed by an earlier anonymous refresh.
 */
export function createContextAwareRequestGate<Context>(
  isSameContext: (left: Context, right: Context) => boolean
): ContextAwareRequestGate<Context> {
  let active: { context: Context; promise: Promise<void> } | null = null;

  const run = (context: Context, request: () => Promise<void>): Promise<void> => {
    if (active) {
      if (isSameContext(active.context, context)) return active.promise;

      return active.promise.then(
        () => run(context, request),
        () => run(context, request)
      );
    }

    let trackedPromise: Promise<void>;
    trackedPromise = request().finally(() => {
      if (active?.promise === trackedPromise) active = null;
    });
    active = { context, promise: trackedPromise };
    return trackedPromise;
  };

  return { run };
}

function errorFrom(caught: unknown): Error {
  return caught instanceof Error ? caught : new Error(String(caught));
}

export async function waitForCommittedTransaction(
  client: TransactionWaitClient,
  txHash: string
): Promise<void> {
  const transaction = await client.waitTransaction(
    txHash,
    TX_CONFIRMATIONS,
    TX_CONFIRM_TIMEOUT_MS,
    TX_CONFIRM_POLL_INTERVAL_MS
  );

  if (!transaction) {
    throw new Error(`No committed transaction response was returned for ${txHash}`);
  }
}

export async function monitorSubmittedTransaction({
  client,
  txHash,
  onCommitted,
  onUnconfirmed,
}: MonitorSubmittedTransactionParams): Promise<"committed" | "unconfirmed"> {
  try {
    await waitForCommittedTransaction(client, txHash);
  } catch (caught) {
    await onUnconfirmed(errorFrom(caught));
    return "unconfirmed";
  }

  await onCommitted();
  return "committed";
}
