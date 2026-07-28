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

export type TallyFrontierSource =
  | "live-shards"
  | "merge-frontier"
  | "complete-merge"
  | "closed-poll";

export interface TallyFrontierMetadata {
  source: TallyFrontierSource;
  coveredShardCount: number;
  shardCount: number;
  coverageComplete: boolean;
  selectedMergeResultIds: string[];
  selectedShardIds: number[];
  uncoveredShardIds: number[];
}

export interface Poll {
  id: string;
  outPoint: CellRef;
  question: string;
  options: string[];
  voteCounts: bigint[];
  createdEpoch: bigint | null;
  deadline: bigint;
  creator: string;
  isClosed: boolean;
  totalVoters: bigint;
  creatorDeposit: bigint;
  pendingIntentCount: bigint;
  protocolPendingIntentCount: bigint;
  tokenWeighted: boolean;
  udtTypeHash: string;
  shardCount: number;
  tallyShards: TallyShard[];
  tallyMergeResults: TallyMergeResult[];
  tallyFrontier: TallyFrontierMetadata;
  totalVotes: bigint;
  winnerIndex: number | null;
  authorityOptions: VoteAuthorityOption[];
  outstandingIntentCount: number;
  lateIntentCount: number;
  refundableIntentCount: number;
}

export interface VoteIntent {
  id: string;
  pollId: string;
  outPoint: CellRef;
  voterLockHash: string;
  optionIndex: number;
  /** Legacy caller-selected codec value; not an authenticated cutoff time. */
  votedAtEpoch: bigint;
  /** Authenticated creation epoch resolved from the intent cell's block. */
  createdEpoch: bigint | null;
  aggregated: boolean;
  capacity: bigint;
}

export interface TallyShard {
  id: string;
  pollId: string;
  outPoint: CellRef;
  shardId: number;
  shardCount: number;
  voteCounts: bigint[];
  totalVoters: bigint;
  finalized: boolean;
  capacity: bigint;
}

export interface TallyMergeResult {
  id: string;
  pollId: string;
  outPoint: CellRef;
  coverage: string;
  voteCounts: bigint[];
  totalVoters: bigint;
  mergeLevel: number;
  version: number;
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
  isDelegator: boolean;
}

export interface DelegateParams {
  delegateLockHash: string;
  pollId?: string;
}

export type TxStatus =
  | "idle"
  | "building"
  | "signing"
  | "sending"
  | "confirming"
  | "unconfirmed"
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
