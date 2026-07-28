/**
 * Deployment Transaction Lifecycle
 * =================================
 * Shared confirmation policy for deployment, seeding, and role-funding tools.
 */

export const DEPLOY_TX_TIMEOUT_MS = 120_000;
export const DEPLOY_TX_POLL_INTERVAL_MS = 3_000;
export const DEPLOY_TX_TRANSIENT_RETRIES = 4;

export interface TransactionWaitClient {
  waitTransaction(
    txHash: string,
    confirmations?: number,
    timeout?: number,
    interval?: number
  ): Promise<unknown | undefined>;
}

export interface TransactionConfirmationOptions {
  confirmations?: number;
  timeoutMs?: number;
  pollIntervalMs?: number;
  transientRetries?: number;
  onTransientRetry?: (retry: number, maxRetries: number, error: unknown) => void;
}

function isTransientRpcError(error: unknown): boolean {
  const message = String((error as any)?.message ?? error).toLowerCase();
  return [
    "fetch failed",
    "etimedout",
    "eai_again",
    "connect timeout",
    "network error",
    "socket hang up",
    "connection reset",
    "econnreset",
  ].some((fragment) => message.includes(fragment));
}

/**
 * Wait for the requested confirmation depth without rebroadcasting after a
 * transient RPC failure. The original timeout remains the total time budget.
 */
export async function waitForTransactionConfirmations(
  client: TransactionWaitClient,
  txHash: string,
  options: TransactionConfirmationOptions = {}
): Promise<unknown> {
  const confirmations = options.confirmations ?? 0;
  const timeoutMs = options.timeoutMs ?? DEPLOY_TX_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEPLOY_TX_POLL_INTERVAL_MS;
  const transientRetries = options.transientRetries ?? DEPLOY_TX_TRANSIENT_RETRIES;
  const deadline = Date.now() + timeoutMs;
  let retries = 0;

  for (;;) {
    const remainingMs = retries === 0
      ? timeoutMs
      : Math.max(1, deadline - Date.now());
    let confirmed: unknown | undefined;

    try {
      confirmed = await client.waitTransaction(
        txHash,
        confirmations,
        remainingMs,
        pollIntervalMs
      );
    } catch (error) {
      if (!isTransientRpcError(error)) throw error;

      if (retries >= transientRetries || Date.now() >= deadline) {
        const detail = String((error as any)?.message ?? error);
        throw new Error(
          `Transaction ${txHash} was broadcast, but confirmation status is unknown after transient RPC failures. ` +
          `Check this transaction before broadcasting a replacement. Last RPC error: ${detail}`
        );
      }

      retries += 1;
      options.onTransientRetry?.(retries, transientRetries, error);
      continue;
    }

    if (!confirmed) {
      const state = confirmations === 0
        ? "committed transaction"
        : `transaction with ${confirmations} confirmations`;
      throw new Error(`Timed out waiting for ${state} ${txHash}`);
    }

    return confirmed;
  }
}

/** Wait until CKB reports the transaction committed, not merely visible in the pool. */
export async function waitForCommittedTransaction(
  client: TransactionWaitClient,
  txHash: string,
  timeoutMs = DEPLOY_TX_TIMEOUT_MS
): Promise<void> {
  await waitForTransactionConfirmations(client, txHash, { timeoutMs });
}
