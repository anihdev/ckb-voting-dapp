/**
 * Frontend Protocol UI Models
 * ===========================
 * Pure helpers for lifecycle display, shard/merge tally frontiers, and
 * bounded close-time intent refund selection.
 */

import {
  MAX_CLOSE_INTENT_REFUNDS,
  MAX_TALLY_SHARDS,
  MERGE_COVERAGE_BYTES,
} from "./constants";
import { hexToBytes } from "./molecule";
import {
  DelegationRecord,
  Poll,
  TallyFrontierSource,
  TallyMergeResult,
  TallyShard,
} from "./types";

export const FINALIZE_PENDING_INTENTS_WARNING =
  "Pending intents are still indexed. Finalizing can leave them uncounted; they remain refundable after close.";

export type PollLifecycleFilter = "open" | "needsClose" | "archived" | "all";
export type PollLifecycleStatus = "open" | "needsClose" | "archived";

export interface TallyFrontierResult {
  voteCounts: bigint[];
  totalVoters: bigint;
  totalVotes: bigint;
  source: TallyFrontierSource;
  coveredShardCount: number;
  shardCount: number;
  coverageComplete: boolean;
  selectedMergeResultIds: string[];
  selectedShardIds: number[];
  uncoveredShardIds: number[];
}

export interface CloseIntentRefundCandidate<T> {
  cell: T;
  pollTypeHash: string;
  aggregated: boolean;
  sortKey?: string;
}

export interface CloseIntentRefundSelection<T> {
  included: Array<CloseIntentRefundCandidate<T>>;
  omitted: Array<CloseIntentRefundCandidate<T>>;
  includedPendingCount: number;
  omittedPendingCount: number;
  includedAggregatedCount: number;
  omittedAggregatedCount: number;
  maxRefunds: number;
}

export interface ProtocolTimelineStep {
  op: string;
  label: string;
  detail: string;
  state: "completed" | "live" | "pending";
}

function emptyCoverage(): Uint8Array {
  return new Uint8Array(MERGE_COVERAGE_BYTES);
}

function normalizeCoverage(coverage: string | Uint8Array): Uint8Array {
  const bytes = typeof coverage === "string" ? hexToBytes(coverage) : coverage;
  if (bytes.length !== MERGE_COVERAGE_BYTES) {
    throw new Error("Merge coverage must be 32 bytes");
  }
  return bytes;
}

function coverageHas(coverage: Uint8Array, shardId: number): boolean {
  if (!Number.isInteger(shardId) || shardId < 0 || shardId >= MAX_TALLY_SHARDS) {
    return false;
  }
  return (coverage[Math.floor(shardId / 8)] & (1 << (shardId % 8))) !== 0;
}

function coverageSet(coverage: Uint8Array, shardId: number): void {
  coverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
}

function coverageClone(coverage: Uint8Array): Uint8Array {
  return new Uint8Array(coverage);
}

function coverageOr(target: Uint8Array, source: Uint8Array): void {
  for (let index = 0; index < target.length; index += 1) {
    target[index] |= source[index];
  }
}

function coverageDisjoint(left: Uint8Array, right: Uint8Array): boolean {
  for (let index = 0; index < left.length; index += 1) {
    if ((left[index] & right[index]) !== 0) return false;
  }
  return true;
}

function coverageWithinShardCount(coverage: Uint8Array, shardCount: number): boolean {
  if (!Number.isInteger(shardCount) || shardCount < 0 || shardCount > MAX_TALLY_SHARDS) {
    return false;
  }
  for (let shardId = shardCount; shardId < MAX_TALLY_SHARDS; shardId += 1) {
    if (coverageHas(coverage, shardId)) return false;
  }
  return true;
}

function uncoveredShardIds(coverage: Uint8Array, shardCount: number): number[] {
  const uncovered: number[] = [];
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    if (!coverageHas(coverage, shardId)) uncovered.push(shardId);
  }
  return uncovered;
}

function emptyFrontierMetadata(source: TallyFrontierSource, shardCount: number) {
  return {
    source,
    coveredShardCount: 0,
    shardCount,
    coverageComplete: shardCount === 0,
    selectedMergeResultIds: [],
    selectedShardIds: [],
    uncoveredShardIds: shardCount > 0
      ? Array.from({ length: shardCount }, (_, shardId) => shardId)
      : [],
  };
}

export function tallyMergeCoverageCount(coverage: string | Uint8Array): number {
  return Array.from(normalizeCoverage(coverage)).reduce(
    (sum, byte) => sum + byte.toString(2).replace(/0/g, "").length,
    0
  );
}

export function tallyMergeCoverageComplete(
  coverage: string | Uint8Array,
  shardCount: number
): boolean {
  const bytes = normalizeCoverage(coverage);
  if (!coverageWithinShardCount(bytes, shardCount)) return false;
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    if (!coverageHas(bytes, shardId)) return false;
  }
  return true;
}

function addVoteCounts(target: bigint[], source: bigint[]): void {
  source.forEach((count, index) => {
    if (index < target.length) {
      target[index] += count;
    }
  });
}

function alignedCounts(counts: bigint[] | undefined, optionCount: number): bigint[] {
  return Array.from({ length: optionCount }, (_, index) => counts?.[index] ?? 0n);
}

function compareOptionalEpochDesc(left: bigint | null, right: bigint | null): number {
  if (left !== null && right !== null && left !== right) return left > right ? -1 : 1;
  if (left !== null && right === null) return -1;
  if (left === null && right !== null) return 1;
  return 0;
}

export function getPollLifecycleStatus(
  poll: Pick<Poll, "isClosed" | "deadline">,
  currentEpoch: bigint
): PollLifecycleStatus {
  if (poll.isClosed) return "archived";
  if (currentEpoch > poll.deadline) return "needsClose";
  return "open";
}

export function getPollFilterCounts(polls: Poll[], currentEpoch: bigint) {
  const counts = {
    open: 0,
    needsClose: 0,
    archived: 0,
    all: polls.length,
  };

  for (const poll of polls) {
    counts[getPollLifecycleStatus(poll, currentEpoch)] += 1;
  }

  return counts;
}

export function sortPollsByLifecycle(polls: Poll[], currentEpoch: bigint): Poll[] {
  const priority: Record<PollLifecycleStatus, number> = {
    needsClose: 0,
    open: 1,
    archived: 2,
  };

  return [...polls].sort((left, right) => {
    const leftStatus = getPollLifecycleStatus(left, currentEpoch);
    const rightStatus = getPollLifecycleStatus(right, currentEpoch);
    if (priority[leftStatus] !== priority[rightStatus]) {
      return priority[leftStatus] - priority[rightStatus];
    }

    const createdCompare = compareOptionalEpochDesc(left.createdEpoch, right.createdEpoch);
    if (createdCompare !== 0) return createdCompare;
    if (left.deadline !== right.deadline) return left.deadline > right.deadline ? -1 : 1;
    return left.id.localeCompare(right.id);
  });
}

export function filterPollsByLifecycle(
  polls: Poll[],
  filter: PollLifecycleFilter,
  currentEpoch: bigint
): Poll[] {
  const sorted = sortPollsByLifecycle(polls, currentEpoch);
  if (filter === "all") return sorted;
  return sorted.filter((poll) => getPollLifecycleStatus(poll, currentEpoch) === filter);
}

export function canFinalizeTallyShardFromUi(poll: Poll, currentEpoch: bigint): boolean {
  return (
    !poll.isClosed &&
    currentEpoch > poll.deadline &&
    poll.shardCount > 0 &&
    poll.tallyShards.some((shard) => !shard.finalized)
  );
}

export function getFinalizeShardConfirmationMessage(poll: Poll): string {
  const base =
    "This finalizes one tally shard after the deadline. Finalized shards cannot be aggregated again and are required before small-poll direct close or large-poll merge.";

  if (poll.pendingIntentCount > 0n) {
    return `${FINALIZE_PENDING_INTENTS_WARNING}\n\n${base}`;
  }

  return base;
}

export function computeCanonicalTallyFrontier(input: {
  optionCount: number;
  shardCount: number;
  pollVoteCounts?: bigint[];
  pollTotalVoters?: bigint;
  pollIsClosed?: boolean;
  shards: TallyShard[];
  mergeResults: TallyMergeResult[];
}): TallyFrontierResult {
  const fallbackVoteCounts = alignedCounts(input.pollVoteCounts, input.optionCount);
  const fallbackTotalVoters = input.pollTotalVoters ?? fallbackVoteCounts.reduce((sum, count) => sum + count, 0n);

  if (input.shardCount <= 0) {
    return {
      voteCounts: fallbackVoteCounts,
      totalVoters: fallbackTotalVoters,
      totalVotes: fallbackVoteCounts.reduce((sum, count) => sum + count, 0n),
      source: "poll-cell",
      shardCount: 0,
      coveredShardCount: 0,
      coverageComplete: true,
      selectedMergeResultIds: [],
      selectedShardIds: [],
      uncoveredShardIds: [],
    };
  }

  if (input.pollIsClosed) {
    return {
      voteCounts: fallbackVoteCounts,
      totalVoters: fallbackTotalVoters,
      totalVotes: fallbackVoteCounts.reduce((sum, count) => sum + count, 0n),
      source: "closed-poll",
      shardCount: input.shardCount,
      coveredShardCount: input.shardCount,
      coverageComplete: true,
      selectedMergeResultIds: [],
      selectedShardIds: [],
      uncoveredShardIds: [],
    };
  }

  const mergeCandidates = input.mergeResults
    .map((result) => {
      try {
        const coverage = normalizeCoverage(result.coverage);
        if (!coverageWithinShardCount(coverage, input.shardCount)) return null;
        if (result.voteCounts.length !== input.optionCount) return null;
        const count = tallyMergeCoverageCount(coverage);
        if (count === 0) return null;
        return { result, coverage: coverageClone(coverage), count };
      } catch {
        return null;
      }
    })
    .filter((candidate): candidate is { result: TallyMergeResult; coverage: Uint8Array; count: number } =>
      candidate !== null
    )
    .sort((left, right) => {
      if (right.count !== left.count) return right.count - left.count;
      if (right.result.mergeLevel !== left.result.mergeLevel) {
        return right.result.mergeLevel - left.result.mergeLevel;
      }
      return left.result.id.localeCompare(right.result.id);
    });

  const completeResult = mergeCandidates.find((candidate) =>
    tallyMergeCoverageComplete(candidate.coverage, input.shardCount)
  );
  if (completeResult) {
    const voteCounts = alignedCounts(completeResult.result.voteCounts, input.optionCount);
    return {
      voteCounts,
      totalVoters: completeResult.result.totalVoters,
      totalVotes: voteCounts.reduce((sum, count) => sum + count, 0n),
      source: "complete-merge",
      shardCount: input.shardCount,
      coveredShardCount: input.shardCount,
      coverageComplete: true,
      selectedMergeResultIds: [completeResult.result.id],
      selectedShardIds: [],
      uncoveredShardIds: [],
    };
  }

  const selectedCoverage = emptyCoverage();
  const voteCounts = Array.from({ length: input.optionCount }, () => 0n);
  let totalVoters = 0n;
  const selectedMergeResultIds: string[] = [];
  const selectedShardIds: number[] = [];

  for (const candidate of mergeCandidates) {
    if (!coverageDisjoint(selectedCoverage, candidate.coverage)) continue;
    coverageOr(selectedCoverage, candidate.coverage);
    addVoteCounts(voteCounts, candidate.result.voteCounts);
    totalVoters += candidate.result.totalVoters;
    selectedMergeResultIds.push(candidate.result.id);
  }

  const shardCandidates = [...input.shards].sort((left, right) => {
    if (left.shardId !== right.shardId) return left.shardId - right.shardId;
    return left.id.localeCompare(right.id);
  });

  for (const shard of shardCandidates) {
    if (shard.shardCount !== input.shardCount) continue;
    if (shard.shardId < 0 || shard.shardId >= input.shardCount) continue;
    if (shard.voteCounts.length !== input.optionCount) continue;
    if (coverageHas(selectedCoverage, shard.shardId)) continue;
    coverageSet(selectedCoverage, shard.shardId);
    addVoteCounts(voteCounts, shard.voteCounts);
    totalVoters += shard.totalVoters;
    selectedShardIds.push(shard.shardId);
  }

  const coveredShardCount = tallyMergeCoverageCount(selectedCoverage);
  if (coveredShardCount === 0) {
    return {
      voteCounts: Array.from({ length: input.optionCount }, () => 0n),
      totalVoters: 0n,
      totalVotes: 0n,
      ...emptyFrontierMetadata("live-shards", input.shardCount),
      coveredShardCount: 0,
    };
  }

  const missingShardIds = uncoveredShardIds(selectedCoverage, input.shardCount);
  return {
    voteCounts,
    totalVoters,
    totalVotes: voteCounts.reduce((sum, count) => sum + count, 0n),
    source: selectedMergeResultIds.length > 0 ? "merge-frontier" : "live-shards",
    coveredShardCount,
    shardCount: input.shardCount,
    coverageComplete: missingShardIds.length === 0,
    selectedMergeResultIds,
    selectedShardIds,
    uncoveredShardIds: missingShardIds,
  };
}

export function selectCloseTimeIntentRefunds<T>(
  candidates: Array<CloseIntentRefundCandidate<T>>,
  options: {
    pollTypeHash: string;
    trackedPendingLowerBound: bigint;
    maxRefunds?: number;
  }
): CloseIntentRefundSelection<T> {
  const maxRefunds = options.maxRefunds ?? MAX_CLOSE_INTENT_REFUNDS;
  if (!Number.isInteger(maxRefunds) || maxRefunds < 0) {
    throw new Error("Close-time refund cap must be a non-negative integer");
  }
  if (options.trackedPendingLowerBound > BigInt(maxRefunds)) {
    throw new Error(
      `Tracked pending intents exceed the frontend close-time refund cap (${maxRefunds}). Aggregate or refund in a smaller lifecycle path before close.`
    );
  }

  const pollTypeHash = options.pollTypeHash.toLowerCase();
  const scoped = candidates
    .filter((candidate) => candidate.pollTypeHash.toLowerCase() === pollTypeHash)
    .sort((left, right) => {
      if (left.aggregated !== right.aggregated) return left.aggregated ? 1 : -1;
      return (left.sortKey ?? "").localeCompare(right.sortKey ?? "");
    });

  const pending = scoped.filter((candidate) => !candidate.aggregated);
  if (BigInt(pending.length) < options.trackedPendingLowerBound) {
    throw new Error("Close requires at least the pending intents tracked on the poll state");
  }

  const included = scoped.slice(0, maxRefunds);
  const includedSet = new Set(included);
  const omitted = scoped.filter((candidate) => !includedSet.has(candidate));

  return {
    included,
    omitted,
    includedPendingCount: included.filter((candidate) => !candidate.aggregated).length,
    omittedPendingCount: omitted.filter((candidate) => !candidate.aggregated).length,
    includedAggregatedCount: included.filter((candidate) => candidate.aggregated).length,
    omittedAggregatedCount: omitted.filter((candidate) => candidate.aggregated).length,
    maxRefunds,
  };
}

export function buildProtocolTimeline(
  polls: Poll[],
  delegations: DelegationRecord[],
  currentEpoch: bigint
): ProtocolTimelineStep[] {
  const hasPolls = polls.length > 0;
  const hasIntent = polls.some((poll) => poll.totalVoters > 0n || poll.pendingIntentCount > 0n);
  const hasAggregated = polls.some((poll) => poll.totalVotes > 0n);
  const hasExpiredOpen = polls.some((poll) => !poll.isClosed && currentEpoch > poll.deadline);
  const hasClosed = polls.some((poll) => poll.isClosed);
  const hasDelegation = delegations.length > 0;

  return [
    {
      op: "CREATE_POLL",
      label: "Create poll cell",
      detail: "Lock creator deposit and initialize governance state.",
      state: hasPolls ? "completed" : "live",
    },
    {
      op: "CREATE_VOTE_INTENT",
      label: "Record vote intent",
      detail: "Store independent voter or delegated intent cells.",
      state: hasIntent ? "completed" : hasPolls ? "live" : "pending",
    },
    {
      op: "CREATE_TALLY_SHARD",
      label: "Shard aggregation",
      detail: "Batch pending intents into shard tally state.",
      state: hasAggregated ? "completed" : hasIntent ? "live" : "pending",
    },
    {
      op: "CLOSE_POLL",
      label: "Close or recover",
      detail: "Creator closes after deadline; anyone can force-close after grace.",
      state: hasClosed ? "completed" : hasExpiredOpen ? "live" : "pending",
    },
    {
      op: "DELEGATE",
      label: "Delegate authority",
      detail: "Issue delegation cells globally or per poll.",
      state: hasDelegation ? "completed" : hasPolls ? "live" : "pending",
    },
    {
      op: "REVOKE_DELEGATION",
      label: "Revoke delegation",
      detail: "Delegators consume delegation cells to revoke authority.",
      state: hasDelegation ? "live" : "pending",
    },
  ];
}
