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
  authorityOptions: VoteAuthorityOption[];
  /** Indexer-derived estimate; contract validation remains authoritative. */
  aggregationBatchCount: number;
  outstandingIntentCount: number;
  lateIntentCount: number;
  refundableIntentCount: number;
}

/** Advisory result from a fresh poll-scoped intent scan before finalization. */
export interface FinalizationReadinessCheck {
  timelyPendingIntentCount: number;
  latePendingIntentCount: number;
  unresolvedIntentCount: number;
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
  countedVoterRoot: string;
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
  /** One unambiguous indexed choice for this represented voter, if available. */
  recordedOptionIndex: number | null;
  /** True when separately valid live intents encode different choices. */
  hasConflictingIntentChoices: boolean;
}

/**
 * Presentation-only reading of a finalized tally.
 *
 * The governance contract defines no winner, quorum, pass/fail policy, or
 * tie-break, so this is deliberately not called a protocol result. It reports
 * the leader among counted finalized votes and reports ties as ties instead of
 * collapsing them into a single index. Derived from raw vote counts by
 * `derivePollOutcome`, never stored on `Poll`, so no caller can assert an
 * outcome the counts do not support.
 */
export type PollOutcome =
  | { kind: "no-votes" }
  | { kind: "leader"; optionIndex: number; votes: bigint }
  | { kind: "tie"; optionIndices: number[]; votesEach: bigint };

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
  pollId: string;
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

/**
 * Identifies which UI surface started the tracked transaction so a poll card,
 * the delegation panel, and the poll builder never render each other's status.
 */
export type TxScope =
  | { kind: "poll"; pollId: string }
  | { kind: "delegation" }
  | { kind: "createPoll" };

export interface TxState {
  status: TxStatus;
  txHash: string | null;
  error: string | null;
  scope: TxScope | null;
  /** Progress for multi-transaction runs such as finalizing every tally lane. */
  batch: TxBatchProgress | null;
}

export interface TxBatchProgress {
  label: string;
  completed: number;
  total: number;
}

export interface SeedPollConfig {
  question: string;
  options: string[];
  durationEpochs: number;
}
