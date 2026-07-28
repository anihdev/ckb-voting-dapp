/**
 * Frontend CKB Helpers
 * ====================
 * Contains protocol constants, script helpers, and lightweight transaction
 * builders aligned to the current sharded governance lifecycle. It also
 * validates hosted runtime config so production deployments do not silently
 * boot with placeholder governance hashes.
 */
import { ccc } from "@ckb-ccc/core";
import {
  CREATOR_DEPOSIT_SHANNONS,
  DELEGATION_MIN_SHANNONS,
  MAX_DIRECT_CLOSE_SHARDS,
  MAX_CLOSE_INTENT_REFUNDS,
  MAX_SHARDS_PER_MERGE,
  MAX_TALLY_SHARDS,
  MERGE_COVERAGE_BYTES,
  MAX_DURATION_EPOCHS,
  MAX_DEADLINE_EPOCH,
  MAX_OPTION_BYTES,
  MAX_OPTIONS,
  MAX_QUESTION_BYTES,
  MIN_OPTIONS,
  MIN_DURATION_EPOCHS,
  OP,
  SHANNONS_PER_CKB,
  TALLY_SHARD_MIN_SHANNONS,
  TALLY_MERGE_RESULT_MIN_SHANNONS,
  VOTER_DEPOSIT_SHANNONS,
  ZERO_HASH_HEX,
  FORCE_CLOSE_GRACE_EPOCHS,
} from "./constants";
import {
  bytesToHex,
  EncodedScript,
  decodeDelegationData,
  encodeDelegationData,
  encodePollData,
  decodePollData,
  encodeTallyShardData,
  decodeTallyShardData,
  encodeTallyMergeResultData,
  decodeTallyMergeResultData,
  decodeVoteIntentData,
  encodeVoteIntentData,
  utf8ByteLength,
} from "./molecule";

const SCRIPT_HASH_TYPE = "data1";
const ZERO_HASH_32 = `0x${"00".repeat(32)}`;

export const GOVERNANCE_CODE_HASH =
  (import.meta as any).env?.VITE_GOVERNANCE_CODE_HASH ??
  ZERO_HASH_32;

export const GOVERNANCE_SCRIPT_TX_HASH =
  (import.meta as any).env?.VITE_GOVERNANCE_SCRIPT_TX_HASH ??
  ZERO_HASH_32;

export const CKB_RPC_URL =
  (import.meta as any).env?.VITE_CKB_RPC_URL ??
  "https://testnet.ckb.dev/";

export {
  OP,
  SHANNONS_PER_CKB,
  CREATOR_DEPOSIT_SHANNONS,
  VOTER_DEPOSIT_SHANNONS,
  DELEGATION_MIN_SHANNONS,
  TALLY_SHARD_MIN_SHANNONS,
  MAX_DIRECT_CLOSE_SHARDS,
  MAX_CLOSE_INTENT_REFUNDS,
  MAX_SHARDS_PER_MERGE,
  MAX_TALLY_SHARDS,
  MERGE_COVERAGE_BYTES,
  MAX_OPTIONS,
  MIN_OPTIONS,
  MAX_QUESTION_BYTES,
  MAX_OPTION_BYTES,
  MIN_DURATION_EPOCHS,
  MAX_DURATION_EPOCHS,
  ZERO_HASH_HEX,
  FORCE_CLOSE_GRACE_EPOCHS,
  MAX_DEADLINE_EPOCH,
};

/**
 * @notice Validates runtime env for hosted deployments.
 * @dev Rejects placeholder governance hashes and malformed critical config.
 */
export function validateRuntimeConfig(): string | null {
  const isProduction = Boolean((import.meta as any).env?.PROD);
  const isVercel = Boolean((import.meta as any).env?.VERCEL);

  if (!/^0x[0-9a-fA-F]{64}$/.test(GOVERNANCE_CODE_HASH) || GOVERNANCE_CODE_HASH === ZERO_HASH_32) {
    return isProduction
      ? "Missing VITE_GOVERNANCE_CODE_HASH for hosted deployment."
      : "Set VITE_GOVERNANCE_CODE_HASH to index live governance cells.";
  }

  if (!/^0x[0-9a-fA-F]{64}$/.test(GOVERNANCE_SCRIPT_TX_HASH) || GOVERNANCE_SCRIPT_TX_HASH === ZERO_HASH_32) {
    return isProduction
      ? "Missing VITE_GOVERNANCE_SCRIPT_TX_HASH for hosted deployment."
      : "Set VITE_GOVERNANCE_SCRIPT_TX_HASH to build transactions with the deployed script cell dependency.";
  }

  let parsedRpcUrl: URL;
  try {
    parsedRpcUrl = new URL(CKB_RPC_URL);
  } catch {
    return "VITE_CKB_RPC_URL must be a valid URL.";
  }
  if (!["http:", "https:"].includes(parsedRpcUrl.protocol)) {
    return "VITE_CKB_RPC_URL must use http or https.";
  }
  if ((isProduction || isVercel) && parsedRpcUrl.protocol !== "https:") {
    return "Hosted deployment must use an https RPC URL.";
  }
  if ((isProduction || isVercel) && ["localhost", "127.0.0.1"].includes(parsedRpcUrl.hostname)) {
    return "Hosted deployment cannot use localhost RPC URL.";
  }

  return null;
}

/**
 * @notice Converts shannons to a fixed 8-decimal CKB string.
 */
export function shannonsToCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  return `${whole}.${fractional.toString().padStart(8, "0")}`;
}

/**
 * @notice Estimates minimal occupied capacity from raw bytes.
 */
export function estimateCellCapacity(dataBytes: number, extraScriptBytes = 61): bigint {
  return BigInt(dataBytes + extraScriptBytes) * SHANNONS_PER_CKB;
}

/**
 * @notice Estimates output capacity using serialized lock/type script sizes.
 */
export function estimateOutputCapacity(lockScript: any, typeScript: any | undefined, dataBytes: number): bigint {
  const lockBytes = (ccc as any).Script.from(lockScript).toBytes().length;
  const typeBytes = typeScript ? (ccc as any).Script.from(typeScript).toBytes().length : 0;
  const occupiedBytes = 8 + lockBytes + typeBytes + dataBytes + 32;
  return BigInt(occupiedBytes) * SHANNONS_PER_CKB;
}

function encodeOpArgs(op: number, scopeHex = "0x"): string {
  return `0x${op.toString(16).padStart(2, "0")}${scopeHex.replace(/^0x/, "")}`;
}

/**
 * @notice Builds governance type scripts for operation dispatch.
 * @dev Scope bytes are appended to the op-byte args layout used by the contract.
 */
export function buildGovernanceTypeScript(op: number, scopeHex = "0x"): any {
  return (ccc as any).Script.from({
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: SCRIPT_HASH_TYPE,
    args: encodeOpArgs(op, scopeHex),
  });
}

/**
 * @notice Builds the Phase B governance lock used by vote intent cells.
 * @dev Lock args mirror the contract policy: CREATE_VOTE_INTENT op + poll type hash.
 */
export function buildIntentLockScript(pollTypeHash: string): any {
  return buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, pollTypeHash);
}

/**
 * @notice Builds a tally shard type script scoped to one poll and shard id.
 * @dev Args layout: op(1) | poll_type_hash(32) | shard_id(u32 LE).
 */
export function buildTallyShardTypeScript(pollTypeHash: string, shardId: number): any {
  if (!Number.isInteger(shardId) || shardId < 0) {
    throw new Error("shardId must be a non-negative integer");
  }
  const shardIdBytes = new Uint8Array(4);
  shardIdBytes[0] = shardId & 0xff;
  shardIdBytes[1] = (shardId >> 8) & 0xff;
  shardIdBytes[2] = (shardId >> 16) & 0xff;
  shardIdBytes[3] = (shardId >> 24) & 0xff;
  return buildGovernanceTypeScript(
    OP.CREATE_TALLY_SHARD,
    `${pollTypeHash}${bytesToHex(shardIdBytes).slice(2)}`
  );
}

/**
 * @notice Builds a tally merge-result script scoped to one poll.
 * @dev The same script is used as lock and type for merge result cells.
 */
export function buildTallyMergeResultTypeScript(pollTypeHash: string): any {
  return buildGovernanceTypeScript(OP.MERGE_TALLY_SHARDS, pollTypeHash);
}

/**
 * @notice Builds the protocol lock for poll cells.
 * @dev CLOSE_POLL validates creator-auth close and post-grace force-close, so
 * the poll lock must be protocol-controlled rather than creator-wallet locked.
 */
export function buildPollLockScript(pollTypeHash: string): any {
  return buildGovernanceTypeScript(OP.CLOSE_POLL, pollTypeHash);
}

/**
 * @notice Derives the canonical shard for a voter intent.
 * @dev VoteIntentData intentionally does not store shard_id; aggregation
 * derives it from poll_type_hash and voter_lock_hash against shard_count.
 */
export function deriveTallyShardId(
  pollTypeHash: Uint8Array,
  voterLockHash: Uint8Array,
  shardCount: number
): number {
  if (pollTypeHash.length !== 32) throw new Error("poll_type_hash must be 32 bytes");
  if (voterLockHash.length !== 32) throw new Error("voter_lock_hash must be 32 bytes");
  if (!Number.isInteger(shardCount) || shardCount <= 0 || shardCount > MAX_TALLY_SHARDS) {
    throw new Error(`shard_count must be between 1 and ${MAX_TALLY_SHARDS}`);
  }

  const digest = hashTallyShardAssignmentInput(pollTypeHash, voterLockHash);
  const bucket =
    BigInt(digest[0]) |
    (BigInt(digest[1]) << 8n) |
    (BigInt(digest[2]) << 16n) |
    (BigInt(digest[3]) << 24n) |
    (BigInt(digest[4]) << 32n) |
    (BigInt(digest[5]) << 40n) |
    (BigInt(digest[6]) << 48n) |
    (BigInt(digest[7]) << 56n);

  return Number(bucket % BigInt(shardCount));
}

/**
 * @notice Hashes the canonical shard assignment input.
 * @dev Input is exactly `poll_type_hash || voter_lock_hash`.
 */
export function hashTallyShardAssignmentInput(
  pollTypeHash: Uint8Array,
  voterLockHash: Uint8Array
): Uint8Array {
  if (pollTypeHash.length !== 32) throw new Error("poll_type_hash must be 32 bytes");
  if (voterLockHash.length !== 32) throw new Error("voter_lock_hash must be 32 bytes");

  const assignmentInput = new Uint8Array(64);
  assignmentInput.set(pollTypeHash, 0);
  assignmentInput.set(voterLockHash, 32);
  return (ccc as any).bytesFrom(
    ccc.hexFrom((ccc as any).hashCkb(assignmentInput))
  );
}

/**
 * @notice Builds the governance code cell dep used by all governance transactions.
 */
export function buildGovernanceCellDep(): any {
  return {
    outPoint: {
      txHash: GOVERNANCE_SCRIPT_TX_HASH,
      index: 0,
    },
    depType: "code",
  };
}

/**
 * @notice Computes a CKB script hash in hex format.
 */
export function hashScript(script: any): string {
  const normalized = normalizeScript(script);
  const serialized = (ccc as any).Script.from({
    codeHash: normalized.code_hash,
    hashType: normalized.hash_type,
    args: normalized.args,
  }).toBytes();
  return ccc.hexFrom((ccc as any).hashCkb(serialized));
}

/**
 * @notice Resolves a signer-compatible address object across wallet implementations.
 */
export async function getSignerAddressObj(signer: any): Promise<any> {
  if (typeof signer?.getAddressObjSecp256k1 === "function") {
    return signer.getAddressObjSecp256k1();
  }

  if (typeof signer?.getRecommendedAddressObj === "function") {
    return signer.getRecommendedAddressObj();
  }

  if (typeof signer?.getAddressObj === "function") {
    return signer.getAddressObj();
  }

  throw new Error("Connected wallet signer does not expose a compatible address method.");
}

/**
 * @notice Returns signer lock hash bytes.
 */
export async function getSignerLockHash(signer: any): Promise<Uint8Array> {
  const address = await getSignerAddressObj(signer);
  return (ccc as any).bytesFrom(hashScript(address.script));
}

/**
 * @notice Returns signer lock hash in `0x` hex format.
 */
export async function getSignerLockHashHex(signer: any): Promise<string> {
  return bytesToHex(await getSignerLockHash(signer));
}

/** @notice Returns the integer epoch from CCC and legacy epoch representations. */
export function epochNumber(epochLike: any): bigint {
  const normalized =
    typeof epochLike === "string" && epochLike.includes(",")
      ? epochLike.split(",").slice(0, 3)
      : epochLike;
  try {
    return BigInt((ccc as any).Epoch.from(normalized).integer);
  } catch {
    throw new Error("CKB client returned an invalid epoch value");
  }
}

export interface ChainTipStatus {
  epoch: bigint;
  epochIndex: bigint;
  epochLength: bigint;
  blockNumber: bigint;
  blockTimestamp: bigint;
  bestKnownBlockNumber: bigint | null;
  bestKnownBlockTimestamp: bigint | null;
  initialBlockDownload: boolean | null;
}

function optionalRpcBigInt(value: unknown): bigint | null {
  if (typeof value !== "bigint" && typeof value !== "number" && typeof value !== "string") {
    return null;
  }

  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/**
 * @notice Reads the RPC node tip and optional peer-derived sync target.
 * @dev `sync_state` describes the connected RPC node, not the user's wallet.
 * Some hosted or wallet-backed clients disable the net RPC module, so sync
 * fields intentionally fall back to null while the canonical tip remains usable.
 */
export async function getChainTipStatus(client: any): Promise<ChainTipStatus> {
  const tipHeader = await client.getTipHeader();
  const epoch = (ccc as any).Epoch.from(tipHeader.epoch);
  let syncState: any = null;

  if (typeof client?.requestor?.request === "function") {
    try {
      syncState = await client.requestor.request("sync_state", []);
    } catch {
      syncState = null;
    }
  }

  return {
    epoch: BigInt(epoch.integer),
    epochIndex: BigInt(epoch.numerator),
    epochLength: BigInt(epoch.denominator),
    blockNumber: BigInt(tipHeader.number),
    blockTimestamp: BigInt(tipHeader.timestamp),
    bestKnownBlockNumber: optionalRpcBigInt(syncState?.best_known_block_number),
    bestKnownBlockTimestamp: optionalRpcBigInt(syncState?.best_known_block_timestamp),
    initialBlockDownload:
      typeof syncState?.ibd === "boolean" ? syncState.ibd : null,
  };
}

/**
 * @notice Reads chain tip epoch from client APIs.
 * @dev CCC 1.18 returns Epoch objects; older client adapters may return packed
 * numbers or comma-delimited tuples.
 */
export async function getTipEpoch(client: any): Promise<bigint> {
  if (typeof client.getTipEpoch === "function") {
    const rawEpoch = await client.getTipEpoch();
    return epochNumber(rawEpoch);
  }

  const tipHeader = await client.getTipHeader();
  return epochNumber(tipHeader.epoch);
}

/**
 * @notice Builds a CREATE_POLL transaction.
 * @dev Initializes poll tally state and locks creator deposit on the poll cell.
 */
export async function buildCreatePollTx(
  signer: any,
  input: {
    question: string;
    options: string[];
    deadlineEpoch: bigint;
    shardCount?: number;
    tokenWeighted?: boolean;
  }
): Promise<any> {
  if (input.tokenWeighted) {
    throw new Error("Weighted polls are unsupported in the equal-weight v1 deployment");
  }
  const client = signer.client;
  const currentEpoch = await getTipEpoch(client);
  const creatorLockHash = await getSignerLockHash(signer);
  const signerAddress = await getSignerAddressObj(signer);
  const shardCount = input.shardCount ?? 8;
  if (!Number.isInteger(shardCount) || shardCount <= 0 || shardCount > MAX_TALLY_SHARDS) {
    throw new Error(`shardCount must be between 1 and ${MAX_TALLY_SHARDS}`);
  }
  if (input.deadlineEpoch <= currentEpoch) {
    throw new Error("deadlineEpoch must be after the currently observed tip epoch");
  }
  const durationEpochs = input.deadlineEpoch - currentEpoch;
  if (durationEpochs < MIN_DURATION_EPOCHS || durationEpochs > MAX_DURATION_EPOCHS) {
    throw new Error(`deadlineEpoch must be ${MIN_DURATION_EPOCHS}-${MAX_DURATION_EPOCHS} epochs after the observed tip`);
  }
  if (input.deadlineEpoch > MAX_DEADLINE_EPOCH) {
    throw new Error(`deadlineEpoch exceeds the protocol maximum ${MAX_DEADLINE_EPOCH}`);
  }

  const typeIdSeedCell = await findSignerAuthCell(signer);
  const typeIdSeedKey = outPointKey(typeIdSeedCell);
  const pollTypeId = derivePollTypeIdFromSeedInput(typeIdSeedCell, 0);
  const pollType = buildGovernanceTypeScript(OP.CREATE_POLL, pollTypeId);
  const pollTypeHash = hashScript(pollType);
  const pollLock = buildPollLockScript(pollTypeHash);
  const pollData = encodePollData({
    question: input.question,
    options: input.options,
    vote_counts: input.options.map(() => 0n),
    deadline: input.deadlineEpoch,
    creator: creatorLockHash,
    creator_lock: normalizeScript(signerAddress.script),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    // Retained codec field for historical cells; new equal-weight polls use
    // one canonical zero value and expose no active UDT configuration input.
    udt_type_hash: (ccc as any).bytesFrom(ZERO_HASH_HEX),
    shard_count: shardCount,
  });

  const capacity =
    CREATOR_DEPOSIT_SHANNONS +
    estimateOutputCapacity(pollLock, pollType, pollData.length);
  const shardOutputs = Array.from({ length: shardCount }, (_, shardId) => {
    const shardScript = buildTallyShardTypeScript(pollTypeHash, shardId);
    const shardData = encodeTallyShardData({
      poll_type_hash: (ccc as any).bytesFrom(pollTypeHash),
      shard_id: shardId,
      shard_count: shardCount,
      vote_counts: input.options.map(() => 0n),
      total_voters: 0n,
      counted_voter_lock_hashes: [],
      finalized: false,
    });
    const shardCapacity = [
      TALLY_SHARD_MIN_SHANNONS,
      estimateOutputCapacity(shardScript, shardScript, shardData.length),
    ].reduce((max, current) => (current > max ? current : max), 0n);

    return {
      output: {
        lock: shardScript,
        type: shardScript,
        capacity: shardCapacity,
      },
      data: bytesToHex(shardData),
    };
  });
  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [{ previousOutput: getOutPoint(typeIdSeedCell), since: 0 }],
    outputs: [
      {
        lock: pollLock,
        type: pollType,
        capacity,
      },
      ...shardOutputs.map((item) => item.output),
    ],
    outputsData: [bytesToHex(pollData), ...shardOutputs.map((item) => item.data)],
  });

  await tx.completeInputsByCapacity(signer);
  assertPinnedInput0(tx, typeIdSeedKey);
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInput0(tx, typeIdSeedKey);
  return tx;
}

/**
 * @notice Builds a CREATE_VOTE_INTENT transaction.
 * @dev Creates one immutable pending intent per voting authority per poll.
 */
export async function buildCreateVoteIntentTx(
  signer: any,
  input: {
    pollTypeHash: string;
    optionIndex: number;
    pollCell: any;
    delegationCell?: any;
  }
): Promise<any> {
  const client = signer.client;
  const epoch = await getTipEpoch(client);
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(getCellType(input.pollCell));
  if (pollTypeHash.toLowerCase() !== input.pollTypeHash.toLowerCase()) {
    throw new Error("Selected poll cell does not match the poll type hash");
  }
  if (pollData.is_closed) {
    throw new Error("Poll is already closed");
  }
  if (pollData.token_weighted) {
    throw new Error("Weighted polls are unsupported; only recovery actions are available");
  }
  if (epoch > pollData.deadline) {
    throw new Error("Poll deadline has already passed");
  }
  if (!Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex >= pollData.options.length) {
    throw new Error("Vote option index is invalid for this poll");
  }
  const signerLockHash = await getSignerLockHash(signer);
  const delegationData = input.delegationCell
    ? decodeDelegationData((ccc as any).bytesFrom(input.delegationCell.outputData ?? "0x"))
    : null;
  if (delegationData) {
    const delegationPollHash = bytesToHex(delegationData.poll_type_hash).toLowerCase();
    if (
      delegationPollHash !== ZERO_HASH_HEX.toLowerCase() &&
      delegationPollHash !== input.pollTypeHash.toLowerCase()
    ) {
      throw new Error("Delegation is not scoped to this poll");
    }
    if (!bytesEqual(delegationData.delegate_lock_hash, signerLockHash)) {
      throw new Error("Connected wallet is not the delegation delegate");
    }
    if (delegationData.expires_epoch !== 0n) {
      throw new Error("v1 delegations must be revocation-based (expires_epoch = 0)");
    }
  }
  const voterLockHash = delegationData ? delegationData.delegator_lock_hash : signerLockHash;
  if (
    bytesEqual(pollData.creator, voterLockHash) ||
    bytesEqual(pollData.creator, signerLockHash)
  ) {
    throw new Error("Poll creator cannot submit vote intents, directly or as a delegate");
  }
  const signerAddress = await getSignerAddressObj(signer);
  const signerAuthCell = await findSignerAuthCell(signer);
  const signerAuthKey = outPointKey(signerAuthCell);
  const refundLock = normalizeScript(
    input.delegationCell?.cellOutput?.lock ??
    input.delegationCell?.output?.lock ??
    signerAddress.script
  );
  const intentLock = buildIntentLockScript(input.pollTypeHash);

  const intentData = encodeVoteIntentData({
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash),
    voter_lock_hash: voterLockHash,
    option_index: input.optionIndex,
    // Retained codec slot only. Aggregation authenticates the intent input's
    // creation header and never trusts this caller-selected field.
    voted_at_epoch: 0n,
    aggregated: false,
    refund_lock: refundLock,
  });
  const intentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, input.pollTypeHash);
  const intentCapacity = estimateOutputCapacity(intentLock, intentType, intentData.length);
  const outputIntentCapacity = [intentCapacity, VOTER_DEPOSIT_SHANNONS]
    .reduce((max, current) => (current > max ? current : max), 0n);

  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
      ...(input.delegationCell
        ? [{
            outPoint: getOutPoint(input.delegationCell),
            depType: "code",
          }]
        : []),
    ],
    inputs: [
      { previousOutput: getOutPoint(signerAuthCell) },
    ],
    outputs: [
      {
        lock: intentLock,
        type: intentType,
        capacity: outputIntentCapacity,
      },
    ],
    outputsData: [bytesToHex(intentData)],
    witnesses: [
      (ccc as any).WitnessArgs.from({
        inputType: new Uint8Array([input.optionIndex]),
      }).toBytes(),
    ],
  });

  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, [signerAuthKey], "CREATE_VOTE_INTENT");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, [signerAuthKey], "CREATE_VOTE_INTENT");
  return tx;
}

/**
 * @notice Builds a DELEGATE transaction.
 * @dev Creates a delegation cell scoped to all polls or one poll type hash.
 */
export async function buildDelegateTx(
  signer: any,
  input: {
    delegateLockHash: string;
    pollTypeHash?: string;
    forbiddenDelegateLockHash?: string;
  }
): Promise<any> {
  const signerAddress = await getSignerAddressObj(signer);
  const delegatorLockHash = await getSignerLockHash(signer);
  const delegateLockHash = await resolveDelegateLockHash(signer, input.delegateLockHash);
  const delegatorLockHashHex = bytesToHex(delegatorLockHash).toLowerCase();
  if (delegateLockHash.toLowerCase() === delegatorLockHashHex) {
    throw new Error("Delegator and delegate must be different wallets");
  }
  if (
    input.forbiddenDelegateLockHash &&
    delegateLockHash.toLowerCase() === input.forbiddenDelegateLockHash.toLowerCase()
  ) {
    throw new Error("The poll creator cannot act as a voting delegate for this poll");
  }
  const signerAuthCell = await findSignerAuthCell(signer);
  const signerAuthKey = outPointKey(signerAuthCell);
  const delegationData = encodeDelegationData({
    delegator_lock_hash: delegatorLockHash,
    delegate_lock_hash: (ccc as any).bytesFrom(delegateLockHash),
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash ?? ZERO_HASH_HEX),
    expires_epoch: 0n,
  });
  const delegationType = buildGovernanceTypeScript(OP.DELEGATE, input.pollTypeHash ?? ZERO_HASH_HEX);
  const delegationCapacity = estimateOutputCapacity(signerAddress.script, delegationType, delegationData.length);

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [
      { previousOutput: getOutPoint(signerAuthCell) },
    ],
    outputs: [
      {
        lock: signerAddress.script,
        type: delegationType,
        capacity: delegationCapacity > DELEGATION_MIN_SHANNONS ? delegationCapacity : DELEGATION_MIN_SHANNONS,
      },
    ],
    outputsData: [bytesToHex(delegationData)],
  });

  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, [signerAuthKey], "DELEGATE");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, [signerAuthKey], "DELEGATE");
  return tx;
}

function getCellOutput(cell: any): any {
  return cell.cellOutput ?? cell.output;
}

function getCellLock(cell: any): any {
  return getCellOutput(cell).lock;
}

function getCellType(cell: any): any {
  return getCellOutput(cell).type;
}

function getCellCapacity(cell: any): bigint {
  return BigInt(getCellOutput(cell).capacity);
}

function getOutPoint(cell: any): any {
  return {
    txHash: cell.outPoint.txHash,
    index: Number(cell.outPoint.index),
  };
}

function normalizeScript(script: any): EncodedScript {
  return {
    code_hash: script.code_hash ?? script.codeHash,
    hash_type: script.hash_type ?? script.hashType,
    args: script.args,
  };
}

function scriptKey(script: any): string {
  const normalized = normalizeScript(script);
  return `${normalized.code_hash}:${normalized.hash_type}:${normalized.args}`.toLowerCase();
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

function emptyCoverage(): Uint8Array {
  return new Uint8Array(MERGE_COVERAGE_BYTES);
}

function coverageHas(coverage: Uint8Array, shardId: number): boolean {
  if (!Number.isInteger(shardId) || shardId < 0 || shardId >= MAX_TALLY_SHARDS) {
    throw new Error("shard_id is outside merge coverage range");
  }
  return (coverage[Math.floor(shardId / 8)] & (1 << (shardId % 8))) !== 0;
}

function coverageSet(coverage: Uint8Array, shardId: number): void {
  if (coverageHas(coverage, shardId)) {
    throw new Error("Duplicate shard coverage in merge inputs");
  }
  coverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
}

function coverageOrDisjoint(target: Uint8Array, source: Uint8Array): void {
  if (source.length !== MERGE_COVERAGE_BYTES) throw new Error("Merge coverage must be 32 bytes");
  for (let index = 0; index < MERGE_COVERAGE_BYTES; index += 1) {
    if ((target[index] & source[index]) !== 0) {
      throw new Error("Overlapping merge coverage");
    }
    target[index] |= source[index];
  }
}

function coverageCount(coverage: Uint8Array): number {
  let count = 0;
  for (const byte of coverage) {
    let current = byte;
    while (current > 0) {
      count += current & 1;
      current >>= 1;
    }
  }
  return count;
}

function coverageComplete(coverage: Uint8Array, shardCount: number): boolean {
  if (coverage.length !== MERGE_COVERAGE_BYTES) throw new Error("Merge coverage must be 32 bytes");
  for (let shardId = 0; shardId < shardCount; shardId += 1) {
    if (!coverageHas(coverage, shardId)) return false;
  }
  for (let shardId = shardCount; shardId < MAX_TALLY_SHARDS; shardId += 1) {
    if (coverageHas(coverage, shardId)) return false;
  }
  return true;
}

function denormalizeScript(script: EncodedScript): any {
  return {
    codeHash: script.code_hash,
    hashType: script.hash_type,
    args: script.args,
  };
}

async function resolveDelegateLockHash(signer: any, input: string): Promise<string> {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Delegate address or lock hash is required");
  }

  if (/^0x[0-9a-fA-F]{64}$/.test(trimmed)) {
    return trimmed;
  }

  if (trimmed.startsWith("ckt1") || trimmed.startsWith("ckb1")) {
    const address = await (ccc as any).Address.fromString(trimmed, signer.client);
    return hashScript(address.script);
  }

  throw new Error("Enter a valid CKB address or 32-byte lock hash");
}

async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await getSignerAddressObj(signer);

  for await (const cell of signer.client.findCells({
    script: signerAddress.script,
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const outPointKey = `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`;
    if (excludedOutPoints.includes(outPointKey)) {
      continue;
    }

    const type = getCellType(cell);
    const outputData = (cell.outputData ?? "0x") as string;
    if (!type && (outputData === "0x" || outputData === "0x0" || outputData.length <= 2)) {
      return cell;
    }
  }

  throw new Error("No plain CKB cell is available for signer auth. Fund this wallet with a plain CKB cell and retry.");
}

function outPointKeyFromOutPoint(outPoint: any): string {
  return `${outPoint.txHash}:${Number(outPoint.index)}`;
}

function outPointKey(cell: any): string {
  return outPointKeyFromOutPoint(cell.outPoint ?? cell.previousOutput);
}

export function derivePollTypeIdFromSeedInput(seedCell: any, outputIndex = 0): string {
  return (ccc as any).hashTypeId(
    { previousOutput: getOutPoint(seedCell), since: 0 },
    outputIndex
  );
}

function assertPinnedInput0(tx: any, expectedOutPointKey: string): void {
  const firstInput = tx.inputs?.[0];
  const previousOutput = firstInput?.previousOutput ?? firstInput?.previous_output;
  if (!previousOutput || outPointKeyFromOutPoint(previousOutput) !== expectedOutPointKey) {
    throw new Error("CREATE_POLL Type ID seed input was reordered or replaced");
  }
}

function assertPinnedInputs(tx: any, expectedOutPointKeys: string[], context: string): void {
  for (const [index, expectedKey] of expectedOutPointKeys.entries()) {
    const input = tx.inputs?.[index];
    const previousOutput = input?.previousOutput ?? input?.previous_output;
    if (!previousOutput || outPointKeyFromOutPoint(previousOutput) !== expectedKey) {
      throw new Error(`${context} input layout changed after fee completion at input ${index}`);
    }
  }
}

export function absoluteEpochSince(epoch: bigint): bigint {
  if (epoch < 0n || epoch > 0xffffffn) {
    throw new Error("absolute epoch since number exceeds the 24-bit CKB encoding");
  }
  return (ccc as any).Since.from({
    relative: "absolute",
    metric: "epoch",
    value: (ccc as any).epochToHex([epoch, 0n, 1n]),
  }).toNum();
}

function setProtocolInputSince(
  tx: any,
  expectedOutPointKey: string,
  since: bigint,
  context: string
): void {
  assertPinnedInputs(tx, [expectedOutPointKey], context);
  tx.inputs[0].since = since;
  assertProtocolInputSince(tx, expectedOutPointKey, since, context);
}

function assertProtocolInputSince(
  tx: any,
  expectedOutPointKey: string,
  expectedSince: bigint,
  context: string
): void {
  assertPinnedInputs(tx, [expectedOutPointKey], context);
  if (BigInt(tx.inputs[0].since) !== expectedSince) {
    throw new Error(`${context} protocol input since changed after completion`);
  }
}

async function resolveCellCreationHeader(
  client: any,
  cell: any
): Promise<{ hash: string; epoch: bigint }> {
  if (typeof client.getCellWithHeader !== "function") {
    throw new Error("Connected CKB client cannot resolve input creation headers");
  }
  const resolved = await client.getCellWithHeader(getOutPoint(cell));
  const header = resolved?.header;
  if (!header?.hash || header.epoch == null) {
    throw new Error(`Intent ${outPointKey(cell)} is not committed with a resolvable creation header`);
  }
  let epoch: bigint;
  try {
    epoch = epochNumber(header.epoch);
  } catch {
    throw new Error(`Intent ${outPointKey(cell)} has an invalid creation epoch`);
  }
  return {
    hash: String(header.hash),
    epoch,
  };
}

export function deduplicateHeaderHashes(headers: Array<{ hash: string }>): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const { hash } of headers) {
    const key = hash.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      result.push(hash);
    }
  }
  return result;
}

/**
 * @notice Builds a shard aggregation transaction for the active sharded tally path.
 * @dev Poll cell is referenced as a cell dep; only one tally shard cell is updated.
 */
export async function buildAggregateTallyShardTx(
  signer: any,
  input: { pollCell: any; shardCell: any; intentCells: any[] }
): Promise<any> {
  const pollOutput = getCellOutput(input.pollCell);
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  const shardData = decodeTallyShardData((ccc as any).bytesFrom(input.shardCell.outputData ?? "0x"));
  const shardPollHash = bytesToHex(shardData.poll_type_hash);
  const shardScript = buildTallyShardTypeScript(pollTypeHash, shardData.shard_id);

  if (pollData.is_closed) {
    throw new Error("Poll is already closed");
  }
  if (pollData.token_weighted) {
    throw new Error("Weighted polls are unsupported; only recovery actions are available");
  }
  if (pollData.shard_count <= 0) {
    throw new Error("Poll is not configured for sharded aggregation");
  }
  if (shardPollHash.toLowerCase() !== pollTypeHash.toLowerCase()) {
    throw new Error("Shard cell does not belong to the selected poll");
  }
  if (shardData.shard_count !== pollData.shard_count) {
    throw new Error("Shard count does not match poll configuration");
  }
  if (shardData.finalized) {
    throw new Error("Shard has already been finalized");
  }
  if (shardData.vote_counts.length !== pollData.options.length) {
    throw new Error("Shard vote count length does not match poll options");
  }
  if (scriptKey(getCellLock(input.shardCell)) !== scriptKey(shardScript)) {
    throw new Error("Shard lock does not match governance shard policy");
  }
  if (scriptKey(getCellType(input.shardCell)) !== scriptKey(shardScript)) {
    throw new Error("Shard type does not match governance shard policy");
  }

  const seenVoters = new Set(shardData.counted_voter_lock_hashes.map((hash) => bytesToHex(hash).toLowerCase()));
  const nextVoteCounts = [...shardData.vote_counts];
  const appendedVoters: Uint8Array[] = [];
  const intentOrigins = await Promise.all(
    input.intentCells.map((cell) => resolveCellCreationHeader(signer.client, cell))
  );
  const nextIntentOutputs = input.intentCells.map((cell, index) => {
    const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    const intentPollHash = bytesToHex(decoded.poll_type_hash).toLowerCase();
    const voterHash = bytesToHex(decoded.voter_lock_hash).toLowerCase();

    if (intentPollHash !== pollTypeHash.toLowerCase()) {
      throw new Error("Intent cell does not belong to the selected poll");
    }
    if (decoded.aggregated) {
      throw new Error("Intent cell is already aggregated");
    }
    if (decoded.option_index >= pollData.options.length) {
      throw new Error("Intent option index is invalid for this poll");
    }
    if (intentOrigins[index].epoch > pollData.deadline) {
      throw new Error("Late intent cannot be aggregated; refund it to its refund lock");
    }
    const derivedShardId = deriveTallyShardId(decoded.poll_type_hash, decoded.voter_lock_hash, shardData.shard_count);
    if (derivedShardId !== shardData.shard_id) {
      throw new Error("Intent belongs to a different tally shard");
    }
    if (seenVoters.has(voterHash)) {
      throw new Error("Duplicate voter in shard aggregation batch");
    }

    seenVoters.add(voterHash);
    appendedVoters.push(decoded.voter_lock_hash);
    nextVoteCounts[decoded.option_index] += 1n;

    return {
      output: {
        lock: buildIntentLockScript(pollTypeHash),
        type: getCellType(cell),
        capacity: getCellCapacity(cell),
      },
      data: bytesToHex(
        encodeVoteIntentData({
          ...decoded,
          aggregated: true,
        })
      ),
    };
  });

  if (nextIntentOutputs.length === 0) {
    throw new Error("No pending intent cells to aggregate for this shard");
  }

  const updatedShard = encodeTallyShardData({
    ...shardData,
    vote_counts: nextVoteCounts,
    total_voters: shardData.total_voters + BigInt(nextIntentOutputs.length),
    counted_voter_lock_hashes: [...shardData.counted_voter_lock_hashes, ...appendedVoters],
    finalized: false,
  });

  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    // Source::Input authenticates each intent's creation block against these
    // exact, first-seen-deduplicated header dependencies.
    headerDeps: deduplicateHeaderHashes(intentOrigins),
    inputs: [
      { previousOutput: getOutPoint(input.shardCell) },
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: getCellLock(input.shardCell),
        type: getCellType(input.shardCell),
        capacity: getCellCapacity(input.shardCell),
      },
      ...nextIntentOutputs.map((item) => item.output),
    ],
    outputsData: [bytesToHex(updatedShard), ...nextIntentOutputs.map((item) => item.data)],
    witnesses: new Array(input.intentCells.length + 1).fill("0x"),
  });

  const aggregatePinnedKeys = [
    outPointKey(input.shardCell),
    ...input.intentCells.map((cell) => outPointKey(cell)),
  ];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, aggregatePinnedKeys, "CREATE_TALLY_SHARD aggregation");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, aggregatePinnedKeys, "CREATE_TALLY_SHARD aggregation");
  return tx;
}

/**
 * @notice Builds a bounded MERGE_TALLY_SHARDS transaction for large sharded polls.
 * @dev Consumed shard/result capacity remains locked in the produced result cell.
 */
export async function buildMergeTallyShardsTx(
  signer: any,
  input: { pollCell: any; shardCells?: any[]; mergeResultCells?: any[] }
): Promise<any> {
  const pollOutput = getCellOutput(input.pollCell);
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  const shardCells = input.shardCells ?? [];
  const mergeResultCells = input.mergeResultCells ?? [];
  const mergeInputCount = shardCells.length + mergeResultCells.length;
  if (pollData.is_closed) throw new Error("Poll is already closed");
  if (pollData.shard_count <= MAX_DIRECT_CLOSE_SHARDS) {
    throw new Error("Merge result path is only required for large shard-count polls");
  }
  if (mergeInputCount === 0) throw new Error("No shard or merge result inputs selected");
  if (mergeInputCount > MAX_SHARDS_PER_MERGE) {
    throw new Error(`Merge transaction can consume at most ${MAX_SHARDS_PER_MERGE} tally inputs`);
  }

  const coverage = emptyCoverage();
  const voteCounts = pollData.options.map(() => 0n);
  let totalVoters = 0n;
  let maxInputLevel = 0;
  let lockedCapacity = 0n;

  for (const cell of shardCells) {
    const shard = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    if (bytesToHex(shard.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
      throw new Error("Shard cell does not belong to the selected poll");
    }
    if (shard.shard_count !== pollData.shard_count) {
      throw new Error("Shard count does not match poll configuration");
    }
    if (!shard.finalized) throw new Error("Merge requires finalized shard cells");
    if (shard.vote_counts.length !== pollData.options.length) {
      throw new Error("Shard vote count length does not match poll options");
    }
    const expectedScript = buildTallyShardTypeScript(pollTypeHash, shard.shard_id);
    if (scriptKey(getCellLock(cell)) !== scriptKey(expectedScript) || scriptKey(getCellType(cell)) !== scriptKey(expectedScript)) {
      throw new Error("Shard lock/type does not match governance shard policy");
    }
    coverageSet(coverage, shard.shard_id);
    shard.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += shard.total_voters;
    lockedCapacity += getCellCapacity(cell);
  }

  const mergeScript = buildTallyMergeResultTypeScript(pollTypeHash);
  for (const cell of mergeResultCells) {
    const result = decodeTallyMergeResultData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    if (bytesToHex(result.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
      throw new Error("Merge result cell does not belong to the selected poll");
    }
    if (result.coverage.length !== MERGE_COVERAGE_BYTES) {
      throw new Error("Merge result coverage must be 32 bytes");
    }
    if (result.vote_counts.length !== pollData.options.length) {
      throw new Error("Merge result vote count length does not match poll options");
    }
    if (result.version !== 1) throw new Error("Unsupported merge result version");
    if (scriptKey(getCellLock(cell)) !== scriptKey(mergeScript) || scriptKey(getCellType(cell)) !== scriptKey(mergeScript)) {
      throw new Error("Merge result lock/type does not match governance merge policy");
    }
    coverageOrDisjoint(coverage, result.coverage);
    result.vote_counts.forEach((count, index) => {
      voteCounts[index] += count;
    });
    totalVoters += result.total_voters;
    maxInputLevel = Math.max(maxInputLevel, result.merge_level);
    lockedCapacity += getCellCapacity(cell);
  }

  if (coverageCount(coverage) === 0) throw new Error("Merge result must cover at least one shard");

  const resultBytes = encodeTallyMergeResultData({
    poll_type_hash: (ccc as any).bytesFrom(pollTypeHash),
    coverage,
    vote_counts: voteCounts,
    total_voters: totalVoters,
    merge_level: maxInputLevel + 1,
    version: 1,
  });
  const minResultCapacity = estimateOutputCapacity(mergeScript, mergeScript, resultBytes.length);
  const resultCapacity = [TALLY_MERGE_RESULT_MIN_SHANNONS, minResultCapacity, lockedCapacity]
    .reduce((max, current) => (current > max ? current : max), 0n);

  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    inputs: [
      ...shardCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
      ...mergeResultCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: mergeScript,
        type: mergeScript,
        capacity: resultCapacity,
      },
    ],
    outputsData: [bytesToHex(resultBytes)],
    witnesses: new Array(mergeInputCount).fill("0x"),
  });

  const mergePinnedKeys = [
    ...shardCells.map((cell) => outPointKey(cell)),
    ...mergeResultCells.map((cell) => outPointKey(cell)),
  ];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, mergePinnedKeys, "MERGE_TALLY_SHARDS");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, mergePinnedKeys, "MERGE_TALLY_SHARDS");
  return tx;
}

/**
 * @notice Builds a shard finalization transaction after poll deadline.
 * @dev Finalization freezes one shard before small direct close or merge/result close.
 */
export async function buildFinalizeTallyShardTx(
  signer: any,
  input: { pollCell: any; shardCell: any }
): Promise<any> {
  const currentEpoch = await getTipEpoch(signer.client);
  const pollOutput = getCellOutput(input.pollCell);
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  const shardData = decodeTallyShardData((ccc as any).bytesFrom(input.shardCell.outputData ?? "0x"));
  const shardScript = buildTallyShardTypeScript(pollTypeHash, shardData.shard_id);

  if (pollData.is_closed) throw new Error("Poll is already closed");
  if (currentEpoch <= pollData.deadline) throw new Error("Shard cannot be finalized before poll deadline");
  if (bytesToHex(shardData.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
    throw new Error("Shard cell does not belong to the selected poll");
  }
  if (shardData.shard_count !== pollData.shard_count) {
    throw new Error("Shard count does not match poll configuration");
  }
  if (shardData.finalized) {
    throw new Error("Shard is already finalized");
  }
  if (scriptKey(getCellLock(input.shardCell)) !== scriptKey(shardScript)) {
    throw new Error("Shard lock does not match governance shard policy");
  }
  if (scriptKey(getCellType(input.shardCell)) !== scriptKey(shardScript)) {
    throw new Error("Shard type does not match governance shard policy");
  }
  const requiredSince = absoluteEpochSince(pollData.deadline + 1n);

  const finalizedShard = encodeTallyShardData({
    ...shardData,
    finalized: true,
  });
  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    inputs: [{ previousOutput: getOutPoint(input.shardCell) }],
    outputs: [
      {
        lock: getCellLock(input.shardCell),
        type: getCellType(input.shardCell),
        capacity: getCellCapacity(input.shardCell),
      },
    ],
    outputsData: [bytesToHex(finalizedShard)],
    witnesses: ["0x"],
  });

  const finalizePinnedKeys = [outPointKey(input.shardCell)];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, finalizePinnedKeys, "CREATE_TALLY_SHARD finalization");
  setProtocolInputSince(
    tx,
    finalizePinnedKeys[0],
    requiredSince,
    "CREATE_TALLY_SHARD finalization"
  );
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, finalizePinnedKeys, "CREATE_TALLY_SHARD finalization");
  assertProtocolInputSince(
    tx,
    finalizePinnedKeys[0],
    requiredSince,
    "CREATE_TALLY_SHARD finalization"
  );
  return tx;
}

/**
 * @notice Builds creator-authorized CLOSE_POLL transaction.
 * @dev Returns creator deposit and refunds intent deposits through refund locks.
 */
export async function buildClosePollTx(
  signer: any,
  input: { pollCell: any; intentCells: any[]; shardCells?: any[]; mergeResultCell?: any }
): Promise<any> {
  const client = signer.client;
  const currentEpoch = await getTipEpoch(client);
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  if (currentEpoch <= previousPoll.deadline) {
    throw new Error("Poll cannot be closed before deadline");
  }
  const shardCells = input.shardCells ?? [];
  if (previousPoll.shard_count <= 0) {
    throw new Error("Non-sharded poll-cell aggregation is retired in this deployment");
  }
  const largeSharded = previousPoll.shard_count > MAX_DIRECT_CLOSE_SHARDS;
  if (largeSharded && shardCells.length > 0) {
    throw new Error("Large sharded close accepts only the complete merge result, not shard cells");
  }
  if (!largeSharded && input.mergeResultCell) {
    throw new Error("Small sharded close accepts only the complete finalized shard set");
  }
  if (largeSharded && !input.mergeResultCell) {
    throw new Error("Large sharded close requires a complete final merge result cell");
  }
  if (!largeSharded && shardCells.length !== previousPoll.shard_count) {
    throw new Error("Sharded close requires the complete finalized shard set");
  }

  let finalVoteCounts = previousPoll.vote_counts;
  let finalTotalVoters = previousPoll.total_voters;
  if (largeSharded) {
    const mergeScript = buildTallyMergeResultTypeScript(pollTypeHash);
    const result = decodeTallyMergeResultData((ccc as any).bytesFrom(input.mergeResultCell.outputData ?? "0x"));
    if (bytesToHex(result.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
      throw new Error("Merge result cell does not belong to the selected poll");
    }
    if (!coverageComplete(result.coverage, previousPoll.shard_count)) {
      throw new Error("Merge result does not cover every shard");
    }
    if (scriptKey(getCellLock(input.mergeResultCell)) !== scriptKey(mergeScript) || scriptKey(getCellType(input.mergeResultCell)) !== scriptKey(mergeScript)) {
      throw new Error("Merge result lock/type does not match governance merge policy");
    }
    finalVoteCounts = result.vote_counts;
    finalTotalVoters = result.total_voters;
  } else {
    finalVoteCounts = previousPoll.options.map(() => 0n);
    finalTotalVoters = 0n;
    const seenShardIds = new Set<number>();
    for (const cell of shardCells) {
      const shard = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
      if (bytesToHex(shard.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
        throw new Error("Shard cell does not belong to the selected poll");
      }
      if (shard.shard_count !== previousPoll.shard_count) {
        throw new Error("Shard count does not match poll configuration");
      }
      if (seenShardIds.has(shard.shard_id)) {
        throw new Error("Duplicate shard in close set");
      }
      if (!shard.finalized) {
        throw new Error("Sharded close requires every shard to be finalized");
      }
      const expectedScript = buildTallyShardTypeScript(pollTypeHash, shard.shard_id);
      if (scriptKey(getCellLock(cell)) !== scriptKey(expectedScript) || scriptKey(getCellType(cell)) !== scriptKey(expectedScript)) {
        throw new Error("Shard lock/type does not match governance shard policy");
      }
      seenShardIds.add(shard.shard_id);
      shard.vote_counts.forEach((count, index) => {
        if (index < finalVoteCounts.length) finalVoteCounts[index] += count;
      });
      finalTotalVoters += shard.total_voters;
    }
  }

  const decodedIntents = input.intentCells.map((cell) => ({
    cell,
    decoded: (() => {
      const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
      if (bytesToHex(decoded.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
        throw new Error("Intent cell does not belong to the selected poll");
      }
      return decoded;
    })(),
  }));
  const pendingIntentCount = decodedIntents.filter(({ decoded }) => !decoded.aggregated).length;
  if (BigInt(pendingIntentCount) < previousPoll.pending_intent_count) {
    throw new Error("Close requires at least the pending intents tracked on the poll state");
  }

  const creatorLock = denormalizeScript(previousPoll.creator_lock);
  const creatorAuthCell = await findSignerAuthCell(signer, [
    `${input.pollCell.outPoint.txHash}:${Number(input.pollCell.outPoint.index)}`,
    ...shardCells.map((cell) => `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`),
    ...(input.mergeResultCell ? [`${input.mergeResultCell.outPoint.txHash}:${Number(input.mergeResultCell.outPoint.index)}`] : []),
    ...input.intentCells.map((cell) => `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`),
  ]);
  const closePinnedKeys = [
    outPointKey(input.pollCell),
    outPointKey(creatorAuthCell),
    ...(largeSharded && input.mergeResultCell
      ? [outPointKey(input.mergeResultCell)]
      : shardCells.map((cell) => outPointKey(cell))),
    ...input.intentCells.map((cell) => outPointKey(cell)),
  ];

  const closedPoll = encodePollData({
    ...previousPoll,
    vote_counts: finalVoteCounts,
    total_voters: finalTotalVoters,
    counted_voter_lock_hashes: [],
    is_closed: true,
    pending_intent_count: 0n,
  });
  const closedPollMinCapacity = estimateOutputCapacity(
    pollOutput.lock,
    pollOutput.type,
    closedPoll.length
  );
  const closedPollCandidateCapacity = getCellCapacity(input.pollCell) - previousPoll.creator_deposit;
  const closedPollCapacity = closedPollCandidateCapacity > closedPollMinCapacity
    ? closedPollCandidateCapacity
    : closedPollMinCapacity;

  const voterReturns = decodedIntents.map(({ cell, decoded }) => ({
    lock: denormalizeScript(decoded.refund_lock),
    capacity: getCellCapacity(cell),
  }));
  const shardReturns = shardCells.map((cell) => ({
    lock: creatorLock,
    capacity: getCellCapacity(cell),
  }));
  const mergeResultReturns = input.mergeResultCell ? [{
    lock: creatorLock,
    capacity: getCellCapacity(input.mergeResultCell),
  }] : [];

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      { previousOutput: getOutPoint(creatorAuthCell) },
      ...(largeSharded && input.mergeResultCell
        ? [{ previousOutput: getOutPoint(input.mergeResultCell) }]
        : shardCells.map((cell) => ({ previousOutput: getOutPoint(cell) }))),
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: pollOutput.lock,
        type: pollOutput.type,
        capacity: closedPollCapacity,
      },
      {
        lock: creatorLock,
        capacity: previousPoll.creator_deposit,
      },
      ...shardReturns,
      ...mergeResultReturns,
      ...voterReturns,
    ],
    outputsData: [
      bytesToHex(closedPoll),
      "0x",
      ...shardReturns.map(() => "0x"),
      ...mergeResultReturns.map(() => "0x"),
      ...voterReturns.map(() => "0x"),
    ],
    witnesses: new Array(input.intentCells.length + (largeSharded ? mergeResultReturns.length : shardCells.length) + 2).fill("0x"),
  });

  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, closePinnedKeys, "CLOSE_POLL creator close");
  const requiredSince = absoluteEpochSince(previousPoll.deadline + 1n);
  setProtocolInputSince(
    tx,
    closePinnedKeys[0],
    requiredSince,
    "CLOSE_POLL creator close"
  );
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, closePinnedKeys, "CLOSE_POLL creator close");
  assertProtocolInputSince(
    tx,
    closePinnedKeys[0],
    requiredSince,
    "CLOSE_POLL creator close"
  );
  return tx;
}

/**
 * @notice Builds permissionless recovery CLOSE_POLL transaction after grace.
 * @dev Mirrors contract force-close mode by closing without creator auth input.
 */
export async function buildForceCloseTx(
  signer: any,
  input: { pollCell: any; intentCells: any[]; shardCells?: any[]; mergeResultCell?: any }
): Promise<any> {
  const client = signer.client;
  const currentEpoch = await getTipEpoch(client);
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  const shardCells = input.shardCells ?? [];
  if (previousPoll.shard_count <= 0) {
    throw new Error("Non-sharded poll-cell aggregation is retired in this deployment");
  }
  const largeSharded = previousPoll.shard_count > MAX_DIRECT_CLOSE_SHARDS;
  if (largeSharded && shardCells.length > 0) {
    throw new Error("Large sharded force-close accepts only the complete merge result, not shard cells");
  }
  if (!largeSharded && input.mergeResultCell) {
    throw new Error("Small sharded force-close accepts only the complete finalized shard set");
  }
  if (largeSharded && !input.mergeResultCell) {
    throw new Error("Large sharded force-close requires a complete final merge result cell");
  }
  if (!largeSharded && shardCells.length !== previousPoll.shard_count) {
    throw new Error("Sharded force-close requires the complete finalized shard set");
  }

  let finalVoteCounts = previousPoll.vote_counts;
  let finalTotalVoters = previousPoll.total_voters;
  if (largeSharded) {
    const mergeScript = buildTallyMergeResultTypeScript(pollTypeHash);
    const result = decodeTallyMergeResultData((ccc as any).bytesFrom(input.mergeResultCell.outputData ?? "0x"));
    if (bytesToHex(result.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
      throw new Error("Merge result cell does not belong to the selected poll");
    }
    if (!coverageComplete(result.coverage, previousPoll.shard_count)) {
      throw new Error("Merge result does not cover every shard");
    }
    if (scriptKey(getCellLock(input.mergeResultCell)) !== scriptKey(mergeScript) || scriptKey(getCellType(input.mergeResultCell)) !== scriptKey(mergeScript)) {
      throw new Error("Merge result lock/type does not match governance merge policy");
    }
    finalVoteCounts = result.vote_counts;
    finalTotalVoters = result.total_voters;
  } else {
    finalVoteCounts = previousPoll.options.map(() => 0n);
    finalTotalVoters = 0n;
    const seenShardIds = new Set<number>();
    for (const cell of shardCells) {
      const shard = decodeTallyShardData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
      if (bytesToHex(shard.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
        throw new Error("Shard cell does not belong to the selected poll");
      }
      if (shard.shard_count !== previousPoll.shard_count) {
        throw new Error("Shard count does not match poll configuration");
      }
      if (seenShardIds.has(shard.shard_id)) {
        throw new Error("Duplicate shard in close set");
      }
      if (!shard.finalized) {
        throw new Error("Sharded force-close requires every shard to be finalized");
      }
      const expectedScript = buildTallyShardTypeScript(pollTypeHash, shard.shard_id);
      if (scriptKey(getCellLock(cell)) !== scriptKey(expectedScript) || scriptKey(getCellType(cell)) !== scriptKey(expectedScript)) {
        throw new Error("Shard lock/type does not match governance shard policy");
      }
      seenShardIds.add(shard.shard_id);
      shard.vote_counts.forEach((count, index) => {
        if (index < finalVoteCounts.length) finalVoteCounts[index] += count;
      });
      finalTotalVoters += shard.total_voters;
    }
  }
  const decodedIntents = input.intentCells.map((cell) => ({
    cell,
    decoded: (() => {
      const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
      if (bytesToHex(decoded.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
        throw new Error("Intent cell does not belong to the selected poll");
      }
      return decoded;
    })(),
  }));
  const pendingIntentCount = decodedIntents.filter(({ decoded }) => !decoded.aggregated).length;
  if (BigInt(pendingIntentCount) < previousPoll.pending_intent_count) {
    throw new Error("Force-close requires at least the pending intents tracked on the poll state");
  }

  const allowEpoch = previousPoll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
  if (currentEpoch <= allowEpoch) {
    throw new Error("Force-close not yet allowed by epoch");
  }

  const closedPoll = encodePollData({
    ...previousPoll,
    vote_counts: finalVoteCounts,
    total_voters: finalTotalVoters,
    counted_voter_lock_hashes: [],
    is_closed: true,
    pending_intent_count: 0n,
  });
  const closedPollMinCapacity = estimateOutputCapacity(
    pollOutput.lock,
    pollOutput.type,
    closedPoll.length
  );
  const closedPollCandidateCapacity = getCellCapacity(input.pollCell) - previousPoll.creator_deposit;
  const closedPollCapacity = closedPollCandidateCapacity > closedPollMinCapacity
    ? closedPollCandidateCapacity
    : closedPollMinCapacity;

  const voterReturns = decodedIntents.map(({ cell, decoded }) => ({
    lock: denormalizeScript(decoded.refund_lock),
    capacity: getCellCapacity(cell),
  }));
  const creatorLock = denormalizeScript(previousPoll.creator_lock);
  const shardReturns = shardCells.map((cell) => ({
    lock: creatorLock,
    capacity: getCellCapacity(cell),
  }));
  const mergeResultReturns = input.mergeResultCell ? [{
    lock: creatorLock,
    capacity: getCellCapacity(input.mergeResultCell),
  }] : [];
  const forceClosePinnedKeys = [
    outPointKey(input.pollCell),
    ...(largeSharded && input.mergeResultCell
      ? [outPointKey(input.mergeResultCell)]
      : shardCells.map((cell) => outPointKey(cell))),
    ...input.intentCells.map((cell) => outPointKey(cell)),
  ];

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      ...(largeSharded && input.mergeResultCell
        ? [{ previousOutput: getOutPoint(input.mergeResultCell) }]
        : shardCells.map((cell) => ({ previousOutput: getOutPoint(cell) }))),
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: getCellLock(input.pollCell),
        type: pollOutput.type,
        capacity: closedPollCapacity,
      },
      {
        lock: creatorLock,
        capacity: previousPoll.creator_deposit,
      },
      ...shardReturns,
      ...mergeResultReturns,
      ...voterReturns,
    ],
    outputsData: [
      bytesToHex(closedPoll),
      "0x",
      ...shardReturns.map(() => "0x"),
      ...mergeResultReturns.map(() => "0x"),
      ...voterReturns.map(() => "0x"),
    ],
    witnesses: new Array(input.intentCells.length + (largeSharded ? mergeResultReturns.length : shardCells.length) + 1).fill("0x"),
  });

  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, forceClosePinnedKeys, "CLOSE_POLL force-close");
  const requiredSince = absoluteEpochSince(allowEpoch + 1n);
  setProtocolInputSince(
    tx,
    forceClosePinnedKeys[0],
    requiredSince,
    "CLOSE_POLL force-close"
  );
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, forceClosePinnedKeys, "CLOSE_POLL force-close");
  assertProtocolInputSince(
    tx,
    forceClosePinnedKeys[0],
    requiredSince,
    "CLOSE_POLL force-close"
  );
  return tx;
}

/**
 * @notice Builds a standalone post-close refund for one governance intent cell.
 * @dev This protects deposits for intents omitted from close. It does not
 * prove the omitted vote was counted.
 */
export async function buildRefundClosedIntentTx(
  signer: any,
  input: { pollCell: any; intentCell: any }
): Promise<any> {
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  if (!pollData.is_closed) {
    throw new Error("Standalone intent refund requires a closed poll cell dep");
  }
  const pollTypeHash = hashScript(getCellType(input.pollCell));
  const intent = decodeVoteIntentData((ccc as any).bytesFrom(input.intentCell.outputData ?? "0x"));
  if (bytesToHex(intent.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
    throw new Error("Intent cell does not belong to the supplied closed poll");
  }

  const refundLock = denormalizeScript(intent.refund_lock);
  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    inputs: [{ previousOutput: getOutPoint(input.intentCell) }],
    outputs: [
      {
        lock: refundLock,
        capacity: getCellCapacity(input.intentCell),
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x"],
  });

  const refundPinnedKeys = [outPointKey(input.intentCell)];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, refundPinnedKeys, "post-close intent refund");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, refundPinnedKeys, "post-close intent refund");
  return tx;
}

/**
 * Builds an immediate full-capacity refund for an intent committed after the
 * poll deadline. The creation header is both checked off chain and supplied
 * so the contract can authenticate it through Source::Input.
 */
export async function buildRefundLateIntentTx(
  signer: any,
  input: { pollCell: any; intentCell: any }
): Promise<any> {
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  if (pollData.is_closed) {
    throw new Error("Use the post-close refund path for a closed poll");
  }
  const pollTypeHash = hashScript(getCellType(input.pollCell));
  const intent = decodeVoteIntentData((ccc as any).bytesFrom(input.intentCell.outputData ?? "0x"));
  if (bytesToHex(intent.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
    throw new Error("Intent cell does not belong to the supplied poll");
  }
  if (intent.aggregated) {
    throw new Error("Aggregated intent markers remain locked until poll close");
  }
  const origin = await resolveCellCreationHeader(signer.client, input.intentCell);
  if (origin.epoch <= pollData.deadline) {
    throw new Error("Only an intent created after the deadline can use the late refund path");
  }

  const inputCapacity = getCellCapacity(input.intentCell);
  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    headerDeps: [origin.hash],
    inputs: [{ previousOutput: getOutPoint(input.intentCell) }],
    outputs: [
      {
        lock: denormalizeScript(intent.refund_lock),
        capacity: inputCapacity,
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x"],
  });

  const pinnedKeys = [outPointKey(input.intentCell)];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, pinnedKeys, "late intent refund");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, pinnedKeys, "late intent refund");
  if (BigInt(tx.outputs[0].capacity) !== inputCapacity) {
    throw new Error("late intent refund must preserve the intent's exact full capacity");
  }
  return tx;
}

/**
 * @notice Builds a delegation revocation transaction.
 * @dev Consumes an OP.DELEGATE cell; retired opcode 0x06 is never emitted.
 */
export async function buildRevokeDelegationTx(
  signer: any,
  input: { delegationCell: any }
): Promise<any> {
  const delegationOutput = getCellOutput(input.delegationCell);

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [{ previousOutput: getOutPoint(input.delegationCell) }],
    outputs: [
      {
        lock: delegationOutput.lock,
        capacity: getCellCapacity(input.delegationCell),
      },
    ],
    outputsData: ["0x"],
    witnesses: ["0x"],
  });

  const revokePinnedKeys = [outPointKey(input.delegationCell)];
  await tx.completeInputsByCapacity(signer);
  assertPinnedInputs(tx, revokePinnedKeys, "delegation revocation");
  await tx.completeFeeBy(signer, 1000);
  assertPinnedInputs(tx, revokePinnedKeys, "delegation revocation");
  return tx;
}

/**
 * @notice Signs and sends a transaction using compatible signer interfaces.
 */
export async function signAndSendTx(signer: any, tx: any): Promise<string> {
  if (typeof signer?.sendTransaction === "function") {
    return signer.sendTransaction(tx);
  }

  await signer.signTransaction(tx);
  return signer.client.sendTransaction(tx);
}

/**
 * @notice Validates user input for CREATE_POLL prior to transaction build.
 */
export function validateCreatePollInput(input: {
  question: string;
  options: string[];
  durationEpochs: number;
  tokenWeighted?: boolean;
}): string | null {
  if (input.tokenWeighted) return "Weighted polls are unsupported in the equal-weight v1 deployment";
  if (!input.question.trim()) return "Question is required";
  if (utf8ByteLength(input.question) > MAX_QUESTION_BYTES) {
    return `Question exceeds ${MAX_QUESTION_BYTES.toString()} UTF-8 bytes`;
  }
  if (input.options.length < MIN_OPTIONS || input.options.length > MAX_OPTIONS) {
    return `Options must be between ${MIN_OPTIONS.toString()} and ${MAX_OPTIONS.toString()}`;
  }
  if (input.options.some((option) => !option.trim() || utf8ByteLength(option) > MAX_OPTION_BYTES)) {
    return `Each option must be 1-${MAX_OPTION_BYTES.toString()} UTF-8 bytes`;
  }
  if (!Number.isSafeInteger(input.durationEpochs)) {
    return "Duration must be a whole number of epochs";
  }
  if (BigInt(input.durationEpochs) < MIN_DURATION_EPOCHS || BigInt(input.durationEpochs) > MAX_DURATION_EPOCHS) {
    return "Duration must be between 1 and 1000 epochs";
  }
  return null;
}
