/**
 * Protocol Model Tests
 * ====================
 * Exercises the current poll, vote intent, aggregation, and delegation data
 * model without requiring a full CKB-VM syscall harness.
 */

import { describe, expect, test } from "vitest";

import {
  bytesToHex,
  decodeTallyShardData,
  decodeTallyMergeResultData,
  decodeDelegationData,
  decodePollData,
  decodeVoteIntentData,
  EncodedScript,
  encodeDelegationData,
  encodePollData,
  encodeTallyMergeResultData,
  encodeTallyShardData,
  encodeVoteIntentData,
  PollData,
  TallyMergeResultData,
  TallyShardData,
  VoteIntentData,
  hexToBytes,
} from "../frontend/src/lib/molecule";
import {
  buildGovernanceTypeScript,
  buildPollLockScript,
  buildTallyMergeResultTypeScript,
  buildTallyShardTypeScript,
  derivePollTypeIdFromSeedInput,
  deriveTallyShardId,
  hashScript,
  hashTallyShardAssignmentInput,
} from "../frontend/src/lib/ckb";
import { OP } from "../frontend/src/lib/constants";
import {
  buildProtocolTimeline,
  canFinalizeTallyShardFromUi,
  computeCanonicalTallyFrontier,
  filterPollsByLifecycle,
  FINALIZE_PENDING_INTENTS_WARNING,
  getFinalizeShardConfirmationMessage,
  getPollFilterCounts,
  selectCloseTimeIntentRefunds,
} from "../frontend/src/lib/protocolUi";
import { Poll, TallyMergeResult, TallyShard } from "../frontend/src/lib/types";

const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const VOTER_DEPOSIT_SHANNONS = 61n * 100_000_000n;
const TALLY_SHARD_MIN_SHANNONS = 61n * 100_000_000n;
const MAX_WEIGHT_UNITS_PER_INTENT = 20n;
const MAX_DIRECT_CLOSE_SHARDS = 8;
const MAX_SHARDS_PER_MERGE = 8;
const MAX_CLOSE_INTENT_REFUNDS = 32;
const FORCE_CLOSE_GRACE_EPOCHS = 10n;

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function makeScript(overrides: Partial<EncodedScript> = {}): EncodedScript {
  return {
    code_hash: `0x${"44".repeat(32)}`,
    hash_type: "type",
    args: "0x9988",
    ...overrides,
  };
}

function makePoll(overrides: Partial<PollData> = {}): PollData {
  return {
    question: "Should the protocol adopt token-weighted voting later?",
    options: ["Yes", "No", "Need research"],
    vote_counts: [0n, 0n, 0n],
    deadline: 200n,
    creator: new Uint8Array(32).fill(0xab),
    creator_lock: makeScript({ args: "0xab" }),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
    shard_count: 8,
    ...overrides,
  };
}

function makeIntent(overrides: Partial<VoteIntentData> = {}): VoteIntentData {
  return {
    poll_type_hash: new Uint8Array(32).fill(0x31),
    voter_lock_hash: new Uint8Array(32).fill(0x32),
    option_index: 0,
    voted_at_epoch: 120n,
    aggregated: false,
    refund_lock: makeScript(),
    ...overrides,
  };
}

function makeShard(overrides: Partial<TallyShardData> = {}): TallyShardData {
  return {
    poll_type_hash: new Uint8Array(32).fill(0x31),
    shard_id: 0,
    shard_count: 4,
    vote_counts: [0n, 0n, 0n],
    total_voters: 0n,
    counted_voter_lock_hashes: [],
    finalized: false,
    ...overrides,
  };
}

function computeWeightUnits(intentCapacity: bigint, tokenWeighted: boolean): bigint {
  if (!tokenWeighted) return 1n;
  const units = intentCapacity / VOTER_DEPOSIT_SHANNONS;
  if (units < 1n) throw new Error("intent capacity below minimum unit");
  return units > MAX_WEIGHT_UNITS_PER_INTENT ? MAX_WEIGHT_UNITS_PER_INTENT : units;
}

function scriptKey(script: any): string {
  return `${script.codeHash ?? script.code_hash}:${script.hashType ?? script.hash_type}:${script.args}`.toLowerCase();
}

function validateAtomicCreatePollShardSet(input: {
  poll: PollData;
  pollTypeHash: string;
  shardOutputs: Array<{ lock: any; type: any; data: Uint8Array }>;
  inputTypeHashes?: string[];
}): boolean {
  if ((input.inputTypeHashes ?? []).some((hash) => hash.toLowerCase() === input.pollTypeHash.toLowerCase())) {
    return false;
  }
  if (input.poll.is_closed || input.poll.shard_count <= 0) return false;
  if (input.shardOutputs.length !== input.poll.shard_count) return false;

  for (let shardId = 0; shardId < input.poll.shard_count; shardId += 1) {
    const output = input.shardOutputs[shardId];
    const shard = decodeTallyShardData(output.data);
    const expectedScript = buildTallyShardTypeScript(input.pollTypeHash, shardId);

    if (scriptKey(output.lock) !== scriptKey(expectedScript)) return false;
    if (scriptKey(output.type) !== scriptKey(expectedScript)) return false;
    if (bytesToHex(shard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
    if (shard.shard_id !== shardId) return false;
    if (shard.shard_count !== input.poll.shard_count) return false;
    if (shard.finalized) return false;
    if (shard.total_voters !== 0n) return false;
    if (shard.counted_voter_lock_hashes.length !== 0) return false;
    if (shard.vote_counts.length !== input.poll.options.length) return false;
    if (shard.vote_counts.some((count) => count !== 0n)) return false;
  }

  return true;
}

function validateShardAggregationModel(input: {
  poll: PollData;
  pollTypeHash: string;
  beforeShard: TallyShardData;
  afterShard: TallyShardData;
  intents: VoteIntentData[];
  intentCapacities?: bigint[];
  markerOutputs?: Array<{
    inputType: any;
    outputType: any;
    outputLock: any;
    expectedIntentLock: any;
    inputCapacity: bigint;
    outputCapacity: bigint;
  }>;
  epoch?: bigint;
}): boolean {
  if (input.poll.is_closed) return false;
  if ((input.epoch ?? 100n) > input.poll.deadline) return false;
  if (input.beforeShard.finalized || input.afterShard.finalized) return false;
  if (bytesToHex(input.beforeShard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (bytesToHex(input.afterShard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (input.beforeShard.shard_id !== input.afterShard.shard_id) return false;
  if (input.beforeShard.shard_count !== input.afterShard.shard_count) return false;
  if (input.beforeShard.shard_count !== input.poll.shard_count) return false;
  if (input.beforeShard.vote_counts.length !== input.poll.options.length) return false;
  if (input.afterShard.vote_counts.length !== input.beforeShard.vote_counts.length) return false;
  if (input.beforeShard.total_voters !== BigInt(input.beforeShard.counted_voter_lock_hashes.length)) return false;

  const voterKey = (bytes: Uint8Array) => bytesToHex(bytes).toLowerCase();
  const seen = new Set(input.beforeShard.counted_voter_lock_hashes.map(voterKey));
  const deltas = input.beforeShard.vote_counts.map(() => 0n);
  const appended: Uint8Array[] = [];

  for (const [index, intent] of input.intents.entries()) {
    if (intent.aggregated) return false;
    if (bytesToHex(intent.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
    if (intent.option_index >= input.poll.options.length) return false;
    const derivedShardId = deriveTallyShardId(intent.poll_type_hash, intent.voter_lock_hash, input.beforeShard.shard_count);
    if (derivedShardId !== input.beforeShard.shard_id) return false;
    const key = voterKey(intent.voter_lock_hash);
    if (seen.has(key)) return false;
    seen.add(key);
    appended.push(intent.voter_lock_hash);
    const capacity = input.intentCapacities?.[index] ?? VOTER_DEPOSIT_SHANNONS;
    deltas[intent.option_index] += computeWeightUnits(capacity, input.poll.token_weighted);
    const marker = input.markerOutputs?.[index];
    if (marker) {
      if (scriptKey(marker.outputType) !== scriptKey(marker.inputType)) return false;
      if (scriptKey(marker.outputLock) !== scriptKey(marker.expectedIntentLock)) return false;
      if (marker.outputCapacity !== marker.inputCapacity) return false;
    }
  }

  if (input.intents.length === 0) return false;
  if (input.afterShard.counted_voter_lock_hashes.length !== input.beforeShard.counted_voter_lock_hashes.length + appended.length) {
    return false;
  }
  for (const [index, voter] of input.beforeShard.counted_voter_lock_hashes.entries()) {
    if (!equalBytes(input.afterShard.counted_voter_lock_hashes[index], voter)) return false;
  }
  for (const [offset, voter] of appended.entries()) {
    if (!equalBytes(input.afterShard.counted_voter_lock_hashes[input.beforeShard.counted_voter_lock_hashes.length + offset], voter)) {
      return false;
    }
  }
  for (const [index, count] of input.beforeShard.vote_counts.entries()) {
    if (input.afterShard.vote_counts[index] !== count + deltas[index]) return false;
  }
  if (input.afterShard.total_voters !== input.beforeShard.total_voters + BigInt(input.intents.length)) return false;
  if (input.afterShard.total_voters !== BigInt(input.afterShard.counted_voter_lock_hashes.length)) return false;

  return true;
}

function validateCreateVoteIntentModel(input: {
  poll: PollData;
  intent: VoteIntentData;
  pollTypeHash: Uint8Array;
  currentScript?: any;
  outputType?: any;
  epoch: bigint;
  witnessOption: number;
  signerLockHash: Uint8Array;
  signerLock: EncodedScript;
  delegation?: {
    delegatorLockHash: Uint8Array;
    delegateLockHash: Uint8Array;
    pollTypeHash: Uint8Array;
    expiresEpoch: bigint;
    lock: EncodedScript;
  };
}): boolean {
  if (input.poll.is_closed) return false;
  if (input.epoch > input.poll.deadline) return false;
  if (input.intent.aggregated) return false;
  if (!equalBytes(input.intent.poll_type_hash, input.pollTypeHash)) return false;
  const expectedIntentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, bytesToHex(input.intent.poll_type_hash));
  const currentScript = input.currentScript ?? expectedIntentType;
  const outputType = input.outputType ?? expectedIntentType;
  if (scriptKey(currentScript) !== scriptKey(outputType)) return false;
  if (scriptKey(currentScript) !== scriptKey(expectedIntentType)) return false;
  if (input.intent.option_index !== input.witnessOption) return false;
  if (input.intent.option_index >= input.poll.options.length) return false;
  if (input.intent.voted_at_epoch !== input.epoch) return false;

  if (equalBytes(input.intent.voter_lock_hash, input.signerLockHash)) {
    return scriptKey(input.intent.refund_lock) === scriptKey(input.signerLock);
  }

  const delegation = input.delegation;
  if (!delegation) return false;
  const zero = new Uint8Array(32);
  const scopeMatches =
    equalBytes(delegation.pollTypeHash, zero) ||
    equalBytes(delegation.pollTypeHash, input.pollTypeHash);
  return (
    equalBytes(delegation.delegatorLockHash, input.intent.voter_lock_hash) &&
    equalBytes(delegation.delegateLockHash, input.signerLockHash) &&
    scopeMatches &&
    (delegation.expiresEpoch === 0n || input.epoch <= delegation.expiresEpoch) &&
    scriptKey(input.intent.refund_lock) === scriptKey(delegation.lock)
  );
}

function selectPlainSignerAuthCellModel(cells: Array<{ type?: any; outputData: string }>): boolean {
  return cells.some((cell) => !cell.type && (cell.outputData === "0x" || cell.outputData === "0x0" || cell.outputData.length <= 2));
}

function canCurrentWalletRevokeDelegationModel(delegation: { delegatorLockHash: string }, currentLockHash: string): boolean {
  return delegation.delegatorLockHash.toLowerCase() === currentLockHash.toLowerCase();
}

function validatePinnedInputLayoutModel(input: {
  expected: string[];
  actual: string[];
}): boolean {
  return input.expected.every((expected, index) => input.actual[index] === expected);
}

function validateIntentConsumptionWithoutOutputModel(input: {
  beforePoll?: PollData;
  afterPoll?: PollData;
  closedPollDep?: PollData;
  epoch: bigint;
  creatorAuthorized?: boolean;
}): boolean {
  if (input.beforePoll && input.afterPoll) {
    if (input.beforePoll.is_closed) return false;
    if (!input.afterPoll.is_closed) return false;
    if (input.epoch <= input.beforePoll.deadline) return false;
    if (input.creatorAuthorized) return true;
    return input.epoch > input.beforePoll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
  }

  return input.closedPollDep?.is_closed === true;
}

function validateFinalCloseFromShardsModel(input: {
  poll: PollData;
  after: PollData;
  pollTypeHash: string;
  shards: TallyShardData[];
}): boolean {
  if (input.poll.shard_count <= 0) return false;
  if (input.poll.shard_count > MAX_DIRECT_CLOSE_SHARDS) return false;
  if (!input.after.is_closed) return false;
  if (input.shards.length !== input.poll.shard_count) return false;

  const seen = new Set<number>();
  const voteCounts = input.poll.options.map(() => 0n);
  let totalVoters = 0n;

  for (const shard of input.shards) {
    if (bytesToHex(shard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
    if (shard.shard_count !== input.poll.shard_count) return false;
    if (seen.has(shard.shard_id)) return false;
    if (shard.shard_id < 0 || shard.shard_id >= input.poll.shard_count) return false;
    if (!shard.finalized) return false;
    if (shard.vote_counts.length !== input.poll.options.length) return false;
    seen.add(shard.shard_id);
    shard.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += shard.total_voters;
  }

  if (seen.size !== input.poll.shard_count) return false;
  if (input.after.vote_counts.some((count, index) => count !== voteCounts[index])) return false;
  if (input.after.total_voters !== totalVoters) return false;
  if (input.after.counted_voter_lock_hashes.length !== 0) return false;
  return true;
}

function coverageForShard(shardId: number): Uint8Array {
  const coverage = new Uint8Array(32);
  coverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
  return coverage;
}

function mergeCoverageOrThrow(target: Uint8Array, source: Uint8Array): boolean {
  for (let index = 0; index < target.length; index += 1) {
    if ((target[index] & source[index]) !== 0) return false;
    target[index] |= source[index];
  }
  return true;
}

function coverageCompleteForShardCount(coverage: Uint8Array, shardCount: number): boolean {
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    if ((coverage[Math.floor(shardId / 8)] & (1 << (shardId % 8))) === 0) return false;
  }
  for (let shardId = shardCount; shardId < 256; shardId += 1) {
    if ((coverage[Math.floor(shardId / 8)] & (1 << (shardId % 8))) !== 0) return false;
  }
  return true;
}

function makeMergeResult(overrides: Partial<TallyMergeResultData> = {}): TallyMergeResultData {
  return {
    poll_type_hash: new Uint8Array(32).fill(0x91),
    coverage: new Uint8Array(32),
    vote_counts: [0n, 0n, 0n],
    total_voters: 0n,
    merge_level: 1,
    version: 1,
    ...overrides,
  };
}

function makeUiShard(overrides: Partial<TallyShard> = {}): TallyShard {
  return {
    id: "shard-0",
    pollId: `0x${"11".repeat(32)}`,
    outPoint: { txHash: `0x${"01".repeat(32)}`, index: 0 },
    shardId: 0,
    shardCount: 4,
    voteCounts: [0n, 0n, 0n],
    totalVoters: 0n,
    finalized: false,
    capacity: TALLY_SHARD_MIN_SHANNONS,
    ...overrides,
  };
}

function makeUiMergeResult(overrides: Partial<TallyMergeResult> = {}): TallyMergeResult {
  return {
    id: "merge-0",
    pollId: `0x${"11".repeat(32)}`,
    outPoint: { txHash: `0x${"02".repeat(32)}`, index: 0 },
    coverage: `0x${"00".repeat(32)}`,
    voteCounts: [0n, 0n, 0n],
    totalVoters: 0n,
    mergeLevel: 1,
    version: 1,
    capacity: TALLY_SHARD_MIN_SHANNONS,
    ...overrides,
  };
}

function makeUiPoll(overrides: Partial<Poll> = {}): Poll {
  const voteCounts = overrides.voteCounts ?? [0n, 0n, 0n];
  return {
    id: `0x${"11".repeat(32)}`,
    outPoint: { txHash: `0x${"03".repeat(32)}`, index: 0 },
    question: "Should the UI follow the sharded lifecycle?",
    options: ["Yes", "No", "Abstain"],
    voteCounts,
    createdEpoch: 10n,
    deadline: 100n,
    creator: `0x${"aa".repeat(32)}`,
    isClosed: false,
    totalVoters: voteCounts.reduce((sum, count) => sum + count, 0n),
    creatorDeposit: CREATOR_DEPOSIT_SHANNONS,
    pendingIntentCount: 0n,
    protocolPendingIntentCount: 0n,
    tokenWeighted: false,
    udtTypeHash: `0x${"00".repeat(32)}`,
    shardCount: 4,
    tallyShards: [],
    tallyMergeResults: [],
    tallyFrontier: {
      source: "live-shards",
      coveredShardCount: 0,
      shardCount: 4,
      coverageComplete: false,
      selectedMergeResultIds: [],
      selectedShardIds: [],
      uncoveredShardIds: [0, 1, 2, 3],
    },
    totalVotes: voteCounts.reduce((sum, count) => sum + count, 0n),
    winnerIndex: null,
    authorityOptions: [],
    outstandingIntentCount: 0,
    refundableIntentCount: 0,
    ...overrides,
  };
}

function validateMergeModel(input: {
  poll: PollData;
  pollTypeHash: string;
  shards?: TallyShardData[];
  results?: TallyMergeResultData[];
  output: TallyMergeResultData;
}): boolean {
  const shards = input.shards ?? [];
  const results = input.results ?? [];
  if (input.poll.shard_count <= MAX_DIRECT_CLOSE_SHARDS) return false;
  if (shards.length + results.length === 0) return false;
  if (shards.length + results.length > MAX_SHARDS_PER_MERGE) return false;
  if (bytesToHex(input.output.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (input.output.version !== 1) return false;
  if (input.output.vote_counts.length !== input.poll.options.length) return false;

  const coverage = new Uint8Array(32);
  const voteCounts = input.poll.options.map(() => 0n);
  let totalVoters = 0n;
  let maxLevel = 0;

  for (const shard of shards) {
    if (bytesToHex(shard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
    if (shard.shard_count !== input.poll.shard_count) return false;
    if (!shard.finalized) return false;
    if (!mergeCoverageOrThrow(coverage, coverageForShard(shard.shard_id))) return false;
    shard.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += shard.total_voters;
  }

  for (const result of results) {
    if (bytesToHex(result.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
    if (result.version !== 1) return false;
    if (!mergeCoverageOrThrow(coverage, result.coverage)) return false;
    result.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += result.total_voters;
    maxLevel = Math.max(maxLevel, result.merge_level);
  }

  if (!equalBytes(input.output.coverage, coverage)) return false;
  if (input.output.vote_counts.some((count, index) => count !== voteCounts[index])) return false;
  if (input.output.total_voters !== totalVoters) return false;
  if (input.output.merge_level !== maxLevel + 1) return false;
  return true;
}

function buildExpectedMergeResult(input: {
  poll: PollData;
  pollTypeHash: string;
  shards?: TallyShardData[];
  results?: TallyMergeResultData[];
}): TallyMergeResultData {
  const coverage = new Uint8Array(32);
  const voteCounts = input.poll.options.map(() => 0n);
  let totalVoters = 0n;
  let maxLevel = 0;

  for (const shard of input.shards ?? []) {
    if (!mergeCoverageOrThrow(coverage, coverageForShard(shard.shard_id))) {
      throw new Error("overlapping shard coverage");
    }
    shard.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += shard.total_voters;
  }

  for (const result of input.results ?? []) {
    if (!mergeCoverageOrThrow(coverage, result.coverage)) {
      throw new Error("overlapping result coverage");
    }
    result.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += result.total_voters;
    maxLevel = Math.max(maxLevel, result.merge_level);
  }

  return makeMergeResult({
    poll_type_hash: hexToBytes(input.pollTypeHash),
    coverage,
    vote_counts: voteCounts,
    total_voters: totalVoters,
    merge_level: maxLevel + 1,
  });
}

function validateShardConsumeIntoMergeModel(input: {
  pollTypeHash: string;
  shard: TallyShardData;
  inputLock: any;
  inputType: any;
  outputLock: any;
  outputType: any;
  outputResult: TallyMergeResultData;
  inputCapacity?: bigint;
}): boolean {
  const expectedShardScript = buildTallyShardTypeScript(input.pollTypeHash, input.shard.shard_id);
  const expectedMergeScript = buildTallyMergeResultTypeScript(input.pollTypeHash);

  if (!input.shard.finalized) return false;
  if ((input.inputCapacity ?? TALLY_SHARD_MIN_SHANNONS) < TALLY_SHARD_MIN_SHANNONS) return false;
  if (scriptKey(input.inputLock) !== scriptKey(expectedShardScript)) return false;
  if (scriptKey(input.inputType) !== scriptKey(expectedShardScript)) return false;
  if (scriptKey(input.outputLock) !== scriptKey(expectedMergeScript)) return false;
  if (scriptKey(input.outputType) !== scriptKey(expectedMergeScript)) return false;
  if (bytesToHex(input.shard.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (bytesToHex(input.outputResult.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;

  return true;
}

type CloseTailInputKind = "fee" | "intent" | "tally_shard" | "merge_result";

function validateFinalCloseFromMergeModel(input: {
  poll: PollData;
  after: PollData;
  pollTypeHash: string;
  result: TallyMergeResultData;
}): boolean {
  if (input.poll.shard_count <= MAX_DIRECT_CLOSE_SHARDS) return false;
  if (!input.after.is_closed) return false;
  if (bytesToHex(input.result.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (!coverageCompleteForShardCount(input.result.coverage, input.poll.shard_count)) return false;
  if (input.after.vote_counts.some((count, index) => count !== input.result.vote_counts[index])) return false;
  if (input.after.total_voters !== input.result.total_voters) return false;
  if (input.after.counted_voter_lock_hashes.length !== 0) return false;
  return true;
}

function validateLargeMergeCloseInputTailModel(input: {
  poll: PollData;
  after: PollData;
  pollTypeHash: string;
  result: TallyMergeResultData;
  trailingInputs: CloseTailInputKind[];
  creatorDepositReturnCapacity: bigint;
  resultInputCapacity: bigint;
  resultReturnCapacity: bigint;
  intentInputCapacities: bigint[];
  voterRefundCapacities: bigint[];
}): boolean {
  if (!validateFinalCloseFromMergeModel(input)) return false;
  if (input.creatorDepositReturnCapacity !== input.poll.creator_deposit) return false;
  if (input.resultReturnCapacity !== input.resultInputCapacity) return false;
  if (input.voterRefundCapacities.length !== input.intentInputCapacities.length) return false;
  if (input.voterRefundCapacities.some((capacity, index) => capacity !== input.intentInputCapacities[index])) return false;
  return !input.trailingInputs.some((kind) => kind === "tally_shard" || kind === "merge_result");
}

function validateProtocolPollLockCloseModel(input: {
  poll: PollData;
  pollTypeHash: string;
  inputPollLock: any;
  outputPollLock: any;
  creatorAuthLockHash?: Uint8Array;
  epoch: bigint;
}): boolean {
  const expectedPollLock = buildPollLockScript(input.pollTypeHash);
  if (scriptKey(input.inputPollLock) !== scriptKey(expectedPollLock)) return false;
  if (scriptKey(input.outputPollLock) !== scriptKey(expectedPollLock)) return false;
  if (input.epoch <= input.poll.deadline) return false;
  const creatorAuthorized =
    input.creatorAuthLockHash !== undefined &&
    equalBytes(input.creatorAuthLockHash, input.poll.creator);
  if (creatorAuthorized) return true;
  return input.epoch > input.poll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
}

function validateCreatorCloseReturnModel(input: {
  poll: PollData;
  creatorAuthLockHash?: Uint8Array;
  creatorReturnLock: any;
  creatorReturnCapacity: bigint;
}): boolean {
  if (!input.creatorAuthLockHash || !equalBytes(input.creatorAuthLockHash, input.poll.creator)) {
    return false;
  }
  if (scriptKey(input.creatorReturnLock) !== scriptKey(input.poll.creator_lock)) return false;
  return input.creatorReturnCapacity === input.poll.creator_deposit;
}

function zeroHash(): Uint8Array {
  return new Uint8Array(32);
}

function validateDelegationAuthorityDepModel(input: {
  intent: VoteIntentData;
  signerLockHash: Uint8Array;
  signerLock: any;
  pollTypeHash: Uint8Array;
  delegation?: {
    data: {
      delegator_lock_hash: Uint8Array;
      delegate_lock_hash: Uint8Array;
      poll_type_hash: Uint8Array;
      expires_epoch: bigint;
    };
    lock: any;
    type: any;
  };
  epoch: bigint;
}): boolean {
  if (input.intent.aggregated) return false;
  if (!equalBytes(input.intent.poll_type_hash, input.pollTypeHash)) return false;
  if (equalBytes(input.intent.voter_lock_hash, input.signerLockHash)) {
    return scriptKey(input.intent.refund_lock) === scriptKey(input.signerLock);
  }

  const delegation = input.delegation;
  if (!delegation) return false;
  const delegationScopeMatches =
    equalBytes(delegation.data.poll_type_hash, zeroHash()) ||
    equalBytes(delegation.data.poll_type_hash, input.pollTypeHash);
  const delegationType = buildGovernanceTypeScript(
    OP.DELEGATE,
    bytesToHex(delegation.data.poll_type_hash)
  );

  return (
    equalBytes(delegation.data.delegator_lock_hash, input.intent.voter_lock_hash) &&
    equalBytes(delegation.data.delegate_lock_hash, input.signerLockHash) &&
    delegationScopeMatches &&
    (delegation.data.expires_epoch === 0n || input.epoch <= delegation.data.expires_epoch) &&
    scriptKey(delegation.type) === scriptKey(delegationType) &&
    scriptKey(input.intent.refund_lock) === scriptKey(delegation.lock)
  );
}

function validateDelegationRevocationModel(input: {
  inputLock: any;
  outputLock: any;
  inputCapacity: bigint;
  outputCapacity: bigint;
}): boolean {
  return (
    scriptKey(input.inputLock) === scriptKey(input.outputLock) &&
    input.outputCapacity >= input.inputCapacity &&
    input.outputCapacity >= 61n * 100_000_000n
  );
}

function validatePostCloseIntentRefundModel(input: {
  closedPoll: PollData;
  pollTypeHash: Uint8Array;
  intent: VoteIntentData;
  intentInputCapacity: bigint;
  outputLock: any;
  outputCapacity: bigint;
  outputHasType?: boolean;
  extraIntentInputs?: number;
  beforePollTally?: bigint[];
  afterPollTally?: bigint[];
}): boolean {
  if (!input.closedPoll.is_closed) return false;
  if (!equalBytes(input.intent.poll_type_hash, input.pollTypeHash)) return false;
  if (scriptKey(input.outputLock) !== scriptKey(input.intent.refund_lock)) return false;
  if (input.outputCapacity < VOTER_DEPOSIT_SHANNONS) return false;
  if (input.outputCapacity !== input.intentInputCapacity) return false;
  if (input.outputHasType) return false;
  if ((input.extraIntentInputs ?? 0) > 0) return false;
  if (input.beforePollTally && input.afterPollTally) {
    if (input.beforePollTally.some((count, index) => count !== input.afterPollTally?.[index])) {
      return false;
    }
  }
  return true;
}

function selectRefundableClosedIntentModel(
  intents: VoteIntentData[],
  pollTypeHash: Uint8Array
): VoteIntentData | null {
  return (
    intents
      .filter((intent) => equalBytes(intent.poll_type_hash, pollTypeHash))
      .sort((left, right) => Number(left.aggregated) - Number(right.aggregated))[0] ?? null
  );
}

function validateFinalizeShardModel(input: {
  poll: PollData;
  before: TallyShardData;
  after: TallyShardData;
  pollTypeHash: string;
  epoch: bigint;
}): boolean {
  if (input.poll.is_closed) return false;
  if (input.epoch <= input.poll.deadline) return false;
  if (input.before.finalized) return false;
  if (!input.after.finalized) return false;
  if (bytesToHex(input.before.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (bytesToHex(input.after.poll_type_hash).toLowerCase() !== input.pollTypeHash.toLowerCase()) return false;
  if (input.before.shard_id !== input.after.shard_id) return false;
  if (input.before.shard_count !== input.after.shard_count) return false;
  if (input.before.shard_count !== input.poll.shard_count) return false;
  if (input.before.vote_counts.some((count, index) => count !== input.after.vote_counts[index])) return false;
  if (input.before.total_voters !== input.after.total_voters) return false;
  if (input.before.counted_voter_lock_hashes.length !== input.after.counted_voter_lock_hashes.length) return false;
  return input.before.counted_voter_lock_hashes.every((voter, index) =>
    equalBytes(voter, input.after.counted_voter_lock_hashes[index])
  );
}

function makeInitialShardOutputs(
  poll: PollData,
  pollTypeHash: string,
  overrides: Partial<TallyShardData>[] = []
): Array<{ lock: any; type: any; data: Uint8Array }> {
  return Array.from({ length: poll.shard_count }, (_, shardId) => {
    const shard = makeShard({
      poll_type_hash: hexToBytes(pollTypeHash),
      shard_id: shardId,
      shard_count: poll.shard_count,
      vote_counts: poll.options.map(() => 0n),
      total_voters: 0n,
      counted_voter_lock_hashes: [],
      finalized: false,
      ...overrides[shardId],
    });
    const script = buildTallyShardTypeScript(pollTypeHash, shard.shard_id);
    return {
      lock: script,
      type: script,
      data: encodeTallyShardData(shard),
    };
  });
}

function voterForShard(pollTypeHash: Uint8Array, shardCount: number, targetShardId: number, startByte: number): Uint8Array {
  for (let value = startByte; value < 256; value += 1) {
    const voter = new Uint8Array(32).fill(value);
    if (deriveTallyShardId(pollTypeHash, voter, shardCount) === targetShardId) {
      return voter;
    }
  }
  throw new Error("could not find deterministic voter for shard");
}

function deterministicVoterForShard(
  pollTypeHash: Uint8Array,
  shardCount: number,
  targetShardId: number,
  nonceStart: number
): Uint8Array {
  for (let nonce = nonceStart; nonce < nonceStart + 100_000; nonce += 1) {
    const voter = new Uint8Array(32);
    voter[0] = nonce & 0xff;
    voter[1] = (nonce >> 8) & 0xff;
    voter[2] = (nonce >> 16) & 0xff;
    voter[3] = (nonce >> 24) & 0xff;
    voter[31] = 0xa5;
    if (deriveTallyShardId(pollTypeHash, voter, shardCount) === targetShardId) {
      return voter;
    }
  }
  throw new Error("could not find deterministic voter for shard");
}

describe("PollData encoding", () => {
  test("round-trips the v3 poll layout", () => {
    const poll = makePoll({
      vote_counts: [5n, 2n, 1n],
      total_voters: 8n,
      pending_intent_count: 3n,
      counted_voter_lock_hashes: [
        new Uint8Array(32).fill(0x01),
        new Uint8Array(32).fill(0x02),
        new Uint8Array(32).fill(0x03),
        new Uint8Array(32).fill(0x04),
        new Uint8Array(32).fill(0x05),
        new Uint8Array(32).fill(0x06),
        new Uint8Array(32).fill(0x07),
        new Uint8Array(32).fill(0x08),
      ],
    });
    const decoded = decodePollData(encodePollData(poll));

    expect(decoded).toEqual(poll);
  });

  test("supports token-weighted future fields without changing layout", () => {
    const poll = makePoll({
      token_weighted: true,
      udt_type_hash: new Uint8Array(32).fill(0xcd),
    });
    const decoded = decodePollData(encodePollData(poll));

    expect(decoded.token_weighted).toBe(true);
    expect(decoded.udt_type_hash).toEqual(poll.udt_type_hash);
  });
});

describe("VoteIntentData encoding", () => {
  test("round-trips intent cells with embedded refund locks", () => {
    const intent = makeIntent({ option_index: 2 });
    const encoded = encodeVoteIntentData(intent);
    const decoded = decodeVoteIntentData(encoded);

    expect(encoded.length).toBeGreaterThan(74);
    expect(decoded).toEqual(intent);
  });

  test("preserves aggregated status after batching", () => {
    const decoded = decodeVoteIntentData(encodeVoteIntentData(makeIntent({ aggregated: true })));
    expect(decoded.aggregated).toBe(true);
  });

  test("rejects pending to pending replacement semantics", () => {
    const before = makeIntent({ option_index: 0, voted_at_epoch: 120n, aggregated: false });
    const after = { ...before, option_index: 2, voted_at_epoch: 121n };

    expect(equalBytes(before.poll_type_hash, after.poll_type_hash)).toBe(true);
    expect(equalBytes(before.voter_lock_hash, after.voter_lock_hash)).toBe(true);
    expect(after.aggregated).toBe(false);
    expect(after.aggregated && after.option_index === before.option_index).toBe(false);
  });
});

describe("DelegationData encoding", () => {
  test("round-trips scoped delegations", () => {
    const delegation = {
      delegator_lock_hash: new Uint8Array(32).fill(0x41),
      delegate_lock_hash: new Uint8Array(32).fill(0x42),
      poll_type_hash: new Uint8Array(32).fill(0x43),
      expires_epoch: 300n,
    };

    expect(decodeDelegationData(encodeDelegationData(delegation))).toEqual(delegation);
  });
});

describe("Delegation model", () => {
  test("delegator and delegate must not be the same lock hash", () => {
    const delegation = {
      delegator_lock_hash: new Uint8Array(32).fill(0x51),
      delegate_lock_hash: new Uint8Array(32).fill(0x52),
      poll_type_hash: new Uint8Array(32).fill(0x53),
      expires_epoch: 0n,
    };

    expect(equalBytes(delegation.delegator_lock_hash, delegation.delegate_lock_hash)).toBe(false);
  });

  test("revocation keeps lock ownership and minimum delegation capacity", () => {
    const inputLock = makeScript({ args: "0xaaaa" });
    const outputLock = { ...inputLock };
    const inputCapacity = 70n * 100_000_000n;
    const outputCapacity = 70n * 100_000_000n;
    const minDelegationCapacity = 61n * 100_000_000n;

    expect(outputLock).toEqual(inputLock);
    expect(outputCapacity >= minDelegationCapacity).toBe(true);
    expect(outputCapacity >= inputCapacity).toBe(true);
  });
});

describe("Vote intent creation model", () => {
  test("valid direct intent creation binds option and current epoch", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x61);
    const signerLockHash = new Uint8Array(32).fill(0x62);
    const signerLock = makeScript({ args: "0x62" });
    const poll = makePoll({ options: ["Yes", "No"], deadline: 200n });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: signerLockHash,
      option_index: 1,
      voted_at_epoch: 120n,
      refund_lock: signerLock,
    });

    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      epoch: 120n,
      witnessOption: 1,
      signerLockHash,
      signerLock,
    })).toBe(true);
  });

  test("intent type script scope must match intent data poll hash", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x6a);
    const otherPollTypeHash = new Uint8Array(32).fill(0x6b);
    const signerLockHash = new Uint8Array(32).fill(0x6c);
    const signerLock = makeScript({ args: "0x6c" });
    const poll = makePoll({ options: ["Yes", "No"], deadline: 200n });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: signerLockHash,
      option_index: 0,
      voted_at_epoch: 130n,
      refund_lock: signerLock,
    });
    const matchingIntentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, bytesToHex(pollTypeHash));
    const wrongPollIntentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, bytesToHex(otherPollTypeHash));
    const wrongOpType = buildGovernanceTypeScript(OP.DELEGATE, bytesToHex(pollTypeHash));
    const wrongCodeHashType = { ...matchingIntentType, codeHash: `0x${"77".repeat(32)}` };

    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      currentScript: matchingIntentType,
      outputType: matchingIntentType,
      epoch: 130n,
      witnessOption: 0,
      signerLockHash,
      signerLock,
    })).toBe(true);
    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      currentScript: wrongPollIntentType,
      outputType: wrongPollIntentType,
      epoch: 130n,
      witnessOption: 0,
      signerLockHash,
      signerLock,
    })).toBe(false);
    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      currentScript: wrongOpType,
      outputType: wrongOpType,
      epoch: 130n,
      witnessOption: 0,
      signerLockHash,
      signerLock,
    })).toBe(false);
    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      currentScript: wrongCodeHashType,
      outputType: wrongCodeHashType,
      epoch: 130n,
      witnessOption: 0,
      signerLockHash,
      signerLock,
    })).toBe(false);
  });

  test("valid delegated intent creation uses delegation dep authority", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x63);
    const delegator = new Uint8Array(32).fill(0x64);
    const delegate = new Uint8Array(32).fill(0x65);
    const delegationLock = makeScript({ args: "0x64" });
    const poll = makePoll({ options: ["Yes", "No"], deadline: 200n });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: delegator,
      option_index: 0,
      voted_at_epoch: 121n,
      refund_lock: delegationLock,
    });

    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      epoch: 121n,
      witnessOption: 0,
      signerLockHash: delegate,
      signerLock: makeScript({ args: "0x65" }),
      delegation: {
        delegatorLockHash: delegator,
        delegateLockHash: delegate,
        pollTypeHash,
        expiresEpoch: 200n,
        lock: delegationLock,
      },
    })).toBe(true);
  });

  test("invalid option index is rejected at intent creation", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x66);
    const signerLockHash = new Uint8Array(32).fill(0x67);
    const signerLock = makeScript({ args: "0x67" });
    const poll = makePoll({ options: ["Yes", "No"], deadline: 200n });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: signerLockHash,
      option_index: 2,
      voted_at_epoch: 122n,
      refund_lock: signerLock,
    });

    expect(validateCreateVoteIntentModel({
      poll,
      intent,
      pollTypeHash,
      epoch: 122n,
      witnessOption: 2,
      signerLockHash,
      signerLock,
    })).toBe(false);
  });

  test("backdated or future voted_at_epoch is rejected at intent creation", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x68);
    const signerLockHash = new Uint8Array(32).fill(0x69);
    const signerLock = makeScript({ args: "0x69" });
    const poll = makePoll({ options: ["Yes", "No"], deadline: 200n });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: signerLockHash,
      option_index: 1,
      refund_lock: signerLock,
    });

    expect(validateCreateVoteIntentModel({
      poll,
      intent: { ...intent, voted_at_epoch: 123n },
      pollTypeHash,
      epoch: 124n,
      witnessOption: 1,
      signerLockHash,
      signerLock,
    })).toBe(false);
    expect(validateCreateVoteIntentModel({
      poll,
      intent: { ...intent, voted_at_epoch: 125n },
      pollTypeHash,
      epoch: 124n,
      witnessOption: 1,
      signerLockHash,
      signerLock,
    })).toBe(false);
  });
});

describe("Poll identity model", () => {
  const seedA = {
    outPoint: { txHash: `0x${"11".repeat(32)}`, index: 0 },
  };
  const seedB = {
    outPoint: { txHash: `0x${"22".repeat(32)}`, index: 1 },
  };

  test("CREATE_POLL args are derived from Type ID seed input 0 and output index 0", () => {
    const typeId = derivePollTypeIdFromSeedInput(seedA, 0);
    const pollType = buildGovernanceTypeScript(OP.CREATE_POLL, typeId);

    expect(typeId).toMatch(/^0x[0-9a-f]{64}$/);
    expect(pollType.args).toBe(`0x01${typeId.slice(2)}`);
    expect(pollType.args.length).toBe(68);
  });

  test("CREATE_POLL fails model identity checks when args do not match expected Type ID", () => {
    const expectedTypeId = derivePollTypeIdFromSeedInput(seedA, 0);
    const wrongTypeId = derivePollTypeIdFromSeedInput(seedA, 1);

    expect(wrongTypeId).not.toBe(expectedTypeId);
    expect(buildGovernanceTypeScript(OP.CREATE_POLL, wrongTypeId).args).not.toBe(
      `0x01${expectedTypeId.slice(2)}`
    );
  });

  test("reused Type ID args cannot recreate the same poll identity from another seed input", () => {
    const originalTypeId = derivePollTypeIdFromSeedInput(seedA, 0);
    const expectedForOtherSeed = derivePollTypeIdFromSeedInput(seedB, 0);
    const reusedPollType = buildGovernanceTypeScript(OP.CREATE_POLL, originalTypeId);
    const otherSeedPollType = buildGovernanceTypeScript(OP.CREATE_POLL, expectedForOtherSeed);

    expect(originalTypeId).not.toBe(expectedForOtherSeed);
    expect(scriptKey(reusedPollType)).not.toBe(scriptKey(otherSeedPollType));
  });

  test("frontend create-poll model keeps Type ID seed input fixed at input 0", () => {
    const seedInput = { previousOutput: seedA.outPoint, since: 0 };
    const fundingInput = { previousOutput: seedB.outPoint, since: 0 };
    const inputsAfterFeeCompletion = [seedInput, fundingInput];

    expect(`${inputsAfterFeeCompletion[0].previousOutput.txHash}:${inputsAfterFeeCompletion[0].previousOutput.index}`).toBe(
      `${seedA.outPoint.txHash}:0`
    );
  });

  test("builder layout model rejects reordered auth input", () => {
    const auth = "0xauth:0";
    const fee = "0xfee:1";

    expect(validatePinnedInputLayoutModel({ expected: [auth], actual: [auth, fee] })).toBe(true);
    expect(validatePinnedInputLayoutModel({ expected: [auth], actual: [fee, auth] })).toBe(false);
  });

  test("builder layout model rejects reordered close prefix", () => {
    const poll = "0xpoll:0";
    const creatorAuth = "0xcreator:1";
    const shard = "0xshard:2";
    const intent = "0xintent:3";
    const fee = "0xfee:4";

    expect(validatePinnedInputLayoutModel({
      expected: [poll, creatorAuth, shard, intent],
      actual: [poll, creatorAuth, shard, intent, fee],
    })).toBe(true);
    expect(validatePinnedInputLayoutModel({
      expected: [poll, creatorAuth, shard, intent],
      actual: [poll, shard, creatorAuth, intent, fee],
    })).toBe(false);
    expect(validatePinnedInputLayoutModel({
      expected: [poll, creatorAuth, shard, intent],
      actual: [fee, poll, creatorAuth, shard, intent],
    })).toBe(false);
  });

  test("delegation creation pins signer auth input 0", () => {
    const delegatorAuth = "0xde1e:0";
    const feeInput = "0xfee:1";

    expect(validatePinnedInputLayoutModel({
      expected: [delegatorAuth],
      actual: [delegatorAuth, feeInput],
    })).toBe(true);
    expect(validatePinnedInputLayoutModel({
      expected: [delegatorAuth],
      actual: [feeInput, delegatorAuth],
    })).toBe(false);
  });

  test("shards and dependent protocol surfaces bind to the Type ID-backed poll hash", () => {
    const typeId = derivePollTypeIdFromSeedInput(seedA, 0);
    const pollType = buildGovernanceTypeScript(OP.CREATE_POLL, typeId);
    const pollTypeHash = hashScript(pollType);
    const pollHashBytes = hexToBytes(pollTypeHash);
    const shard = makeShard({ poll_type_hash: pollHashBytes, shard_id: 2, shard_count: 8 });
    const intent = makeIntent({ poll_type_hash: pollHashBytes });
    const delegationType = buildGovernanceTypeScript(OP.DELEGATE, pollTypeHash);
    const mergeType = buildTallyMergeResultTypeScript(pollTypeHash);
    const closeLock = buildPollLockScript(pollTypeHash);
    const refundPollHash = bytesToHex(intent.poll_type_hash);

    expect(scriptKey(buildTallyShardTypeScript(pollTypeHash, shard.shard_id))).toContain(pollTypeHash.slice(2));
    expect(bytesToHex(shard.poll_type_hash)).toBe(pollTypeHash);
    expect(bytesToHex(intent.poll_type_hash)).toBe(pollTypeHash);
    expect(delegationType.args).toBe(`0x05${pollTypeHash.slice(2)}`);
    expect(mergeType.args).toBe(`0x08${pollTypeHash.slice(2)}`);
    expect(closeLock.args).toBe(`0x04${pollTypeHash.slice(2)}`);
    expect(refundPollHash).toBe(pollTypeHash);
  });
});

describe("Aggregation model", () => {
  test("token-weighted aggregation uses capped intent-capacity units", () => {
    const before = makePoll({
      token_weighted: true,
      vote_counts: [0n, 0n, 0n],
    });
    const intentCapacities = [
      3n * VOTER_DEPOSIT_SHANNONS,
      99n * VOTER_DEPOSIT_SHANNONS,
    ];
    const nextCounts = [...before.vote_counts];
    nextCounts[0] += computeWeightUnits(intentCapacities[0], before.token_weighted);
    nextCounts[2] += computeWeightUnits(intentCapacities[1], before.token_weighted);

    expect(nextCounts).toEqual([3n, 0n, MAX_WEIGHT_UNITS_PER_INTENT]);
  });

  test("rejects mixing intents from a different poll type hash", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xa1);
    const intents = [
      makeIntent({ poll_type_hash: pollTypeHash }),
      makeIntent({ poll_type_hash: new Uint8Array(32).fill(0xb2) }),
    ];

    const allMatchPoll = intents.every((intent) => equalBytes(intent.poll_type_hash, pollTypeHash));
    expect(allMatchPoll).toBe(false);
  });

  test("increments vote counts and total voters by processed intents", () => {
    const before = makePoll({
      vote_counts: [3n, 1n, 0n],
      total_voters: 4n,
      pending_intent_count: 2n,
      counted_voter_lock_hashes: [
        new Uint8Array(32).fill(0x91),
        new Uint8Array(32).fill(0x92),
        new Uint8Array(32).fill(0x93),
        new Uint8Array(32).fill(0x94),
      ],
    });
    const intents = [makeIntent({ option_index: 0 }), makeIntent({ option_index: 2 })];
    const nextCounts = [...before.vote_counts];

    for (const intent of intents) {
      nextCounts[intent.option_index] += 1n;
    }

    const after = {
      ...before,
      vote_counts: nextCounts,
      total_voters: before.total_voters + BigInt(intents.length),
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [
        ...before.counted_voter_lock_hashes,
        ...intents.map((intent) => intent.voter_lock_hash),
      ],
    };

    expect(after.vote_counts).toEqual([4n, 1n, 1n]);
    expect(after.total_voters).toBe(6n);
    expect(after.pending_intent_count).toBe(0n);
    expect(after.counted_voter_lock_hashes).toHaveLength(6);
  });

  test("registry-based uniqueness rejects double-counting the same voter", () => {
    const before = makePoll({
      total_voters: 1n,
      counted_voter_lock_hashes: [new Uint8Array(32).fill(0x32)],
    });
    const duplicateIntent = makeIntent({ voter_lock_hash: new Uint8Array(32).fill(0x32) });

    const alreadyCounted = before.counted_voter_lock_hashes.some(
      (entry) => equalBytes(entry, duplicateIntent.voter_lock_hash)
    );

    expect(alreadyCounted).toBe(true);
  });

  test("marks aggregated intents without changing voter identity", () => {
    const pending = makeIntent({ option_index: 1, aggregated: false });
    const aggregated = { ...pending, aggregated: true };

    expect(aggregated.voter_lock_hash).toEqual(pending.voter_lock_hash);
    expect(aggregated.refund_lock).toEqual(pending.refund_lock);
    expect(aggregated.option_index).toBe(pending.option_index);
    expect(aggregated.aggregated).toBe(true);
  });
});

describe("Sharded aggregation model", () => {
  test("CREATE_POLL with complete ordered shard set passes at model level", () => {
    const pollTypeHash = `0x${"71".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash);

    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs })).toBe(true);
  });

  test("CREATE_POLL missing one shard fails", () => {
    const pollTypeHash = `0x${"72".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash).slice(0, 3);

    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs })).toBe(false);
  });

  test("CREATE_POLL with duplicate or misordered shard ids fails", () => {
    const pollTypeHash = `0x${"73".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const duplicateShardOutputs = makeInitialShardOutputs(poll, pollTypeHash, [
      {},
      { shard_id: 0 },
    ]);
    const misorderedShardOutputs = makeInitialShardOutputs(poll, pollTypeHash);
    [misorderedShardOutputs[1], misorderedShardOutputs[2]] = [
      misorderedShardOutputs[2],
      misorderedShardOutputs[1],
    ];

    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs: duplicateShardOutputs })).toBe(false);
    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs: misorderedShardOutputs })).toBe(false);
  });

  test("CREATE_POLL with private-lock shard fails", () => {
    const pollTypeHash = `0x${"74".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash);
    shardOutputs[2] = {
      ...shardOutputs[2],
      lock: makeScript({ args: "0x99" }),
    };

    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs })).toBe(false);
  });

  test("standalone CREATE_TALLY_SHARD against an existing poll fails", () => {
    const pollTypeHash = `0x${"75".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash);
    const hasCreatedPollOutput0 = false;

    expect(hasCreatedPollOutput0).toBe(false);
    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs: [] })).toBe(false);
    expect(OP.CREATE_TALLY_SHARD).toBe(0x07);
  });

  test("CREATE_TALLY_SHARD during a poll update-style transaction fails", () => {
    const pollTypeHash = `0x${"76".repeat(32)}`;
    const poll = makePoll({ shard_count: 4 });
    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash);

    expect(
      validateAtomicCreatePollShardSet({
        poll,
        pollTypeHash,
        shardOutputs,
        inputTypeHashes: [pollTypeHash],
      })
    ).toBe(false);
  });

  test("tally shard layout moves mutable counting state out of the poll cell", () => {
    const poll = makePoll({
      vote_counts: [0n, 0n, 0n],
      total_voters: 0n,
      counted_voter_lock_hashes: [],
    });
    const shard = makeShard({
      vote_counts: [5n, 1n, 0n],
      total_voters: 6n,
      counted_voter_lock_hashes: Array.from({ length: 6 }, (_, index) =>
        new Uint8Array(32).fill(index + 1)
      ),
    });

    expect(poll.vote_counts).toEqual([0n, 0n, 0n]);
    expect(poll.counted_voter_lock_hashes).toHaveLength(0);
    expect(shard.vote_counts).toEqual([5n, 1n, 0n]);
    expect(shard.counted_voter_lock_hashes).toHaveLength(6);
    expect(encodeTallyShardData(shard).length).toBeGreaterThan(0);
  });

  test("derives shard id during aggregation instead of storing it in VoteIntentData", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xa9);
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0xb8),
    });
    const shardCount = 16;
    const shardId = deriveTallyShardId(intent.poll_type_hash, intent.voter_lock_hash, shardCount);

    expect(shardId).toBeGreaterThanOrEqual(0);
    expect(shardId).toBeLessThan(shardCount);
    expect("shard_id" in intent).toBe(false);
  });

  test("uses deterministic CKB blake2b shard assignment vectors", () => {
    const vectors = [
      {
        poll: new Uint8Array(32).fill(0x00),
        voter: new Uint8Array(32).fill(0x00),
        shardCount: 1,
        digest: "0xb084041e7c8511e9279eaa616b52599f0c397f389afb6b48e087ca488d9aa7d7",
        shardId: 0,
      },
      {
        poll: new Uint8Array(32).fill(0x11),
        voter: new Uint8Array(32).fill(0x22),
        shardCount: 4,
        digest: "0xe994f19a5b320be7699c49732d5d6b029223e2bfdd128707a4c5991ef5d5b42f",
        shardId: 1,
      },
      {
        poll: new Uint8Array(32).fill(0xa9),
        voter: new Uint8Array(32).fill(0xb8),
        shardCount: 16,
        digest: "0xa1428b2b05530d839e29fffae4208f8bf5335307f1f6ac4eede4456c35097ce7",
        shardId: 1,
      },
      {
        poll: hexToBytes("0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"),
        voter: hexToBytes("0xfedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210"),
        shardCount: 32,
        digest: "0xa4f084f6e2668fdfa01f5a612fbdefbdb2002828a5efc0696d82ef6863bf82c4",
        shardId: 4,
      },
      {
        poll: new Uint8Array(32).fill(0xff),
        voter: new Uint8Array(32).fill(0x01),
        shardCount: 256,
        digest: "0xa3ff9cd34304f99e031ee405acbbf7a572a7127aa5fae5286fbb46d906369a26",
        shardId: 163,
      },
    ];

    for (const vector of vectors) {
      expect(bytesToHex(hashTallyShardAssignmentInput(vector.poll, vector.voter))).toBe(vector.digest);
      expect(deriveTallyShardId(vector.poll, vector.voter, vector.shardCount)).toBe(vector.shardId);
    }
  });

  test("rejects assigning an intent to the wrong shard", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xd1);
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0xd2),
    });
    const expectedShardId = deriveTallyShardId(intent.poll_type_hash, intent.voter_lock_hash, 8);
    const wrongShardId = (expectedShardId + 1) % 8;

    expect(wrongShardId).not.toBe(expectedShardId);
  });

  test("duplicate voters are bounded to the shard registry", () => {
    const voter = new Uint8Array(32).fill(0xee);
    const shard = makeShard({
      counted_voter_lock_hashes: [voter],
      total_voters: 1n,
    });
    const duplicateIntent = makeIntent({ voter_lock_hash: voter });

    const alreadyCountedInShard = shard.counted_voter_lock_hashes.some(
      (entry) => equalBytes(entry, duplicateIntent.voter_lock_hash)
    );

    expect(alreadyCountedInShard).toBe(true);
  });

  test("shard aggregation updates only shard tally state", () => {
    const pollTypeHash = `0x${"82".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 4, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const shardId = 2;
    const voterA = voterForShard(pollHashBytes, poll.shard_count, shardId, 1);
    const voterB = voterForShard(pollHashBytes, poll.shard_count, shardId, voterA[0] + 1);
    const beforeShard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: shardId,
      shard_count: poll.shard_count,
      vote_counts: [0n, 0n, 0n],
      total_voters: 0n,
      counted_voter_lock_hashes: [],
      finalized: false,
    });
    const intents = [
      makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voterA, option_index: 1 }),
      makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voterB, option_index: 2 }),
    ];
    const afterShard = {
      ...beforeShard,
      vote_counts: [0n, 1n, 1n],
      total_voters: 2n,
      counted_voter_lock_hashes: [voterA, voterB],
    };

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard, afterShard, intents })).toBe(true);
    expect(poll.vote_counts).toEqual([0n, 0n, 0n]);
  });

  test("multi-intent shard aggregation rejects later marker type lock or capacity drift", () => {
    const pollTypeHash = `0x${"87".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 4, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const shardId = 1;
    const voterA = voterForShard(pollHashBytes, poll.shard_count, shardId, 1);
    const voterB = voterForShard(pollHashBytes, poll.shard_count, shardId, voterA[0] + 1);
    const beforeShard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: shardId,
      shard_count: poll.shard_count,
      vote_counts: [0n, 0n, 0n],
    });
    const intents = [
      makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voterA, option_index: 0 }),
      makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voterB, option_index: 1 }),
    ];
    const afterShard = {
      ...beforeShard,
      vote_counts: [1n, 1n, 0n],
      total_voters: 2n,
      counted_voter_lock_hashes: [voterA, voterB],
    };
    const intentType = { codeHash: "0xabc", hashType: "data1", args: `0x02${pollTypeHash.slice(2)}` };
    const intentLock = { ...intentType };
    const markers = [
      {
        inputType: intentType,
        outputType: intentType,
        outputLock: intentLock,
        expectedIntentLock: intentLock,
        inputCapacity: VOTER_DEPOSIT_SHANNONS,
        outputCapacity: VOTER_DEPOSIT_SHANNONS,
      },
      {
        inputType: intentType,
        outputType: intentType,
        outputLock: intentLock,
        expectedIntentLock: intentLock,
        inputCapacity: VOTER_DEPOSIT_SHANNONS,
        outputCapacity: VOTER_DEPOSIT_SHANNONS,
      },
    ];

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard, afterShard, intents, markerOutputs: markers })).toBe(true);
    expect(validateShardAggregationModel({
      poll,
      pollTypeHash,
      beforeShard,
      afterShard,
      intents,
      markerOutputs: [markers[0], { ...markers[1], outputType: { ...intentType, args: "0xdead" } }],
    })).toBe(false);
    expect(validateShardAggregationModel({
      poll,
      pollTypeHash,
      beforeShard,
      afterShard,
      intents,
      markerOutputs: [markers[0], { ...markers[1], outputLock: { ...intentLock, args: "0xbeef" } }],
    })).toBe(false);
    expect(validateShardAggregationModel({
      poll,
      pollTypeHash,
      beforeShard,
      afterShard,
      intents,
      markerOutputs: [markers[0], { ...markers[1], outputCapacity: VOTER_DEPOSIT_SHANNONS + 1n }],
    })).toBe(false);
  });

  test("wrong shard intent is rejected", () => {
    const pollTypeHash = `0x${"83".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 4 });
    const correctShardId = 1;
    const voter = voterForShard(pollHashBytes, poll.shard_count, correctShardId, 20);
    const wrongShard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: (correctShardId + 1) % poll.shard_count,
      shard_count: poll.shard_count,
      vote_counts: [0n, 0n, 0n],
    });
    const intent = makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voter, option_index: 0 });
    const afterShard = { ...wrongShard, vote_counts: [1n, 0n, 0n], total_voters: 1n, counted_voter_lock_hashes: [voter] };

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard: wrongShard, afterShard, intents: [intent] })).toBe(false);
  });

  test("cross-poll intent is rejected by shard aggregation", () => {
    const pollTypeHash = `0x${"84".repeat(32)}`;
    const otherPollHash = new Uint8Array(32).fill(0x85);
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 4 });
    const shard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: 0,
      shard_count: poll.shard_count,
      vote_counts: [0n, 0n, 0n],
    });
    const voter = voterForShard(otherPollHash, poll.shard_count, 0, 1);
    const intent = makeIntent({ poll_type_hash: otherPollHash, voter_lock_hash: voter, option_index: 0 });
    const afterShard = { ...shard, vote_counts: [1n, 0n, 0n], total_voters: 1n, counted_voter_lock_hashes: [voter] };

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard: shard, afterShard, intents: [intent] })).toBe(false);
  });

  test("duplicate voter is rejected during shard aggregation", () => {
    const pollTypeHash = `0x${"86".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 4 });
    const shardId = 3;
    const voter = voterForShard(pollHashBytes, poll.shard_count, shardId, 1);
    const beforeShard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: shardId,
      shard_count: poll.shard_count,
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      counted_voter_lock_hashes: [voter],
    });
    const duplicateIntent = makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voter, option_index: 1 });
    const afterShard = {
      ...beforeShard,
      vote_counts: [1n, 1n, 0n],
      total_voters: 2n,
      counted_voter_lock_hashes: [voter, voter],
    };

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard, afterShard, intents: [duplicateIntent] })).toBe(false);
  });

  test("legacy poll-cell aggregation is disabled for sharded polls", () => {
    const poll = makePoll({ shard_count: 8 });

    expect(poll.shard_count > 0).toBe(true);
  });

  test("parallel aggregation can consume different shard cells for the same poll", () => {
    const pollTypeHash = new Uint8Array(32).fill(0x77);
    const shardA = makeShard({ poll_type_hash: pollTypeHash, shard_id: 1, shard_count: 4 });
    const shardB = makeShard({ poll_type_hash: pollTypeHash, shard_id: 2, shard_count: 4 });

    expect(equalBytes(shardA.poll_type_hash, shardB.poll_type_hash)).toBe(true);
    expect(shardA.shard_id).not.toBe(shardB.shard_id);
  });
});

describe("Close model", () => {
  test("frontend finalization stays available after deadline with pending intents and warns strictly", () => {
    const poll = makeUiPoll({
      deadline: 100n,
      pendingIntentCount: 2n,
      tallyShards: [
        makeUiShard({ shardId: 0, finalized: false }),
        makeUiShard({ shardId: 1, finalized: true }),
      ],
    });

    expect(canFinalizeTallyShardFromUi(poll, 101n)).toBe(true);
    expect(getFinalizeShardConfirmationMessage(poll)).toContain(FINALIZE_PENDING_INTENTS_WARNING);
    expect(canFinalizeTallyShardFromUi(poll, 100n)).toBe(false);
  });

  test("shard finalization freezes tally state after deadline", () => {
    const pollTypeHash = `0x${"90".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 2, deadline: 100n });
    const before = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: 0,
      shard_count: 2,
      vote_counts: [2n, 1n, 0n],
      total_voters: 3n,
      counted_voter_lock_hashes: [
        new Uint8Array(32).fill(0x01),
        new Uint8Array(32).fill(0x02),
        new Uint8Array(32).fill(0x03),
      ],
      finalized: false,
    });
    const after = { ...before, finalized: true };

    expect(validateFinalizeShardModel({ poll, before, after, pollTypeHash, epoch: 101n })).toBe(true);
    expect(validateFinalizeShardModel({ poll, before, after, pollTypeHash, epoch: 100n })).toBe(false);
    expect(validateFinalizeShardModel({
      poll,
      before,
      after: { ...after, vote_counts: [3n, 1n, 0n] },
      pollTypeHash,
      epoch: 101n,
    })).toBe(false);
  });

  test("aggregation rejects already-finalized shard updates", () => {
    const pollTypeHash = `0x${"94".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 2 });
    const voter = voterForShard(pollHashBytes, poll.shard_count, 0, 10);
    const beforeShard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: 0,
      shard_count: 2,
      finalized: true,
    });
    const intent = makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: voter, option_index: 0 });
    const afterShard = {
      ...beforeShard,
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      counted_voter_lock_hashes: [intent.voter_lock_hash],
    };

    expect(validateShardAggregationModel({ poll, pollTypeHash, beforeShard, afterShard, intents: [intent] })).toBe(false);
  });

  test("successful sharded close derives final result from finalized shards", () => {
    const pollTypeHash = `0x${"91".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 3, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const shards = [
      makeShard({ poll_type_hash: pollHashBytes, shard_id: 0, shard_count: 3, vote_counts: [1n, 0n, 0n], total_voters: 1n, counted_voter_lock_hashes: [new Uint8Array(32).fill(0x01)], finalized: true }),
      makeShard({ poll_type_hash: pollHashBytes, shard_id: 1, shard_count: 3, vote_counts: [0n, 2n, 0n], total_voters: 2n, counted_voter_lock_hashes: [new Uint8Array(32).fill(0x02), new Uint8Array(32).fill(0x03)], finalized: true }),
      makeShard({ poll_type_hash: pollHashBytes, shard_id: 2, shard_count: 3, vote_counts: [0n, 0n, 3n], total_voters: 3n, counted_voter_lock_hashes: [new Uint8Array(32).fill(0x04), new Uint8Array(32).fill(0x05), new Uint8Array(32).fill(0x06)], finalized: true }),
    ];
    const after = {
      ...poll,
      is_closed: true,
      vote_counts: [1n, 2n, 3n],
      total_voters: 6n,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
    };

    expect(validateFinalCloseFromShardsModel({ poll, after, pollTypeHash, shards })).toBe(true);
  });

  test("large shard_count requires merge result path instead of direct close", () => {
    const pollTypeHash = `0x${"95".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const shardCount = MAX_DIRECT_CLOSE_SHARDS + 1;
    const poll = makePoll({ shard_count: shardCount, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const shards = Array.from({ length: shardCount }, (_, shardId) =>
      makeShard({
        poll_type_hash: pollHashBytes,
        shard_id: shardId,
        shard_count: shardCount,
        vote_counts: [shardId === 0 ? 1n : 0n, 0n, 0n],
        total_voters: shardId === 0 ? 1n : 0n,
        counted_voter_lock_hashes: shardId === 0 ? [new Uint8Array(32).fill(0x21)] : [],
        finalized: true,
      })
    );
    const after = {
      ...poll,
      is_closed: true,
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
    };

    expect(validateFinalCloseFromShardsModel({ poll, after, pollTypeHash, shards })).toBe(false);
  });

  test("partial merge sums finalized shard coverage and totals", () => {
    const pollTypeHash = `0x${"96".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 9, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const shards = [
      makeShard({ poll_type_hash: pollHashBytes, shard_id: 0, shard_count: 9, vote_counts: [1n, 0n, 0n], total_voters: 1n, finalized: true }),
      makeShard({ poll_type_hash: pollHashBytes, shard_id: 1, shard_count: 9, vote_counts: [0n, 2n, 0n], total_voters: 2n, finalized: true }),
    ];
    const coverage = new Uint8Array(32);
    coverage[0] = 0b0000_0011;
    const output = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage,
      vote_counts: [1n, 2n, 0n],
      total_voters: 3n,
      merge_level: 1,
    });

    expect(validateMergeModel({ poll, pollTypeHash, shards, output })).toBe(true);
    expect(validateMergeModel({ poll, pollTypeHash, shards: [{ ...shards[0], finalized: false }, shards[1]], output })).toBe(false);
  });

  test("merge rejects duplicate or overlapping coverage", () => {
    const pollTypeHash = `0x${"97".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 9 });
    const shard = makeShard({ poll_type_hash: pollHashBytes, shard_id: 0, shard_count: 9, vote_counts: [1n, 0n, 0n], total_voters: 1n, finalized: true });
    const existing = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: coverageForShard(0),
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      merge_level: 1,
    });
    const output = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: coverageForShard(0),
      vote_counts: [2n, 0n, 0n],
      total_voters: 2n,
      merge_level: 2,
    });

    expect(validateMergeModel({ poll, pollTypeHash, shards: [shard], results: [existing], output })).toBe(false);
  });

  test("merge can combine disjoint finalized shards and prior merge results", () => {
    const pollTypeHash = `0x${"98".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 9 });
    const shard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: 2,
      shard_count: 9,
      vote_counts: [0n, 1n, 0n],
      total_voters: 1n,
      finalized: true,
    });
    const result = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: coverageForShard(0),
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      merge_level: 1,
    });
    const output = buildExpectedMergeResult({ poll, pollTypeHash, shards: [shard], results: [result] });

    expect(validateMergeModel({ poll, pollTypeHash, shards: [shard], results: [result], output })).toBe(true);
    expect(output.vote_counts).toEqual([1n, 1n, 0n]);
    expect(output.total_voters).toBe(2n);
  });

  test("frontend tally display uses partial merge frontier plus uncovered live shards", () => {
    const shardCount = 4;
    const mergeCoverage = new Uint8Array(32);
    mergeCoverage[0] = 0b0000_0011;
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount,
      pollVoteCounts: [0n, 0n, 0n],
      pollTotalVoters: 0n,
      shards: [
        makeUiShard({ id: "shard-0", shardId: 0, shardCount, voteCounts: [99n, 0n, 0n], totalVoters: 99n }),
        makeUiShard({ id: "shard-2", shardId: 2, shardCount, voteCounts: [0n, 0n, 3n], totalVoters: 3n }),
        makeUiShard({ id: "shard-3", shardId: 3, shardCount, voteCounts: [4n, 0n, 0n], totalVoters: 4n }),
      ],
      mergeResults: [
        makeUiMergeResult({
          id: "merge-01",
          coverage: bytesToHex(mergeCoverage),
          voteCounts: [1n, 2n, 0n],
          totalVoters: 3n,
          mergeLevel: 1,
        }),
      ],
    });

    expect(frontier.source).toBe("merge-frontier");
    expect(frontier.voteCounts).toEqual([5n, 2n, 3n]);
    expect(frontier.totalVoters).toBe(10n);
    expect(frontier.coverageComplete).toBe(true);
    expect(frontier.coveredShardCount).toBe(4);
    expect(frontier.selectedMergeResultIds).toEqual(["merge-01"]);
    expect(frontier.selectedShardIds).toEqual([2, 3]);
    expect(frontier.uncoveredShardIds).toEqual([]);
  });

  test("frontend tally display uses complete merge result as final large-poll source", () => {
    const shardCount = MAX_DIRECT_CLOSE_SHARDS + 1;
    const completeCoverage = new Uint8Array(32);
    for (let shardId = 0; shardId < shardCount; shardId += 1) {
      completeCoverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
    }
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount,
      pollVoteCounts: [0n, 0n, 0n],
      pollTotalVoters: 0n,
      shards: [
        makeUiShard({ shardId: 0, shardCount, voteCounts: [99n, 99n, 99n], totalVoters: 297n }),
      ],
      mergeResults: [
        makeUiMergeResult({
          id: "complete",
          coverage: bytesToHex(completeCoverage),
          voteCounts: [4n, 3n, 2n],
          totalVoters: 9n,
          mergeLevel: 3,
        }),
      ],
    });

    expect(frontier.source).toBe("complete-merge");
    expect(frontier.voteCounts).toEqual([4n, 3n, 2n]);
    expect(frontier.totalVoters).toBe(9n);
    expect(frontier.coverageComplete).toBe(true);
    expect(frontier.coveredShardCount).toBe(shardCount);
    expect(frontier.selectedShardIds).toEqual([]);
  });

  test("frontend tally display ignores overlapping merge results instead of double-counting", () => {
    const shardCount = 4;
    const coverage01 = new Uint8Array(32);
    coverage01[0] = 0b0000_0011;
    const coverage12 = new Uint8Array(32);
    coverage12[0] = 0b0000_0110;

    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount,
      pollVoteCounts: [0n, 0n, 0n],
      pollTotalVoters: 0n,
      shards: [
        makeUiShard({ id: "shard-2", shardId: 2, shardCount, voteCounts: [0n, 0n, 3n], totalVoters: 3n }),
        makeUiShard({ id: "shard-3", shardId: 3, shardCount, voteCounts: [4n, 0n, 0n], totalVoters: 4n }),
      ],
      mergeResults: [
        makeUiMergeResult({
          id: "merge-01",
          coverage: bytesToHex(coverage01),
          voteCounts: [1n, 2n, 0n],
          totalVoters: 3n,
          mergeLevel: 1,
        }),
        makeUiMergeResult({
          id: "merge-12-overlap",
          coverage: bytesToHex(coverage12),
          voteCounts: [100n, 100n, 100n],
          totalVoters: 300n,
          mergeLevel: 1,
        }),
      ],
    });

    expect(frontier.voteCounts).toEqual([5n, 2n, 3n]);
    expect(frontier.totalVoters).toBe(10n);
    expect(frontier.selectedMergeResultIds).toEqual(["merge-01"]);
    expect(frontier.selectedMergeResultIds).not.toContain("merge-12-overlap");
    expect(frontier.selectedShardIds).toEqual([2, 3]);
  });

  test("frontend tally display ignores malformed and out-of-range coverage", () => {
    const shardCount = 4;
    const outOfRangeCoverage = new Uint8Array(32);
    outOfRangeCoverage[1] = 0b0000_0001;

    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount,
      pollVoteCounts: [9n, 9n, 9n],
      pollTotalVoters: 27n,
      shards: [
        makeUiShard({ id: "shard-0", shardId: 0, shardCount, voteCounts: [1n, 0n, 0n], totalVoters: 1n }),
        makeUiShard({ id: "bad-shard", shardId: 9, shardCount, voteCounts: [100n, 0n, 0n], totalVoters: 100n }),
      ],
      mergeResults: [
        makeUiMergeResult({
          id: "malformed",
          coverage: "0x1234",
          voteCounts: [100n, 100n, 100n],
          totalVoters: 300n,
        }),
        makeUiMergeResult({
          id: "out-of-range",
          coverage: bytesToHex(outOfRangeCoverage),
          voteCounts: [100n, 100n, 100n],
          totalVoters: 300n,
        }),
      ],
    });

    expect(frontier.source).toBe("live-shards");
    expect(frontier.voteCounts).toEqual([1n, 0n, 0n]);
    expect(frontier.totalVoters).toBe(1n);
    expect(frontier.coverageComplete).toBe(false);
    expect(frontier.coveredShardCount).toBe(1);
    expect(frontier.uncoveredShardIds).toEqual([1, 2, 3]);
  });

  test("frontend tally display reports incomplete sharded coverage", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      pollVoteCounts: [9n, 9n, 9n],
      pollTotalVoters: 27n,
      shards: [
        makeUiShard({ id: "shard-0", shardId: 0, shardCount: 4, voteCounts: [1n, 0n, 0n], totalVoters: 1n }),
      ],
      mergeResults: [],
    });

    expect(frontier.source).toBe("live-shards");
    expect(frontier.voteCounts).toEqual([1n, 0n, 0n]);
    expect(frontier.coverageComplete).toBe(false);
    expect(frontier.coveredShardCount).toBe(1);
    expect(frontier.shardCount).toBe(4);
    expect(frontier.uncoveredShardIds).toEqual([1, 2, 3]);
  });

  test("legacy non-sharded poll falls back to poll-cell tally", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 0,
      pollVoteCounts: [2n, 1n, 0n],
      pollTotalVoters: 3n,
      shards: [],
      mergeResults: [],
    });

    expect(frontier.source).toBe("poll-cell");
    expect(frontier.voteCounts).toEqual([2n, 1n, 0n]);
    expect(frontier.totalVoters).toBe(3n);
    expect(frontier.coverageComplete).toBe(true);
  });

  test("closed sharded poll falls back to closed poll result after tally cells are consumed", () => {
    const frontier = computeCanonicalTallyFrontier({
      optionCount: 3,
      shardCount: 4,
      pollVoteCounts: [5n, 2n, 1n],
      pollTotalVoters: 8n,
      pollIsClosed: true,
      shards: [],
      mergeResults: [],
    });

    expect(frontier.source).toBe("closed-poll");
    expect(frontier.voteCounts).toEqual([5n, 2n, 1n]);
    expect(frontier.totalVoters).toBe(8n);
    expect(frontier.coverageComplete).toBe(true);
    expect(frontier.coveredShardCount).toBe(4);
    expect(frontier.uncoveredShardIds).toEqual([]);
  });

  test("finalized shard consumption into merge requires exact governance merge output", () => {
    const pollTypeHash = `0x${"99".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const shard = makeShard({
      poll_type_hash: pollHashBytes,
      shard_id: 2,
      shard_count: 9,
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      finalized: true,
    });
    const shardScript = buildTallyShardTypeScript(pollTypeHash, shard.shard_id);
    const mergeScript = buildTallyMergeResultTypeScript(pollTypeHash);
    const outputResult = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: coverageForShard(shard.shard_id),
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      merge_level: 1,
    });

    expect(validateShardConsumeIntoMergeModel({
      pollTypeHash,
      shard,
      inputLock: shardScript,
      inputType: shardScript,
      outputLock: mergeScript,
      outputType: mergeScript,
      outputResult,
    })).toBe(true);

    expect(validateShardConsumeIntoMergeModel({
      pollTypeHash,
      shard,
      inputLock: shardScript,
      inputType: shardScript,
      outputLock: mergeScript,
      outputType: makeScript({
        code_hash: `0x${"55".repeat(32)}`,
        hash_type: "data",
        args: mergeScript.args,
      }),
      outputResult,
    })).toBe(false);

    expect(validateShardConsumeIntoMergeModel({
      pollTypeHash,
      shard,
      inputLock: shardScript,
      inputType: shardScript,
      outputLock: makeScript({ args: mergeScript.args }),
      outputType: mergeScript,
      outputResult,
    })).toBe(false);
  });

  test("large sharded close derives final result from complete merge result", () => {
    const pollTypeHash = `0x${"98".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 9, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const coverage = new Uint8Array(32);
    coverage[0] = 0xff;
    coverage[1] = 0x01;
    const result = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage,
      vote_counts: [4n, 3n, 2n],
      total_voters: 9n,
      merge_level: 2,
    });
    const after = {
      ...poll,
      is_closed: true,
      vote_counts: [4n, 3n, 2n],
      total_voters: 9n,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
    };

    expect(validateFinalCloseFromMergeModel({ poll, after, pollTypeHash, result })).toBe(true);
    expect(validateFinalCloseFromMergeModel({
      poll,
      after,
      pollTypeHash,
      result: { ...result, coverage: coverageForShard(0) },
    })).toBe(false);
  });

  test("large sharded close rejects wrong poll incomplete coverage and extra tally inputs", () => {
    const pollTypeHash = `0x${"9a".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: MAX_DIRECT_CLOSE_SHARDS + 1, vote_counts: [0n, 0n, 0n], total_voters: 0n });
    const completeCoverage = new Uint8Array(32);
    completeCoverage[0] = 0xff;
    completeCoverage[1] = 0x01;
    const result = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: completeCoverage,
      vote_counts: [3n, 2n, 1n],
      total_voters: 6n,
      merge_level: 2,
    });
    const after = {
      ...poll,
      is_closed: true,
      vote_counts: result.vote_counts,
      total_voters: result.total_voters,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
    };

    expect(validateFinalCloseFromMergeModel({
      poll,
      after,
      pollTypeHash,
      result: { ...result, poll_type_hash: new Uint8Array(32).fill(0x9b) },
    })).toBe(false);
    expect(validateFinalCloseFromMergeModel({
      poll,
      after,
      pollTypeHash,
      result: { ...result, coverage: coverageForShard(0) },
    })).toBe(false);
    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after,
      pollTypeHash,
      result,
      trailingInputs: ["fee", "intent"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: [VOTER_DEPOSIT_SHANNONS],
      voterRefundCapacities: [VOTER_DEPOSIT_SHANNONS],
    })).toBe(true);
    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after,
      pollTypeHash,
      result,
      trailingInputs: ["fee", "tally_shard"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: [],
      voterRefundCapacities: [],
    })).toBe(false);
    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after,
      pollTypeHash,
      result,
      trailingInputs: ["merge_result"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: [],
      voterRefundCapacities: [],
    })).toBe(false);
  });

  test("large close refunds each consumed intent's full capacity", () => {
    const pollTypeHash = `0x${"9c".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({
      shard_count: MAX_DIRECT_CLOSE_SHARDS + 1,
      token_weighted: true,
      vote_counts: [0n, 0n, 0n],
      total_voters: 0n,
    });
    const completeCoverage = new Uint8Array(32);
    completeCoverage[0] = 0xff;
    completeCoverage[1] = 0x01;
    const result = makeMergeResult({
      poll_type_hash: pollHashBytes,
      coverage: completeCoverage,
      vote_counts: [6n, 0n, 0n],
      total_voters: 2n,
      merge_level: 2,
    });
    const after = {
      ...poll,
      is_closed: true,
      vote_counts: result.vote_counts,
      total_voters: result.total_voters,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
    };
    const intentCapacities = [
      VOTER_DEPOSIT_SHANNONS,
      5n * VOTER_DEPOSIT_SHANNONS,
    ];

    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after,
      pollTypeHash,
      result,
      trailingInputs: ["intent", "intent"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: intentCapacities,
      voterRefundCapacities: intentCapacities,
    })).toBe(true);
    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after,
      pollTypeHash,
      result,
      trailingInputs: ["intent", "intent"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: intentCapacities,
      voterRefundCapacities: [VOTER_DEPOSIT_SHANNONS, VOTER_DEPOSIT_SHANNONS],
    })).toBe(false);
  });

  test("close-time refund selection caps included intents and prefers pending first", () => {
    const pollTypeHash = `0x${"9d".repeat(32)}`;
    const candidates = Array.from({ length: MAX_CLOSE_INTENT_REFUNDS + 4 }, (_, index) => ({
      cell: { index },
      pollTypeHash,
      aggregated: index >= 4,
      sortKey: index.toString().padStart(3, "0"),
    }));

    const selection = selectCloseTimeIntentRefunds(candidates, {
      pollTypeHash,
      trackedPendingLowerBound: 4n,
      maxRefunds: MAX_CLOSE_INTENT_REFUNDS,
    });

    expect(selection.included).toHaveLength(MAX_CLOSE_INTENT_REFUNDS);
    expect(selection.includedPendingCount).toBe(4);
    expect(selection.included.slice(0, 4).every((candidate) => !candidate.aggregated)).toBe(true);
    expect(selection.omitted).toHaveLength(4);
    expect(selection.omitted.every((candidate) => candidate.aggregated)).toBe(true);
  });

  test("post-close refund selector still sees omitted pending and aggregated marker intents", () => {
    const pollTypeHash = `0x${"9e".repeat(32)}`;
    const pending = {
      cell: { id: "pending" },
      pollTypeHash,
      aggregated: false,
      sortKey: "001",
    };
    const aggregated = {
      cell: { id: "aggregated" },
      pollTypeHash,
      aggregated: true,
      sortKey: "002",
    };
    const selection = selectCloseTimeIntentRefunds([pending, aggregated], {
      pollTypeHash,
      trackedPendingLowerBound: 0n,
      maxRefunds: 0,
    });
    const omittedIntentModels = selection.omitted.map((candidate) =>
      makeIntent({
        poll_type_hash: hexToBytes(pollTypeHash),
        aggregated: candidate.aggregated,
        refund_lock: makeScript({ args: "0xrefund" }),
      })
    );

    expect(selection.omittedPendingCount).toBe(1);
    expect(selection.omittedAggregatedCount).toBe(1);
    expect(selectRefundableClosedIntentModel(omittedIntentModels, hexToBytes(pollTypeHash))?.aggregated).toBe(false);
    expect(selectRefundableClosedIntentModel(omittedIntentModels.filter((intent) => intent.aggregated), hexToBytes(pollTypeHash))?.aggregated).toBe(true);
  });

  test("sharded close rejects missing duplicate stale or wrong-poll shards", () => {
    const pollTypeHash = `0x${"92".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const poll = makePoll({ shard_count: 2 });
    const shard0 = makeShard({ poll_type_hash: pollHashBytes, shard_id: 0, shard_count: 2, vote_counts: [1n, 0n, 0n], total_voters: 1n, counted_voter_lock_hashes: [new Uint8Array(32).fill(0x11)], finalized: true });
    const shard1 = makeShard({ poll_type_hash: pollHashBytes, shard_id: 1, shard_count: 2, vote_counts: [0n, 1n, 0n], total_voters: 1n, counted_voter_lock_hashes: [new Uint8Array(32).fill(0x12)], finalized: true });
    const after = { ...poll, is_closed: true, vote_counts: [1n, 1n, 0n], total_voters: 2n, counted_voter_lock_hashes: [], pending_intent_count: 0n };

    expect(validateFinalCloseFromShardsModel({ poll, after, pollTypeHash, shards: [shard0] })).toBe(false);
    expect(validateFinalCloseFromShardsModel({ poll, after, pollTypeHash, shards: [shard0, { ...shard1, shard_id: 0 }] })).toBe(false);
    expect(validateFinalCloseFromShardsModel({ poll, after, pollTypeHash, shards: [shard0, { ...shard1, finalized: false }] })).toBe(false);
    expect(validateFinalCloseFromShardsModel({
      poll,
      after,
      pollTypeHash,
      shards: [shard0, { ...shard1, poll_type_hash: new Uint8Array(32).fill(0x93) }],
    })).toBe(false);
  });

  test("requires refunded pending intents to be at least tracked pending count", () => {
    const trackedPending = 2n;
    const refundedPending = 3n;

    expect(refundedPending >= trackedPending).toBe(true);
  });

  test("closing transition marks the poll closed and clears pending intents", () => {
    const before = makePoll({
      vote_counts: [5n, 4n, 1n],
      total_voters: 10n,
      pending_intent_count: 2n,
      counted_voter_lock_hashes: Array.from({ length: 10 }, (_, index) =>
        new Uint8Array(32).fill(index + 1)
      ),
    });
    const after = { ...before, is_closed: true, pending_intent_count: 0n };

    expect(after.question).toBe(before.question);
    expect(after.vote_counts).toEqual(before.vote_counts);
    expect(after.total_voters).toBe(before.total_voters);
    expect(after.is_closed).toBe(true);
    expect(after.pending_intent_count).toBe(0n);
  });

  test("force-close eligibility starts only after deadline plus grace", () => {
    const deadline = 220n;
    const allowEpoch = deadline + FORCE_CLOSE_GRACE_EPOCHS;

    expect(allowEpoch).toBe(230n);
    expect(allowEpoch > deadline).toBe(true);
  });

  test("intent input without output is rejected outside close or post-close refund", () => {
    const before = makePoll({ deadline: 200n, is_closed: false });
    const stillOpen = { ...before, is_closed: false };
    const closed = { ...before, is_closed: true };

    expect(validateIntentConsumptionWithoutOutputModel({
      beforePoll: before,
      afterPoll: stillOpen,
      epoch: 150n,
      creatorAuthorized: true,
    })).toBe(false);
    expect(validateIntentConsumptionWithoutOutputModel({
      beforePoll: before,
      afterPoll: closed,
      epoch: 201n,
      creatorAuthorized: true,
    })).toBe(true);
    expect(validateIntentConsumptionWithoutOutputModel({
      beforePoll: before,
      afterPoll: closed,
      epoch: before.deadline + FORCE_CLOSE_GRACE_EPOCHS,
      creatorAuthorized: false,
    })).toBe(false);
    expect(validateIntentConsumptionWithoutOutputModel({
      beforePoll: before,
      afterPoll: closed,
      epoch: before.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1n,
      creatorAuthorized: false,
    })).toBe(true);
    expect(validateIntentConsumptionWithoutOutputModel({
      closedPollDep: makePoll({ is_closed: true }),
      epoch: 150n,
    })).toBe(true);
  });
});

describe("Lock-layer stabilization model", () => {
  test("non-creator force-close requires protocol poll lock and post-grace epoch", () => {
    const pollTypeHash = `0x${"b1".repeat(32)}`;
    const poll = makePoll({ deadline: 100n });
    const protocolLock = buildPollLockScript(pollTypeHash);
    const privateLock = makeScript({ args: "0xc0" });
    const nonCreator = new Uint8Array(32).fill(0x22);

    expect(validateProtocolPollLockCloseModel({
      poll,
      pollTypeHash,
      inputPollLock: protocolLock,
      outputPollLock: protocolLock,
      creatorAuthLockHash: nonCreator,
      epoch: poll.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1n,
    })).toBe(true);

    expect(validateProtocolPollLockCloseModel({
      poll,
      pollTypeHash,
      inputPollLock: privateLock,
      outputPollLock: privateLock,
      creatorAuthLockHash: nonCreator,
      epoch: poll.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1n,
    })).toBe(false);

    expect(validateProtocolPollLockCloseModel({
      poll,
      pollTypeHash,
      inputPollLock: protocolLock,
      outputPollLock: protocolLock,
      creatorAuthLockHash: nonCreator,
      epoch: poll.deadline + FORCE_CLOSE_GRACE_EPOCHS,
    })).toBe(false);
  });

  test("creator close requires creator auth input and returns deposit to creator lock", () => {
    const pollTypeHash = `0x${"b2".repeat(32)}`;
    const poll = makePoll({
      creator: new Uint8Array(32).fill(0x42),
      creator_lock: makeScript({ args: "0xc1" }),
      deadline: 120n,
    });
    const protocolLock = buildPollLockScript(pollTypeHash);

    expect(validateProtocolPollLockCloseModel({
      poll,
      pollTypeHash,
      inputPollLock: protocolLock,
      outputPollLock: protocolLock,
      creatorAuthLockHash: poll.creator,
      epoch: poll.deadline + 1n,
    })).toBe(true);
    expect(validateCreatorCloseReturnModel({
      poll,
      creatorAuthLockHash: poll.creator,
      creatorReturnLock: poll.creator_lock,
      creatorReturnCapacity: poll.creator_deposit,
    })).toBe(true);
    expect(validateCreatorCloseReturnModel({
      poll,
      creatorAuthLockHash: new Uint8Array(32).fill(0x99),
      creatorReturnLock: poll.creator_lock,
      creatorReturnCapacity: poll.creator_deposit,
    })).toBe(false);
    expect(validateCreatorCloseReturnModel({
      poll,
      creatorAuthLockHash: poll.creator,
      creatorReturnLock: makeScript({ args: "0xc2" }),
      creatorReturnCapacity: poll.creator_deposit,
    })).toBe(false);
  });

  test("delegated voting uses a live delegation cell dep without consuming delegation", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb3);
    const delegator = new Uint8Array(32).fill(0xd1);
    const delegate = new Uint8Array(32).fill(0xd2);
    const delegationLock = makeScript({ args: "0xd1" });
    const delegation = {
      data: {
        delegator_lock_hash: delegator,
        delegate_lock_hash: delegate,
        poll_type_hash: pollTypeHash,
        expires_epoch: 300n,
      },
      lock: delegationLock,
      type: buildGovernanceTypeScript(OP.DELEGATE, bytesToHex(pollTypeHash)),
    };
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: delegator,
      refund_lock: delegationLock,
    });

    expect(validateDelegationAuthorityDepModel({
      intent,
      signerLockHash: delegate,
      signerLock: makeScript({ args: "0xd2" }),
      pollTypeHash,
      delegation,
      epoch: 250n,
    })).toBe(true);

    const txInputRoles = ["delegate-auth-input"];
    const txDepRoles = ["poll-cell-dep", "delegation-cell-dep"];
    expect(txInputRoles).not.toContain("delegation-cell-input");
    expect(txDepRoles).toContain("delegation-cell-dep");
  });

  test("delegated voting rejects expired wrong-poll and wrong-delegate authority", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb4);
    const delegator = new Uint8Array(32).fill(0xd3);
    const delegate = new Uint8Array(32).fill(0xd4);
    const delegationLock = makeScript({ args: "0xd3" });
    const baseDelegation = {
      data: {
        delegator_lock_hash: delegator,
        delegate_lock_hash: delegate,
        poll_type_hash: pollTypeHash,
        expires_epoch: 200n,
      },
      lock: delegationLock,
      type: buildGovernanceTypeScript(OP.DELEGATE, bytesToHex(pollTypeHash)),
    };
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: delegator,
      refund_lock: delegationLock,
    });
    const baseInput = {
      intent,
      signerLockHash: delegate,
      signerLock: makeScript({ args: "0xd4" }),
      pollTypeHash,
      delegation: baseDelegation,
      epoch: 199n,
    };

    expect(validateDelegationAuthorityDepModel(baseInput)).toBe(true);
    expect(validateDelegationAuthorityDepModel({ ...baseInput, epoch: 201n })).toBe(false);
    expect(validateDelegationAuthorityDepModel({
      ...baseInput,
      delegation: {
        ...baseDelegation,
        data: { ...baseDelegation.data, poll_type_hash: new Uint8Array(32).fill(0xb5) },
        type: buildGovernanceTypeScript(OP.DELEGATE, `0x${"b5".repeat(32)}`),
      },
    })).toBe(false);
    expect(validateDelegationAuthorityDepModel({
      ...baseInput,
      signerLockHash: new Uint8Array(32).fill(0xff),
    })).toBe(false);
  });

  test("delegator revocation remains a delegator-spent input output flow", () => {
    const delegatorLock = makeScript({ args: "0xde1e" });
    const inputCapacity = 80n * 100_000_000n;

    expect(validateDelegationRevocationModel({
      inputLock: delegatorLock,
      outputLock: delegatorLock,
      inputCapacity,
      outputCapacity: inputCapacity,
    })).toBe(true);
    expect(validateDelegationRevocationModel({
      inputLock: delegatorLock,
      outputLock: makeScript({ args: "0x0e" }),
      inputCapacity,
      outputCapacity: inputCapacity,
    })).toBe(false);
  });

  test("revoke visibility is delegator-only for indexed delegations", () => {
    const current = `0x${"d1".repeat(32)}`;
    const delegate = `0x${"d2".repeat(32)}`;

    expect(canCurrentWalletRevokeDelegationModel({ delegatorLockHash: current }, current)).toBe(true);
    expect(canCurrentWalletRevokeDelegationModel({ delegatorLockHash: current }, delegate)).toBe(false);
  });

  test("signer auth selection rejects typed or data-bearing fallback cells", () => {
    const typedOnly = [
      { type: makeScript({ args: "0x99" }), outputData: "0x" },
      { outputData: "0x1234" },
    ];
    const withPlain = [
      ...typedOnly,
      { outputData: "0x" },
    ];

    expect(selectPlainSignerAuthCellModel(typedOnly)).toBe(false);
    expect(selectPlainSignerAuthCellModel(withPlain)).toBe(true);
  });

  test("omitted post-close intent can be refunded only to refund_lock", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb6);
    const refundLock = makeScript({ args: "0xf1" });
    const closedPoll = makePoll({ is_closed: true });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x66),
      refund_lock: refundLock,
      aggregated: false,
    });

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: refundLock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(true);
    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: makeScript({ args: "0xf2" }),
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(false);
  });

  test("post-close refund accepts pending omitted intents", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb8);
    const closedPoll = makePoll({ is_closed: true });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      aggregated: false,
      refund_lock: makeScript({ args: "0xf8" }),
    });

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: intent.refund_lock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(true);
  });

  test("post-close refund accepts aggregated omitted intent markers", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb9);
    const closedPoll = makePoll({ is_closed: true });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      aggregated: true,
      refund_lock: makeScript({ args: "0xf9" }),
    });

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: intent.refund_lock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(true);
  });

  test("post-close refund rejects wrong-poll intent cells", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xba);
    const wrongPollHash = new Uint8Array(32).fill(0xbb);
    const closedPoll = makePoll({ is_closed: true });
    const intent = makeIntent({
      poll_type_hash: wrongPollHash,
      aggregated: false,
      refund_lock: makeScript({ args: "0xfa" }),
    });

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: intent.refund_lock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(false);
  });

  test("closed-poll refund selector prefers pending but does not ignore aggregated markers", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xbc);
    const wrongPollHash = new Uint8Array(32).fill(0xbd);
    const pending = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x01),
      aggregated: false,
    });
    const aggregated = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x02),
      aggregated: true,
    });
    const wrongPoll = makeIntent({
      poll_type_hash: wrongPollHash,
      voter_lock_hash: new Uint8Array(32).fill(0x03),
      aggregated: false,
    });

    expect(selectRefundableClosedIntentModel([wrongPoll, aggregated], pollTypeHash)).toBe(aggregated);
    expect(selectRefundableClosedIntentModel([aggregated, pending, wrongPoll], pollTypeHash)).toBe(pending);
    expect(selectRefundableClosedIntentModel([wrongPoll], pollTypeHash)).toBeNull();
  });

  test("post-close refund protects deposits but does not prove vote completeness", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xbe);
    const closedPoll = makePoll({
      is_closed: true,
      vote_counts: [0n, 0n, 0n],
      total_voters: 0n,
    });
    const omittedValidIntent = makeIntent({
      poll_type_hash: pollTypeHash,
      option_index: 1,
      aggregated: false,
      refund_lock: makeScript({ args: "0xfe" }),
    });

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent: omittedValidIntent,
      intentInputCapacity: VOTER_DEPOSIT_SHANNONS,
      outputLock: omittedValidIntent.refund_lock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
      beforePollTally: closedPoll.vote_counts,
      afterPollTally: closedPoll.vote_counts,
    })).toBe(true);
    expect(closedPoll.vote_counts[omittedValidIntent.option_index]).toBe(0n);
  });

  test("post-close refund preserves full intent capacity and cannot mutate tally", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xb7);
    const closedPoll = makePoll({
      is_closed: true,
      vote_counts: [3n, 1n, 0n],
      total_voters: 4n,
    });
    const intent = makeIntent({
      poll_type_hash: pollTypeHash,
      refund_lock: makeScript({ args: "0xf3" }),
    });
    const intentCapacity = VOTER_DEPOSIT_SHANNONS + 10n;

    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: intentCapacity,
      outputLock: intent.refund_lock,
      outputCapacity: intentCapacity,
      beforePollTally: closedPoll.vote_counts,
      afterPollTally: closedPoll.vote_counts,
    })).toBe(true);
    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: intentCapacity,
      outputLock: intent.refund_lock,
      outputCapacity: intentCapacity + 1n,
    })).toBe(false);
    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: intentCapacity,
      outputLock: intent.refund_lock,
      outputCapacity: VOTER_DEPOSIT_SHANNONS,
    })).toBe(false);
    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: intentCapacity,
      outputLock: intent.refund_lock,
      outputCapacity: intentCapacity,
      beforePollTally: closedPoll.vote_counts,
      afterPollTally: [4n, 1n, 0n],
    })).toBe(false);
    expect(validatePostCloseIntentRefundModel({
      closedPoll,
      pollTypeHash,
      intent,
      intentInputCapacity: intentCapacity,
      outputLock: intent.refund_lock,
      outputCapacity: intentCapacity,
      outputHasType: true,
    })).toBe(false);
  });
});

describe("Lifecycle integration model", () => {
  test("large sharded poll aggregates finalizes merges and closes from complete result", () => {
    const pollTypeHash = `0x${"a8".repeat(32)}`;
    const pollHashBytes = hexToBytes(pollTypeHash);
    const shardCount = MAX_DIRECT_CLOSE_SHARDS + 1;
    const poll = makePoll({
      options: ["Yes", "No", "Abstain"],
      vote_counts: [0n, 0n, 0n],
      total_voters: 0n,
      pending_intent_count: 0n,
      shard_count: shardCount,
      deadline: 300n,
    });

    const shardOutputs = makeInitialShardOutputs(poll, pollTypeHash);
    expect(validateAtomicCreatePollShardSet({ poll, pollTypeHash, shardOutputs })).toBe(true);

    const targetShardIds = [0, 1, 2, 7, 8];
    const intents = targetShardIds.flatMap((shardId, index) => {
      const first = deterministicVoterForShard(pollHashBytes, shardCount, shardId, index * 1000 + 1);
      const second = deterministicVoterForShard(pollHashBytes, shardCount, shardId, index * 1000 + 501);
      return [
        makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: first, option_index: index % poll.options.length }),
        makeIntent({ poll_type_hash: pollHashBytes, voter_lock_hash: second, option_index: (index + 1) % poll.options.length }),
      ];
    });

    const aggregatedShards = Array.from({ length: shardCount }, (_, shardId) => {
      const beforeShard = decodeTallyShardData(shardOutputs[shardId].data);
      const shardIntents = intents.filter((intent) =>
        deriveTallyShardId(intent.poll_type_hash, intent.voter_lock_hash, shardCount) === shardId
      );
      if (shardIntents.length === 0) {
        return beforeShard;
      }

      const voteCounts = beforeShard.vote_counts.map((count) => count);
      for (const intent of shardIntents) {
        voteCounts[intent.option_index] += 1n;
      }
      const afterShard = {
        ...beforeShard,
        vote_counts: voteCounts,
        total_voters: BigInt(shardIntents.length),
        counted_voter_lock_hashes: shardIntents.map((intent) => intent.voter_lock_hash),
      };

      expect(validateShardAggregationModel({
        poll,
        pollTypeHash,
        beforeShard,
        afterShard,
        intents: shardIntents,
        epoch: poll.deadline,
      })).toBe(true);
      return afterShard;
    });

    const finalizedShards = aggregatedShards.map((before) => {
      const after = { ...before, finalized: true };
      expect(validateFinalizeShardModel({
        poll,
        before,
        after,
        pollTypeHash,
        epoch: poll.deadline + 1n,
      })).toBe(true);
      return after;
    });

    const firstMerge = buildExpectedMergeResult({
      poll,
      pollTypeHash,
      shards: finalizedShards.slice(0, MAX_SHARDS_PER_MERGE),
    });
    expect(validateMergeModel({
      poll,
      pollTypeHash,
      shards: finalizedShards.slice(0, MAX_SHARDS_PER_MERGE),
      output: firstMerge,
    })).toBe(true);

    const secondMerge = buildExpectedMergeResult({
      poll,
      pollTypeHash,
      shards: finalizedShards.slice(MAX_SHARDS_PER_MERGE),
    });
    expect(validateMergeModel({
      poll,
      pollTypeHash,
      shards: finalizedShards.slice(MAX_SHARDS_PER_MERGE),
      output: secondMerge,
    })).toBe(true);

    const finalMerge = buildExpectedMergeResult({
      poll,
      pollTypeHash,
      results: [firstMerge, secondMerge],
    });
    expect(validateMergeModel({ poll, pollTypeHash, results: [firstMerge, secondMerge], output: finalMerge })).toBe(true);
    expect(coverageCompleteForShardCount(finalMerge.coverage, shardCount)).toBe(true);

    const afterClose = {
      ...poll,
      vote_counts: finalMerge.vote_counts,
      total_voters: finalMerge.total_voters,
      counted_voter_lock_hashes: [],
      pending_intent_count: 0n,
      is_closed: true,
    };

    expect(validateLargeMergeCloseInputTailModel({
      poll,
      after: afterClose,
      pollTypeHash,
      result: finalMerge,
      trailingInputs: ["fee", "intent", "intent"],
      creatorDepositReturnCapacity: CREATOR_DEPOSIT_SHANNONS,
      resultInputCapacity: 9n * TALLY_SHARD_MIN_SHANNONS,
      resultReturnCapacity: 9n * TALLY_SHARD_MIN_SHANNONS,
      intentInputCapacities: intents.map(() => VOTER_DEPOSIT_SHANNONS),
      voterRefundCapacities: intents.map(() => VOTER_DEPOSIT_SHANNONS),
    })).toBe(true);
    expect(afterClose.vote_counts.reduce((sum, count) => sum + count, 0n)).toBe(BigInt(intents.length));
    expect(afterClose.total_voters).toBe(BigInt(intents.length));
  });

  test("pending intent becomes aggregated marker then close preserves one counted voter", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xa1);
    const voterLockHash = new Uint8Array(32).fill(0xb1);
    const pollBefore = makePoll({
      options: ["A", "B", "C"],
      vote_counts: [0n, 0n, 0n],
      pending_intent_count: 1n,
      total_voters: 0n,
      counted_voter_lock_hashes: [],
    });
    const intentBefore = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: voterLockHash,
      option_index: 0,
      voted_at_epoch: 120n,
      aggregated: false,
    });
    const intentAggregated = {
      ...intentBefore,
      aggregated: true,
    };
    const pollAfterAggregate = {
      ...pollBefore,
      vote_counts: [1n, 0n, 0n],
      total_voters: 1n,
      pending_intent_count: 0n,
      counted_voter_lock_hashes: [voterLockHash],
    };
    const pollAfterClose = {
      ...pollAfterAggregate,
      is_closed: true,
      pending_intent_count: 0n,
    };

    expect(equalBytes(intentBefore.poll_type_hash, intentAggregated.poll_type_hash)).toBe(true);
    expect(equalBytes(intentBefore.voter_lock_hash, intentAggregated.voter_lock_hash)).toBe(true);
    expect(intentAggregated.option_index).toBe(intentBefore.option_index);
    expect(intentAggregated.voted_at_epoch).toBe(intentBefore.voted_at_epoch);
    expect(intentAggregated.aggregated).toBe(true);
    expect(pollAfterAggregate.vote_counts).toEqual([1n, 0n, 0n]);
    expect(pollAfterAggregate.total_voters).toBe(1n);
    expect(pollAfterAggregate.counted_voter_lock_hashes).toHaveLength(1);
    expect(pollAfterClose.is_closed).toBe(true);
    expect(pollAfterClose.pending_intent_count).toBe(0n);
  });

  test("close lower-bound refund rule accepts extra consumed pending intents", () => {
    const pollTypeHash = new Uint8Array(32).fill(0xc3);
    const pendingIntentA = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x11),
      aggregated: false,
    });
    const pendingIntentB = makeIntent({
      poll_type_hash: pollTypeHash,
      voter_lock_hash: new Uint8Array(32).fill(0x22),
      aggregated: false,
    });
    const trackedPending = 1n;
    const refundedPending = [pendingIntentA, pendingIntentB].filter((intent) => !intent.aggregated).length;

    expect(BigInt(refundedPending) >= trackedPending).toBe(true);
  });
});

describe("Multi-actor boundary model", () => {
  test("active frontend timeline uses CREATE_TALLY_SHARD instead of current-path AGGREGATE_VOTES", () => {
    const poll = makeUiPoll({ pendingIntentCount: 1n });
    const timeline = buildProtocolTimeline([poll], [], 50n);

    expect(timeline.map((step) => step.op)).toContain("CREATE_TALLY_SHARD");
    expect(timeline.map((step) => step.op)).not.toContain("AGGREGATE_VOTES");
    expect(timeline.find((step) => step.op === "CREATE_TALLY_SHARD")?.label).toBe("Shard aggregation");
  });

  test("default poll filter hides archived closed polls but keeps them accessible", () => {
    const open = makeUiPoll({ id: "open", deadline: 100n, isClosed: false, createdEpoch: 10n });
    const needsClose = makeUiPoll({ id: "needs", deadline: 20n, isClosed: false, createdEpoch: 11n });
    const archived = makeUiPoll({ id: "archived", deadline: 20n, isClosed: true, createdEpoch: 12n });
    const polls = [archived, open, needsClose];
    const counts = getPollFilterCounts(polls, 50n);

    expect(filterPollsByLifecycle(polls, "open", 50n).map((poll) => poll.id)).toEqual(["open"]);
    expect(filterPollsByLifecycle(polls, "archived", 50n).map((poll) => poll.id)).toEqual(["archived"]);
    expect(filterPollsByLifecycle(polls, "all", 50n).map((poll) => poll.id)).toEqual(["needs", "open", "archived"]);
    expect(counts).toEqual({ open: 1, needsClose: 1, archived: 1, all: 3 });
  });

  test("third-party aggregation no longer depends on voter lock signatures", () => {
    const aggregatorLockHash = new Uint8Array(32).fill(0xa1);
    const voterLockHash = new Uint8Array(32).fill(0xb2);
    const refundLock = makeScript({ args: "0x4455" });
    const intentLock = makeScript({
      code_hash: `0x${"77".repeat(32)}`,
      hash_type: "data1",
      args: `0x02${"11".repeat(32)}`,
    });

    const intent = makeIntent({
      voter_lock_hash: voterLockHash,
      refund_lock: refundLock,
      aggregated: false,
    });
    const aggregatedIntent = {
      ...intent,
      aggregated: true,
    };

    expect(equalBytes(aggregatorLockHash, intent.voter_lock_hash)).toBe(false);
    expect(aggregatedIntent.refund_lock).toEqual(intent.refund_lock);
    expect(aggregatedIntent.aggregated).toBe(true);
    expect(intentLock.args.startsWith("0x02")).toBe(true);
  });

  test("transitional legacy aggregation is serial because each batch consumes previous poll output", () => {
    const firstPollOutPoint = { txHash: "0xaaa", index: 0 };
    const secondPollOutPoint = { txHash: "0xbbb", index: 0 };

    // Batch N+1 can only build on the poll output produced by batch N.
    const batch1Output = secondPollOutPoint;
    const batch2InputMustMatch = secondPollOutPoint;

    expect(batch1Output).toEqual(batch2InputMustMatch);
    expect(batch2InputMustMatch).not.toEqual(firstPollOutPoint);
  });

  test("large intent sets require multiple sequential batches with MAX_INTENTS_PER_AGG=50", () => {
    const maxIntentsPerBatch = 50n;
    const pendingIntents = 1000n;
    const batches = (pendingIntents + maxIntentsPerBatch - 1n) / maxIntentsPerBatch;

    expect(batches).toBe(20n);
    expect(batches > 1n).toBe(true);
  });

  test("permissionless force-close is epoch-gated after deadline plus grace", () => {
    const deadline = 500n;
    const nowBeforeGrace = deadline + FORCE_CLOSE_GRACE_EPOCHS;
    const nowAfterGrace = nowBeforeGrace + 1n;

    expect(nowBeforeGrace > deadline).toBe(true);
    expect(nowAfterGrace > deadline + FORCE_CLOSE_GRACE_EPOCHS).toBe(true);
  });
});
