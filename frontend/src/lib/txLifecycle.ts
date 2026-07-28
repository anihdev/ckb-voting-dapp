/**
 * Transaction confirmation helpers shared by governance action flows.
 * A broadcast transaction is successful only after CCC observes it committed.
 */

import type { TxStatus } from "./types";

export const TX_CONFIRMATIONS = 0;
export const TX_CONFIRM_TIMEOUT_MS = 180_000;
export const TX_CONFIRM_POLL_INTERVAL_MS = 3_000;

export function isTransactionInFlight(status: TxStatus): boolean {
  return status === "building" || status === "signing" || status === "sending" || status === "confirming";
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
