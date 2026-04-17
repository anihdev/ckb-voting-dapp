/**
 * Frontend Governance Types
 * =========================
 * Shared UI-facing types derived from the contract's poll, intent, and
 * delegation cell layouts.
 */

export interface CellRef {
  txHash: string;
  index: number;
}

export interface Poll {
  id: string;
  outPoint: CellRef;
  question: string;
  options: string[];
  voteCounts: bigint[];
  deadline: bigint;
  creator: string;
  isClosed: boolean;
  totalVoters: bigint;
  creatorDeposit: bigint;
  pendingIntentCount: bigint;
  tokenWeighted: boolean;
  udtTypeHash: string;
  totalVotes: bigint;
  winnerIndex: number | null;
  authorityOptions: VoteAuthorityOption[];
  outstandingIntentCount: number;
}

export interface VoteIntent {
  id: string;
  pollId: string;
  outPoint: CellRef;
  voterLockHash: string;
  optionIndex: number;
  votedAtEpoch: bigint;
  aggregated: boolean;
  capacity: bigint;
}

export interface VoteAuthorityOption {
  id: string;
  mode: "self" | "delegation";
  label: string;
  voterLockHash: string;
  delegationId: string | null;
  hasIntent: boolean;
  hasPendingIntent: boolean;
  hasAggregatedIntent: boolean;
}

export interface DelegationRecord {
  id: string;
  outPoint: CellRef;
  delegatorLockHash: string;
  delegateLockHash: string;
  pollId: string | null;
  expiresEpoch: bigint;
  capacity: bigint;
}

export interface DelegateParams {
  delegateLockHash: string;
  pollId?: string;
  expiresEpoch?: bigint;
}

export type TxStatus =
  | "idle"
  | "building"
  | "signing"
  | "sending"
  | "confirming"
  | "success"
  | "error";

export interface TxState {
  status: TxStatus;
  txHash: string | null;
  error: string | null;
}

export interface SeedPollConfig {
  question: string;
  options: string[];
  durationEpochs: number;
}
