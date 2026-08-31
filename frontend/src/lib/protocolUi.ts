/**
 * Frontend Protocol UI Models
 * ===========================
 * Pure helpers for lifecycle display, shard/merge tally frontiers, and
 * bounded close-time intent refund selection.
 */

import {
  FINALIZATION_GRACE_EPOCHS,
  FORCE_CLOSE_GRACE_EPOCHS,
  MAX_ACTIVE_TALLY_SHARDS,
  MAX_CLOSE_INTENT_REFUNDS,
  MAX_DIRECT_CLOSE_SHARDS,
  MAX_INTENTS_PER_AGG,
  MAX_TALLY_SHARDS,
  MERGE_COVERAGE_BYTES,
} from "./constants";
import { hexToBytes } from "./molecule";
import {
  DelegationRecord,
  FinalizationReadinessCheck,
  IndexedLaneDomainState,
  Poll,
  PollMaintenanceState,
  PollOutcome,
  ResultAssuranceV1,
  TallyFrontierSource,
  TallyMergeResult,
  TallyShard,
  VoteAuthorityOption,
  VoteIntent,
} from "./types";
import {
  GOVERNANCE_CODE_HASH,
  GOVERNANCE_SCRIPT_HASH_TYPE,
} from "./ckb";

export const FINALIZE_PENDING_INTENTS_WARNING =
  "Pending intents are still indexed. Finalizing can leave them uncounted; they remain refundable after close.";

export const UNSUPPORTED_WEIGHTED_POLL_LABEL = "Weighted voting disabled; recovery only";
export const UNSUPPORTED_WEIGHTED_POLL_MESSAGE =
  "Weighted voting is unsupported in this equal-weight deployment. New voting and aggregation are disabled; finalization, close, and exact-capacity recovery remain available.";
export const CREATOR_VOTING_DISABLED_MESSAGE =
  "Voting is not allowed for poll creator.";

export interface IndexerQueryWarning {
  message: string;
  detail: string | null;
}

/** Converts low-level browser/RPC failures into actionable stale-data copy. */
export function describeIndexerQueryError(rawError: string): IndexerQueryWarning {
  const detail = rawError.trim() || "Unknown CKB data query failure";
  const normalized = detail.toLowerCase();
  const isConnectionFailure =
    normalized.includes("failed to fetch") ||
    normalized.includes("networkerror") ||
    normalized.includes("network error") ||
    normalized.includes("load failed");

  return {
    message: isConnectionFailure
      ? "The app could not reach the configured CKB RPC/indexer. Existing poll data may be stale; check your connection and retry."
      : "The CKB poll query did not complete. Existing poll data may be stale; retry the indexer scan.",
    detail,
  };
}

export const CKB_EPOCH_TARGET_HOURS = 4;

export type PollDurationUnit = "hours" | "days" | "epochs";

const POLL_DURATION_UNIT_LABELS: Record<PollDurationUnit, string> = {
  hours: "Hour(s)",
  days: "Day(s)",
  epochs: "Epoch(s)",
};

export function formatPollDurationUnit(unit: PollDurationUnit): string {
  return POLL_DURATION_UNIT_LABELS[unit];
}

export function minimumPollDurationValue(unit: PollDurationUnit): number {
  return unit === "hours" ? 8 : 1;
}

export function validatePollDurationSelection(
  value: number,
  unit: PollDurationUnit
): string | null {
  if (!Number.isFinite(value) || value <= 0) {
    return "Enter a positive voting duration";
  }

  const minimum = minimumPollDurationValue(unit);
  if (value < minimum) {
    return unit === "hours"
      ? "Hour(s) must be at least 8 because this deployment uses whole CKB epoch deadlines"
      : `${formatPollDurationUnit(unit)} must be at least ${minimum.toString()}`;
  }

  return null;
}

export interface EpochPosition {
  epoch: bigint;
  index: bigint;
  length: bigint;
}

/** Converts a human duration to whole CKB epochs without rounding it down. */
export function pollDurationToEpochs(
  value: number,
  unit: PollDurationUnit
): number {
  if (!Number.isFinite(value) || value <= 0) return 0;

  const rawEpochs =
    unit === "epochs"
      ? value
      : (unit === "days" ? value * 24 : value) / CKB_EPOCH_TARGET_HOURS;
  const epochs = Math.ceil(rawEpochs);
  return Number.isSafeInteger(epochs) ? epochs : 0;
}

/** Preserves an existing whole-epoch span when the form changes units. */
export function epochSpanInUnit(
  epochSpan: number,
  unit: PollDurationUnit
): number {
  if (!Number.isSafeInteger(epochSpan) || epochSpan <= 0) return 0;
  if (unit === "epochs") return epochSpan;

  const hours = epochSpan * CKB_EPOCH_TARGET_HOURS;
  return unit === "hours" ? hours : Number((hours / 24).toFixed(4));
}

export function formatApproxWallClockDuration(totalHours: number): string {
  if (!Number.isFinite(totalHours) || totalHours <= 0) return "about 0 hours";

  if (totalHours < 1) {
    const minutes = Math.max(1, Math.round(totalHours * 60));
    return `about ${minutes.toString()} ${minutes === 1 ? "minute" : "minutes"}`;
  }

  if (totalHours < 24) {
    const rounded = Math.round(totalHours * 10) / 10;
    return `about ${rounded.toString()} ${rounded === 1 ? "hour" : "hours"}`;
  }

  const days = Math.round((totalHours / 24) * 10) / 10;
  return `about ${days.toString()} ${days === 1 ? "day" : "days"}`;
}

/**
 * Estimates time until the first epoch in which creator-close or finalization
 * becomes valid.
 * The hardened protocol gives aggregation one full grace epoch and then uses a
 * strictly-after helper, so the first valid integer epoch is deadline + 2.
 */
export function estimatePollCloseHours(
  deadline: bigint,
  position: EpochPosition
): number {
  const earliestCloseEpoch = deadline + FINALIZATION_GRACE_EPOCHS + 1n;
  if (position.epoch >= earliestCloseEpoch) return 0;
  if (position.length <= 0n || position.index < 0n || position.index >= position.length) {
    return Number(earliestCloseEpoch - position.epoch) * CKB_EPOCH_TARGET_HOURS;
  }

  const wholeEpochs = Number(earliestCloseEpoch - position.epoch);
  const currentFraction = Number(position.index) / Number(position.length);
  return Math.max(0, (wholeEpochs - currentFraction) * CKB_EPOCH_TARGET_HOURS);
}

export function formatApproxEpochDuration(epochSpan: bigint): string {
  if (epochSpan <= 0n) return "0 epochs (~0 hours)";

  const totalHours = Number(epochSpan) * CKB_EPOCH_TARGET_HOURS;
  const epochLabel = epochSpan === 1n ? "epoch" : "epochs";
  if (totalHours < 24) {
    return `${epochSpan.toString()} ${epochLabel} (~${totalHours.toString()} hours)`;
  }

  const days = totalHours / 24;
  const dayText = Number.isInteger(days) ? days.toString() : days.toFixed(1);
  const dayLabel = days === 1 ? "day" : "days";
  return `${epochSpan.toString()} ${epochLabel} (~${dayText} ${dayLabel})`;
}

export function isPollVotingSupported(
  poll: Pick<Poll, "tokenWeighted">
): boolean {
  return !poll.tokenWeighted;
}

/**
 * Estimates required aggregation transactions from per-lane pending counts.
 * A transaction updates exactly one lane, so underfilled lanes cannot be
 * combined merely because their total is below the per-transaction cap.
 */
export function countAggregationBatches(laneIntentCounts: Iterable<number>): number {
  let batches = 0;
  for (const count of laneIntentCounts) {
    if (!Number.isInteger(count) || count < 0) {
      throw new Error("Aggregation lane intent counts must be non-negative integers");
    }
    batches += Math.ceil(count / MAX_INTENTS_PER_AGG);
  }
  return batches;
}

/**
 * Separates unaggregated intents by their authenticated creation-header epoch.
 * Late intents are deliberately not treated as aggregation work because the
 * Rust contract rejects them from tally transitions and exposes a refund path.
 */
export function summarizeFinalizationReadiness(
  intents: Iterable<Pick<VoteIntent, "aggregated" | "createdEpoch">>,
  deadline: bigint,
  unresolvedIntentCount = 0
): FinalizationReadinessCheck {
  if (!Number.isInteger(unresolvedIntentCount) || unresolvedIntentCount < 0) {
    throw new Error("Unresolved intent count must be a non-negative integer");
  }

  let timelyPendingIntentCount = 0;
  let latePendingIntentCount = 0;
  let unresolvedCount = unresolvedIntentCount;

  for (const intent of intents) {
    if (intent.aggregated) continue;
    if (intent.createdEpoch === null) {
      unresolvedCount += 1;
    } else if (intent.createdEpoch <= deadline) {
      timelyPendingIntentCount += 1;
    } else {
      latePendingIntentCount += 1;
    }
  }

  return {
    timelyPendingIntentCount,
    latePendingIntentCount,
    unresolvedIntentCount: unresolvedCount,
  };
}

export function finalizationReadinessNeedsCaution(
  check: FinalizationReadinessCheck
): boolean {
  return check.timelyPendingIntentCount > 0 || check.unresolvedIntentCount > 0;
}

/** Human-readable handshake shown before a finalization transaction is built. */
export function formatFinalizationReadinessCheck(
  check: FinalizationReadinessCheck
): string {
  if (check.timelyPendingIntentCount > 0) {
    return `${check.timelyPendingIntentCount.toString()} timely pending intent${check.timelyPendingIntentCount === 1 ? " remains" : "s remain"}. Finalizing now can leave ${check.timelyPendingIntentCount === 1 ? "it" : "them"} permanently uncounted.`;
  }

  if (check.unresolvedIntentCount > 0) {
    return `${check.unresolvedIntentCount.toString()} matching intent${check.unresolvedIntentCount === 1 ? " could" : "s could"} not be classified. Finalizing now can leave timely intents permanently uncounted.`;
  }

  if (check.latePendingIntentCount > 0) {
    return `No indexed timely pending intents remain. ${check.latePendingIntentCount.toString()} late intent${check.latePendingIntentCount === 1 ? " cannot count and remains" : "s cannot count and remain"} refundable.`;
  }

  return "No indexed timely pending intents remain.";
}

/**
 * Derives the connected wallet's usable voting identities from indexed cells.
 *
 * This is intentionally pure: a wallet connection should update poll actions
 * from already-indexed intents immediately, without waiting for another RPC
 * scan. The contract and transaction builder remain the authority at submit
 * time; this helper only keeps the UI's role state current.
 */
export function deriveVoteAuthorityOptions(input: {
  poll: Pick<Poll, "id" | "creator">;
  intents: VoteIntent[];
  delegations: DelegationRecord[];
  viewerLockHash: string | null;
}): VoteAuthorityOption[] {
  if (!input.viewerLockHash) return [];

  const viewerLockHash = input.viewerLockHash.toLowerCase();
  const pollId = input.poll.id.toLowerCase();
  const intentState = (representedVoterLockHash: string) => {
    const normalizedVoterLockHash = representedVoterLockHash.toLowerCase();
    const representedIntents = input.intents.filter(
      (intent) =>
        intent.pollId.toLowerCase() === pollId &&
        intent.voterLockHash.toLowerCase() === normalizedVoterLockHash
    );

    const optionIndices = [...new Set(representedIntents.map((intent) => intent.optionIndex))];

    return {
      hasIntent: representedIntents.length > 0,
      hasPendingIntent: representedIntents.some((intent) => !intent.aggregated),
      hasAggregatedIntent: representedIntents.some((intent) => intent.aggregated),
      recordedOptionIndex: optionIndices.length === 1 ? optionIndices[0] : null,
      hasConflictingIntentChoices: optionIndices.length > 1,
    };
  };

  const authorityOptions: VoteAuthorityOption[] = [
    {
      id: "self",
      mode: "self",
      label: "Vote as connected wallet",
      voterLockHash: input.viewerLockHash,
      delegationId: null,
      ...intentState(input.viewerLockHash),
    },
  ];

  for (const delegation of input.delegations) {
    if (
      delegation.delegateLockHash.toLowerCase() !== viewerLockHash ||
      delegation.pollId?.toLowerCase() !== pollId ||
      delegation.delegatorLockHash.toLowerCase() === input.poll.creator.toLowerCase() ||
      delegation.expiresEpoch !== 0n
    ) {
      continue;
    }

    authorityOptions.push({
      id: delegation.id,
      mode: "delegation",
      label: `Vote for ${delegation.delegatorLockHash.slice(0, 14)}...`,
      voterLockHash: delegation.delegatorLockHash,
      delegationId: delegation.id,
      ...intentState(delegation.delegatorLockHash),
    });
  }

  return authorityOptions;
}

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

function readScriptCodeHash(script: unknown): string | null {
  const value = (script as any)?.codeHash ?? (script as any)?.code_hash;
  return typeof value === "string" && /^0x[0-9a-fA-F]{64}$/.test(value)
    ? value.toLowerCase()
    : null;
}

function readScriptHashType(script: unknown): string | null {
  const value = (script as any)?.hashType ?? (script as any)?.hash_type;
  return typeof value === "string" && value.length > 0 ? value.toLowerCase() : null;
}

export function derivePollResultAssurance(
  poll: Pick<Poll, "id" | "tallyFrontier">,
  indexedPollTypeScript: unknown
): ResultAssuranceV1 | null {
  const protocolCodeHash = readScriptCodeHash(indexedPollTypeScript);
  const protocolHashType = readScriptHashType(indexedPollTypeScript);
  if (!protocolCodeHash || !protocolHashType) return null;
  if (protocolCodeHash !== GOVERNANCE_CODE_HASH.toLowerCase()) return null;
  if (protocolHashType !== GOVERNANCE_SCRIPT_HASH_TYPE.toLowerCase()) return null;

  return {
    version: 1,
    protocolCodeHash,
    protocolHashType,
    tallyIntegrity: "on_chain_verified",
    laneCoverage: poll.tallyFrontier.coverageComplete ? "complete" : "partial",
    intentInclusion: "unproven",
    authorityUniqueness: "counted_once",
    eligibility: "open",
  };
}

export interface ProtocolTimelineStep {
  op: string;
  label: string;
  detail: string;
  /**
   * `skipped` is terminal, unlike `pending`. It marks a stage that will never
   * run for this poll — a closed poll that counted nothing, or a recovery-only
   * weighted poll whose voting path is disabled — so the strip does not present
   * a finished lifecycle as unfinished work waiting on the user.
   */
  state: "completed" | "live" | "pending" | "skipped" | "ended";
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

function normalizeHexString(value: string): string {
  return value.toLowerCase();
}

function deriveIndexedLaneDomainState(
  poll: Pick<Poll, "id" | "shardCount" | "tallyShards">
): {
  state: IndexedLaneDomainState;
  missingLaneIds: number[];
  validLaneIds: number[];
} {
  const expectedPollId = normalizeHexString(poll.id);
  const laneIds = new Set<number>();
  let anyFinalized = false;
  let anyLive = false;

  for (const shard of poll.tallyShards) {
    if (normalizeHexString(shard.pollId) !== expectedPollId) {
      return { state: "malformed", missingLaneIds: [], validLaneIds: [] };
    }
    if (shard.shardCount !== poll.shardCount) {
      return { state: "malformed", missingLaneIds: [], validLaneIds: [] };
    }
    if (!Number.isInteger(shard.shardId) || shard.shardId < 0 || shard.shardId >= poll.shardCount) {
      return { state: "malformed", missingLaneIds: [], validLaneIds: [] };
    }
    if (laneIds.has(shard.shardId)) {
      return { state: "malformed", missingLaneIds: [], validLaneIds: [] };
    }
    laneIds.add(shard.shardId);
    if (shard.finalized) anyFinalized = true;
    else anyLive = true;
  }

  const missingLaneIds = Array.from({ length: poll.shardCount }, (_, shardId) => shardId).filter(
    (shardId) => !laneIds.has(shardId)
  );
  if (missingLaneIds.length > 0) {
    return {
      state: "missing",
      missingLaneIds,
      validLaneIds: [...laneIds].sort((left, right) => left - right),
    };
  }
  if (!anyFinalized) {
    return {
      state: "all_live",
      missingLaneIds: [],
      validLaneIds: [...laneIds].sort((left, right) => left - right),
    };
  }
  if (!anyLive) {
    return {
      state: "all_finalized",
      missingLaneIds: [],
      validLaneIds: [...laneIds].sort((left, right) => left - right),
    };
  }
  return {
    state: "mixed",
    missingLaneIds: [],
    validLaneIds: [...laneIds].sort((left, right) => left - right),
  };
}

function deriveSelectedMergeCoverage(
  poll: Pick<Poll, "id" | "shardCount" | "tallyFrontier" | "tallyMergeResults" | "tallyShards">
): {
  malformed: boolean;
  coverage: Uint8Array;
  coveredShardCount: number;
  complete: boolean;
} {
  const coverage = emptyCoverage();
  const selectedResults = poll.tallyFrontier.selectedMergeResultIds.map((resultId) =>
    poll.tallyMergeResults.find((candidate) => candidate.id === resultId) ?? null
  );
  if (selectedResults.some((result) => result === null)) {
    return { malformed: true, coverage, coveredShardCount: 0, complete: false };
  }

  for (const result of selectedResults) {
    if (!result || normalizeHexString(result.pollId) !== normalizeHexString(poll.id)) {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    let normalizedCoverage: Uint8Array;
    try {
      normalizedCoverage = normalizeCoverage(result.coverage);
    } catch {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    if (!coverageWithinShardCount(normalizedCoverage, poll.shardCount)) {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    if (!coverageDisjoint(coverage, normalizedCoverage)) {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    coverageOr(coverage, normalizedCoverage);
  }

  const liveShardById = new Map<number, TallyShard>();
  for (const shard of poll.tallyShards) {
    if (
      normalizeHexString(shard.pollId) !== normalizeHexString(poll.id) ||
      shard.shardCount !== poll.shardCount ||
      !Number.isInteger(shard.shardId) ||
      shard.shardId < 0 ||
      shard.shardId >= poll.shardCount ||
      liveShardById.has(shard.shardId)
    ) {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    liveShardById.set(shard.shardId, shard);
  }

  for (const shardId of poll.tallyFrontier.selectedShardIds) {
    const shard = liveShardById.get(shardId);
    if (!shard || coverageHas(coverage, shardId)) {
      return { malformed: true, coverage, coveredShardCount: 0, complete: false };
    }
    coverageSet(coverage, shardId);
  }

  const coveredShardCount = tallyMergeCoverageCount(coverage);
  const complete = tallyMergeCoverageComplete(coverage, poll.shardCount);
  return { malformed: false, coverage, coveredShardCount, complete };
}

/**
 * Reads a finalized tally as a leader, a tie, or no counted votes.
 *
 * Pure and derived only from the counts, so an impossible presentation state
 * cannot be constructed by a caller or injected by a test. Ties are reported as
 * ties across every joint-leading option; the contract defines no tie-break, so
 * inventing one here (lowest index, for example) would misattribute a UI
 * convention to consensus. This describes counted finalized votes only —
 * intents that were never aggregated are not represented.
 */
export function derivePollOutcome(voteCounts: bigint[]): PollOutcome {
  let leadingVotes = 0n;
  let optionIndices: number[] = [];

  voteCounts.forEach((count, index) => {
    if (count <= 0n) return;
    if (count > leadingVotes) {
      leadingVotes = count;
      optionIndices = [index];
    } else if (count === leadingVotes) {
      optionIndices.push(index);
    }
  });

  if (optionIndices.length === 0) return { kind: "no-votes" };
  if (optionIndices.length === 1) {
    return { kind: "leader", optionIndex: optionIndices[0], votes: leadingVotes };
  }
  return { kind: "tie", optionIndices, votesEach: leadingVotes };
}

/** True when the option is a leading option of the derived outcome. */
export function isLeadingOption(outcome: PollOutcome, optionIndex: number): boolean {
  if (outcome.kind === "leader") return outcome.optionIndex === optionIndex;
  if (outcome.kind === "tie") return outcome.optionIndices.includes(optionIndex);
  return false;
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

/**
 * Deterministic ordering for the protocol timeline's poll subject.
 *
 * Distinct from `sortPollsByLifecycle`, which leads with needs-close because
 * the registry surfaces work waiting on the user. The timeline instead leads
 * with the newest open poll: it describes a lifecycle in progress, and an open
 * poll is the one whose stages are still moving.
 *
 * Ordering is total and independent of indexer order — `createdEpoch` desc,
 * then `deadline` desc, then id — so the same poll list always yields the same
 * default and the same picker order regardless of the order cells came back in.
 */
export function sortPollsForTimeline(polls: Poll[], currentEpoch: bigint): Poll[] {
  const priority: Record<PollLifecycleStatus, number> = {
    open: 0,
    needsClose: 1,
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

/**
 * Picks the poll the timeline describes when the user has not chosen one.
 *
 * The previous selection read `polls` in raw indexer order, so "newest open"
 * was whichever open poll the indexer happened to return first; `PollList`
 * sorts its own copy and does not affect the array `App` holds. This selects
 * from the timeline ordering instead, so the default is reproducible.
 */
export function selectDefaultTimelinePoll(polls: Poll[], currentEpoch: bigint): Poll | null {
  return sortPollsForTimeline(polls, currentEpoch)[0] ?? null;
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

/**
 * Lifecycle reading of one indexed delegation cell.
 *
 * A live delegation cell is not evidence of usable voting authority: the poll
 * it scopes may have closed or passed its deadline, and a delegation created
 * against a poll this wallet cannot see indexes with no poll at all. Calling
 * every live cell an "active delegation" told delegators they had authority
 * they could not exercise.
 *
 * - `usable`      — scoped poll is indexed, open, and before its deadline.
 * - `expired`     — deadline passed, poll not yet closed. Revocation only.
 * - `closed`      — scoped poll is closed. Revocation only.
 * - `unknown`     — scoped poll is not in the indexed set; usability unknown.
 * - `legacy-global` — historical testnet v1 cell with no poll scope. New global
 *   delegations are disabled in the builder; these remain revocable.
 */
export type DelegationLifecycleState =
  | "usable"
  | "expired"
  | "closed"
  | "unknown"
  | "legacy-global";

export interface DelegationLifecycle {
  state: DelegationLifecycleState;
  /** True only when this cell can still authorize a new vote intent. */
  usable: boolean;
  /** Only the delegator may revoke; delegates hold authority, not ownership. */
  revocableByViewer: boolean;
  label: string;
  detail: string;
}

export function getDelegationLifecycle(
  delegation: Pick<DelegationRecord, "pollId" | "isDelegator">,
  polls: Array<Pick<Poll, "id" | "isClosed" | "deadline">>,
  currentEpoch: bigint
): DelegationLifecycle {
  const revocableByViewer = delegation.isDelegator;

  if (delegation.pollId === null) {
    return {
      state: "legacy-global",
      usable: false,
      revocableByViewer,
      label: "Testnet legacy global",
      detail:
        "Historical testnet v1 cell with no poll scope. New global delegations are disabled; this cell remains visible and revocable.",
    };
  }

  const scopedPollId = delegation.pollId.toLowerCase();
  const poll = polls.find((candidate) => candidate.id.toLowerCase() === scopedPollId);

  if (!poll) {
    return {
      state: "unknown",
      usable: false,
      revocableByViewer,
      label: "Scoped poll not indexed",
      detail:
        "The scoped poll is not in the indexed set, so this cell's usability cannot be determined here.",
    };
  }

  if (poll.isClosed) {
    return {
      state: "closed",
      usable: false,
      revocableByViewer,
      label: "Scoped poll closed",
      detail: "The scoped poll is closed. No new intent can be created; the cell is recoverable.",
    };
  }

  if (currentEpoch > poll.deadline) {
    return {
      state: "expired",
      usable: false,
      revocableByViewer,
      label: "Past voting deadline",
      detail:
        "The scoped poll passed its deadline. No new intent can be created; the cell is recoverable.",
    };
  }

  return {
    state: "usable",
    usable: true,
    revocableByViewer,
    label: "Usable authority",
    detail: "The scoped poll is open before its deadline, so this authority can create an intent.",
  };
}

export interface DelegationSummary {
  total: number;
  usable: number;
  /** Live cells that grant no usable authority: recovery or revocation only. */
  recoveryOnly: number;
  revocableByViewer: number;
}

export function summarizeDelegations(
  delegations: Array<Pick<DelegationRecord, "pollId" | "isDelegator">>,
  polls: Array<Pick<Poll, "id" | "isClosed" | "deadline">>,
  currentEpoch: bigint
): DelegationSummary {
  let usable = 0;
  let revocableByViewer = 0;

  for (const delegation of delegations) {
    const lifecycle = getDelegationLifecycle(delegation, polls, currentEpoch);
    if (lifecycle.usable) usable += 1;
    if (lifecycle.revocableByViewer) revocableByViewer += 1;
  }

  return {
    total: delegations.length,
    usable,
    recoveryOnly: delegations.length - usable,
    revocableByViewer,
  };
}

/**
 * True when a poll can still receive a *new* delegation.
 *
 * Mirrors the hook's `createDelegation` preconditions so the button is not
 * offered for an action that would be rejected: a wallet must be connected, the
 * poll must be open before its deadline, and the poll creator cannot delegate
 * authority for their own poll.
 */
export function canDelegateForPoll(
  poll: Pick<Poll, "isClosed" | "deadline" | "creator">,
  viewerLockHash: string | null,
  currentEpoch: bigint
): boolean {
  if (!viewerLockHash) return false;
  if (poll.isClosed) return false;
  if (currentEpoch > poll.deadline) return false;
  return poll.creator.toLowerCase() !== viewerLockHash.toLowerCase();
}

export function canFinalizeTallyShardFromUi(poll: Poll, currentEpoch: bigint): boolean {
  return derivePollMaintenanceState(poll, currentEpoch).finalizeReady;
}

export function getFinalizeShardConfirmationMessage(
  poll: Poll,
  readinessCheck?: FinalizationReadinessCheck
): string {
  const base =
    "Finalization freezes the complete ordered tally lane set after the aggregation grace. Finalized lanes cannot be aggregated again and are required before small-poll direct close or large-poll merge.";

  if (readinessCheck) {
    return formatFinalizationReadinessCheck(readinessCheck);
  }

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
    throw new Error("Non-sharded poll-cell aggregation is retired in this deployment");
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

export function derivePollMaintenanceState(
  poll: Poll,
  currentEpoch: bigint
): PollMaintenanceState {
  const activeCurrentCodePoll =
    poll.shardCount > 0 && poll.shardCount <= MAX_ACTIVE_TALLY_SHARDS;
  const mergeRequired = activeCurrentCodePoll && poll.shardCount > MAX_DIRECT_CLOSE_SHARDS;
  const laneDomain = deriveIndexedLaneDomainState(poll);
  const mergeCoverage = deriveSelectedMergeCoverage(poll);
  const earliestFinalizeEpoch = poll.deadline + FINALIZATION_GRACE_EPOCHS + 1n;
  const earliestCreatorCloseEpoch = earliestFinalizeEpoch;
  const earliestForceCloseEpoch = poll.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1n;
  const creatorCloseTimingReached = currentEpoch >= earliestCreatorCloseEpoch;
  const forceCloseTimingReached = currentEpoch >= earliestForceCloseEpoch;
  const mergeSelectionCount = poll.tallyFrontier.selectedMergeResultIds.length;
  const selectedFrontierComponentCount =
    poll.tallyFrontier.selectedMergeResultIds.length + poll.tallyFrontier.selectedShardIds.length;
  const sourceUsesMergeResults =
    poll.tallyFrontier.source === "merge-frontier" ||
    poll.tallyFrontier.source === "complete-merge";
  const liveLaneSetFullyFinalized = poll.tallyShards.every((shard) => shard.finalized);
  const hasCompleteMergeResult = poll.tallyMergeResults.some((result) => {
    try {
      return (
        normalizeHexString(result.pollId) === normalizeHexString(poll.id) &&
        tallyMergeCoverageComplete(result.coverage, poll.shardCount)
      );
    } catch {
      return false;
    }
  });
  const directCloseReady =
    activeCurrentCodePoll &&
    !mergeRequired &&
    laneDomain.state === "all_finalized";
  const validPartialMergeProgress =
    mergeRequired &&
    liveLaneSetFullyFinalized &&
    !mergeCoverage.malformed &&
    mergeCoverage.complete &&
    selectedFrontierComponentCount >= 2 &&
    poll.tallyFrontier.source === "merge-frontier" &&
    mergeCoverage.coveredShardCount > 0 &&
    !hasCompleteMergeResult &&
    laneDomain.state !== "malformed" &&
    laneDomain.state !== "mixed";
  const closeEvidenceReady = directCloseReady || hasCompleteMergeResult;

  const malformedFrontierSource =
    (poll.tallyFrontier.source === "closed-poll" && !poll.isClosed) ||
    (poll.tallyFrontier.source === "live-shards" && mergeSelectionCount > 0) ||
    (poll.tallyFrontier.source === "merge-frontier" && mergeSelectionCount === 0) ||
    (poll.tallyFrontier.source === "merge-frontier" && hasCompleteMergeResult) ||
    (poll.tallyFrontier.source === "complete-merge" && mergeSelectionCount !== 1) ||
    (mergeRequired && hasCompleteMergeResult && poll.tallyFrontier.source !== "complete-merge") ||
    (sourceUsesMergeResults && mergeCoverage.coveredShardCount !== poll.tallyFrontier.coveredShardCount) ||
    (sourceUsesMergeResults && mergeCoverage.complete !== poll.tallyFrontier.coverageComplete) ||
    (!mergeRequired && sourceUsesMergeResults) ||
    (!mergeRequired && poll.tallyMergeResults.length > 0);
  const malformedMergeState =
    mergeRequired &&
    ((sourceUsesMergeResults && mergeCoverage.malformed) ||
      (poll.tallyFrontier.source === "complete-merge" && !hasCompleteMergeResult));

  let kind: PollMaintenanceState["kind"];
  if (poll.isClosed) {
    kind = "closed";
  } else if (!activeCurrentCodePoll) {
    kind = "unsupported_current_code";
  } else if (
    laneDomain.state === "malformed" ||
    malformedFrontierSource ||
    malformedMergeState
  ) {
    kind = "malformed_indexed_lane_set";
  } else if (hasCompleteMergeResult) {
    kind = "ready_for_merged_close";
  } else if (directCloseReady) {
    kind = "ready_for_direct_close";
  } else if (validPartialMergeProgress) {
    kind = "merge_in_progress";
  } else if (mergeRequired && laneDomain.state === "all_finalized") {
    kind = "awaiting_merge";
  } else if (laneDomain.state === "mixed") {
    kind = "mixed_partially_finalized";
  } else if (laneDomain.state === "all_live") {
    kind = currentEpoch >= earliestFinalizeEpoch
      ? "ready_to_finalize"
      : "awaiting_finalize_threshold";
  } else {
    kind = "incomplete_indexed_lane_set";
  }

  const finalizeReady = kind === "ready_to_finalize";
  const finalizationCompleted = [
    "ready_for_direct_close",
    "awaiting_merge",
    "merge_in_progress",
    "ready_for_merged_close",
    "closed",
  ].includes(kind);
  const mergeReady = kind === "awaiting_merge" || kind === "merge_in_progress";
  const mergeInProgress = kind === "merge_in_progress";
  const creatorCloseEligible =
    activeCurrentCodePoll && !poll.isClosed && closeEvidenceReady && creatorCloseTimingReached;
  const forceCloseEligible =
    activeCurrentCodePoll && !poll.isClosed && closeEvidenceReady && forceCloseTimingReached;

  return {
    kind,
    indexedLaneDomain: laneDomain.state,
    activeCurrentCodePoll,
    missingLaneIds: laneDomain.missingLaneIds,
    earliestFinalizeEpoch,
    earliestCreatorCloseEpoch,
    earliestForceCloseEpoch,
    closeEvidenceReady,
    creatorCloseTimingReached,
    creatorCloseEligible,
    forceCloseTimingReached,
    forceCloseEligible,
    finalizeReady,
    finalizationCompleted,
    mergeRequired,
    mergeReady,
    mergeInProgress,
    hasCompleteMergeResult,
    canonicalCoveredShardCount: poll.tallyFrontier.coveredShardCount,
    canonicalCoverageComplete: poll.tallyFrontier.coverageComplete,
  };
}

export function selectCloseTimeIntentRefunds<T>(
  candidates: Array<CloseIntentRefundCandidate<T>>,
  options: {
    pollTypeHash: string;
    maxRefunds?: number;
  }
): CloseIntentRefundSelection<T> {
  const maxRefunds = options.maxRefunds ?? MAX_CLOSE_INTENT_REFUNDS;
  if (!Number.isInteger(maxRefunds) || maxRefunds < 0) {
    throw new Error("Close-time refund cap must be a non-negative integer");
  }

  const pollTypeHash = options.pollTypeHash.toLowerCase();
  const scoped = candidates
    .filter((candidate) => candidate.pollTypeHash.toLowerCase() === pollTypeHash)
    .sort((left, right) => {
      if (left.aggregated !== right.aggregated) return left.aggregated ? 1 : -1;
      return (left.sortKey ?? "").localeCompare(right.sortKey ?? "");
    });

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

/**
 * Reports tally-lane progress for one poll.
 * Merge coverage decoding is defensive because indexed cells are discovery
 * data, not consensus authority.
 */
export function getPollTallyProgress(poll: Poll): {
  indexedShardCount: number;
  finalizedShardCount: number;
  allShardsFinalized: boolean;
  unfinalizedShardCount: number;
  requiresMerge: boolean;
  hasCompleteMergeResult: boolean;
  closeStateReady: boolean;
} {
  const indexedShardCount = poll.tallyShards.length;
  const finalizedShardCount = poll.tallyShards.filter((shard) => shard.finalized).length;
  const allShardsFinalized =
    poll.shardCount > 0 &&
    indexedShardCount === poll.shardCount &&
    finalizedShardCount === poll.shardCount;
  const activeCurrentCodePoll = poll.shardCount <= MAX_ACTIVE_TALLY_SHARDS;
  const requiresMerge = activeCurrentCodePoll && poll.shardCount > MAX_DIRECT_CLOSE_SHARDS;
  const hasCompleteMergeResult =
    requiresMerge &&
    poll.tallyMergeResults.some((result) => {
      try {
        return tallyMergeCoverageComplete(result.coverage, poll.shardCount);
      } catch {
        return false;
      }
    });

  return {
    indexedShardCount,
    finalizedShardCount,
    allShardsFinalized,
    unfinalizedShardCount: poll.tallyShards.filter((shard) => !shard.finalized).length,
    requiresMerge,
    hasCompleteMergeResult,
    closeStateReady:
      activeCurrentCodePoll && ((!requiresMerge && allShardsFinalized) || (requiresMerge && hasCompleteMergeResult)),
  };
}

/**
 * Builds the lifecycle strip for one selected poll.
 *
 * Scoped to a single poll because a dashboard-wide strip cannot describe a
 * lifecycle: it mixed unrelated polls and left delegation steps reading "live"
 * with no poll open. Delegation is not a poll lifecycle stage, so it is
 * reported in the delegation panel instead of here.
 */
export function buildProtocolTimeline(
  poll: Poll | null,
  currentEpoch: bigint
): ProtocolTimelineStep[] {
  if (!poll) {
    return [
      {
        op: "CREATE_POLL",
        label: "Create poll cell",
        detail: "Lock creator deposit and initialize governance state.",
        state: "live",
      },
      {
        op: "CREATE_VOTE_INTENT",
        label: "Record vote intent",
        detail: "Store independent voter or delegated intent cells.",
        state: "pending",
      },
      {
        op: "CREATE_TALLY_SHARD",
        label: "Aggregate into lanes",
        detail: "Batch pending intents into tally lane state.",
        state: "pending",
      },
      {
        op: "CREATE_TALLY_SHARD",
        label: "Finalize lanes",
        detail: "Freeze the complete ordered tally-lane set after the aggregation grace.",
        state: "pending",
      },
      {
        op: "CLOSE_POLL",
        label: "Close or recover",
        detail: "Creator closes after the one-epoch aggregation grace; anyone can force-close after grace.",
        state: "pending",
      },
    ];
  }

  const progress = getPollTallyProgress(poll);
  const maintenanceState = derivePollMaintenanceState(poll, currentEpoch);
  const activeCurrentCodePoll = maintenanceState.activeCurrentCodePoll;
  const votingSupported = isPollVotingSupported(poll);
  const isExpired = currentEpoch > poll.deadline;
  const isOpen = !poll.isClosed && !isExpired;
  const hasIntent = poll.totalVoters > 0n || poll.pendingIntentCount > 0n;
  const hasPending = poll.pendingIntentCount > 0n;
  const hasAggregated = poll.totalVotes > 0n || poll.tallyShards.some((shard) => shard.totalVoters > 0n);

  // Weighted polls are recovery-only: voting and aggregation are never valid
  // paths for them, so those stages are terminal-skipped rather than pending.
  // Reporting them as pending presented a disabled path as unfinished work.
  // A closed poll is likewise terminal: a stage that never ran cannot run now.
  const intentState: ProtocolTimelineStep["state"] = !votingSupported
    ? "skipped"
    : isOpen
      ? "live"
      : hasIntent
        ? "completed"
        : poll.isClosed
          ? "skipped"
          : "pending";

  const aggregateState: ProtocolTimelineStep["state"] = !votingSupported
    ? "skipped"
    : poll.isClosed
      ? hasAggregated
        ? "completed"
        : // A closed poll that counted nothing never aggregated and never will;
          // its close transaction already consumed the lane cells.
          "skipped"
      : hasPending && maintenanceState.finalizationCompleted
        ? "ended"
        : hasPending
          ? "live"
          : hasAggregated
            ? "completed"
            : "pending";

  const finalizeState: ProtocolTimelineStep["state"] =
    poll.isClosed || maintenanceState.finalizationCompleted
      ? "completed"
      : maintenanceState.finalizeReady
        ? "live"
        : "pending";

  const closeState: ProtocolTimelineStep["state"] = poll.isClosed
    ? "completed"
    : maintenanceState.creatorCloseEligible || maintenanceState.forceCloseEligible
      ? "live"
      : "pending";

  const finalizeDetail = poll.isClosed
    ? "Every lane was finalized before this poll closed."
    : maintenanceState.kind === "ready_for_direct_close"
      ? "Every lane is finalized and direct-close evidence is ready."
      : maintenanceState.kind === "awaiting_merge"
        ? "Every lane is finalized. Merge work is still required before close."
        : maintenanceState.kind === "merge_in_progress"
          ? "Every remaining indexed lane is finalized, and a valid partial merge frontier is indexed. More merge work is still required before close."
          : maintenanceState.kind === "ready_for_merged_close"
            ? "A complete merge result is indexed. Lane finalization is complete and close evidence is ready."
            : maintenanceState.kind === "mixed_partially_finalized"
              ? "Indexed lanes are partially finalized. This mixed state is shown read-only until the indexed lane set is corrected."
              : maintenanceState.kind === "incomplete_indexed_lane_set"
                ? "The complete live lane set is not fully indexed yet, so finalization stays unavailable."
                : maintenanceState.kind === "malformed_indexed_lane_set"
                  ? "Indexed lane data is malformed for this poll, so finalization stays unavailable."
                  : `${progress.finalizedShardCount.toString()}/${poll.shardCount.toString()} lanes finalized. Current-code polls finalize the complete ordered lane set in one transaction after the aggregation grace.`;

  const steps: ProtocolTimelineStep[] = [
    {
      op: "CREATE_POLL",
      label: "Create poll cell",
      detail: "Creator deposit locked and governance state initialized.",
      state: "completed",
    },
    {
      op: "CREATE_VOTE_INTENT",
      label: "Record vote intent",
      detail: !votingSupported
        ? UNSUPPORTED_WEIGHTED_POLL_LABEL
        : hasIntent
          ? `${poll.totalVoters.toString()} counted, ${poll.pendingIntentCount.toString()} pending.`
          : isOpen
            ? "Voting is open; no intent cells indexed yet."
            : "No vote intents were recorded before the deadline.",
      state: intentState,
    },
    {
      op: "CREATE_TALLY_SHARD",
      label: "Aggregate into lanes",
      detail: !votingSupported
        ? "Aggregation is disabled for this recovery-only poll."
        : hasPending && progress.allShardsFinalized
          ? `Aggregation ended when all lanes were finalized; ${poll.pendingIntentCount.toString()} indexed timely intent(s) remain uncounted and refundable after close.`
          : hasPending
          ? `${poll.pendingIntentCount.toString()} pending intent(s) not yet aggregated.`
          : hasAggregated
            ? "All indexed intents are aggregated into tally lanes."
            : poll.isClosed
              ? "Nothing was aggregated; this poll closed with no counted votes."
              : "Nothing to aggregate yet.",
      state: aggregateState,
    },
    {
      op: "CREATE_TALLY_SHARD",
      label: "Finalize lanes",
      // A close transaction consumes the lane cells, so a closed poll indexes
      // zero of them. Reporting the live count there would read "0/8 finalized"
      // next to a completed state, so describe the outcome instead.
      detail: finalizeDetail,
      state: finalizeState,
    },
  ];

  if (progress.requiresMerge) {
    steps.push({
      op: "MERGE_TALLY_SHARDS",
      label: "Merge lanes",
      detail: !activeCurrentCodePoll
        ? `Current-code merge applies only through ${MAX_ACTIVE_TALLY_SHARDS.toString()} active lanes; larger historical polls require their original contract.`
        : maintenanceState.kind === "ready_for_merged_close"
          ? "A complete merge result is indexed, so close evidence is ready."
          : maintenanceState.kind === "merge_in_progress"
            ? "A valid partial merge frontier is indexed, and every remaining live lane is already finalized. More merge work is still required before close."
            : maintenanceState.kind === "malformed_indexed_lane_set"
              ? "Indexed lane or merge evidence is malformed, so merge maintenance stays read-only until the indexed state is corrected."
              : maintenanceState.kind === "incomplete_indexed_lane_set"
                ? "The finalized lane set or canonical merge frontier is still incomplete in the current indexer view."
                : `Polls with 9-${MAX_ACTIVE_TALLY_SHARDS.toString()} lanes need one complete merge result before close.`,
      state: poll.isClosed || maintenanceState.kind === "ready_for_merged_close"
        ? "completed"
        : maintenanceState.kind === "merge_in_progress" || maintenanceState.kind === "awaiting_merge"
          ? "live"
          : "pending",
    });
  }

  steps.push({
    op: "CLOSE_POLL",
    label: "Close or recover",
    detail: poll.isClosed
      ? "Poll is closed and deposits were returned by the close transaction."
      : !activeCurrentCodePoll
        ? `Current-code close support stops above ${MAX_ACTIVE_TALLY_SHARDS.toString()} lanes; larger historical polls require their original contract.`
        : !maintenanceState.creatorCloseTimingReached
          ? `Creator close becomes valid after epoch ${maintenanceState.earliestCreatorCloseEpoch.toString()}. Permissionless force-close becomes valid after epoch ${maintenanceState.earliestForceCloseEpoch.toString()}.`
          : maintenanceState.closeEvidenceReady
            ? maintenanceState.forceCloseTimingReached
              ? "Close evidence is ready, and the later permissionless force-close threshold is also open now."
              : "Close evidence is ready. Creator close can run now, and permissionless force-close opens later if the poll still remains open."
            : maintenanceState.forceCloseTimingReached
              ? "The later force-close timing threshold is open, but finalization or merge evidence is still required before this poll can close."
              : "The creator-close timing window is open, but finalization or merge evidence is still required.",
    state: closeState,
  });

  return steps;
}
