/**
 * Frontend CKB Helpers
 * ====================
 * Contains protocol constants, script helpers, and lightweight transaction
 * builders aligned to the current six-operation governance contract. It also
 * validates hosted runtime config so production deployments do not silently
 * boot with placeholder governance hashes.
 */
import { ccc } from "@ckb-ccc/core";
import {
  CREATOR_DEPOSIT_SHANNONS,
  DELEGATION_MIN_SHANNONS,
  MAX_WEIGHT_UNITS_PER_INTENT,
  MAX_DURATION_EPOCHS,
  MAX_OPTIONS,
  MIN_DURATION_EPOCHS,
  OP,
  SHANNONS_PER_CKB,
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
  decodeVoteIntentData,
  encodeVoteIntentData,
} from "./molecule";

const SCRIPT_HASH_TYPE = "data1";
const ZERO_HASH_32 = `0x${"00".repeat(32)}`;
const AGGREGATE_FEE_RESERVE_SHANNONS = 1_000_000n;

export const GOVERNANCE_CODE_HASH =
  (import.meta as any).env?.VITE_GOVERNANCE_CODE_HASH ??
  ZERO_HASH_32;

export const GOVERNANCE_SCRIPT_TX_HASH =
  (import.meta as any).env?.VITE_GOVERNANCE_SCRIPT_TX_HASH ??
  ZERO_HASH_32;

export const CKB_RPC_URL =
  (import.meta as any).env?.VITE_CKB_RPC_URL ??
  "https://testnet.ckb.dev/rpc";

export {
  OP,
  SHANNONS_PER_CKB,
  CREATOR_DEPOSIT_SHANNONS,
  VOTER_DEPOSIT_SHANNONS,
  DELEGATION_MIN_SHANNONS,
  MAX_WEIGHT_UNITS_PER_INTENT,
  MAX_OPTIONS,
  MIN_DURATION_EPOCHS,
  MAX_DURATION_EPOCHS,
  ZERO_HASH_HEX,
  FORCE_CLOSE_GRACE_EPOCHS,
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

function sanitizeWeightUnits(
  requestedWeightUnits: number | undefined,
  tokenWeighted: boolean
): bigint {
  const normalized = BigInt(requestedWeightUnits ?? 1);
  if (normalized < 1n) {
    throw new Error("Vote weight must be at least 1");
  }
  if (normalized > MAX_WEIGHT_UNITS_PER_INTENT) {
    throw new Error(`Vote weight cannot exceed ${MAX_WEIGHT_UNITS_PER_INTENT.toString()} units`);
  }
  if (!tokenWeighted && normalized !== 1n) {
    throw new Error("Weighted vote amounts are only valid for token-weighted polls");
  }
  return normalized;
}

function computeIntentWeightUnits(intentCapacity: bigint, tokenWeighted: boolean): bigint {
  if (!tokenWeighted) {
    return 1n;
  }
  const rawUnits = intentCapacity / VOTER_DEPOSIT_SHANNONS;
  if (rawUnits < 1n) {
    throw new Error("Intent capacity is below the minimum weighted voting unit");
  }
  return rawUnits > MAX_WEIGHT_UNITS_PER_INTENT ? MAX_WEIGHT_UNITS_PER_INTENT : rawUnits;
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

/**
 * @notice Reads chain tip epoch from client APIs.
 * @dev Supports different return types used by CCC client variants.
 */
export async function getTipEpoch(client: any): Promise<bigint> {
  if (typeof client.getTipEpoch === "function") {
    const rawEpoch = await client.getTipEpoch();
    if (typeof rawEpoch === "bigint") return rawEpoch;
    if (typeof rawEpoch === "number") return BigInt(rawEpoch);
    if (typeof rawEpoch === "string") return BigInt(rawEpoch.split(",")[0]);
  }

  const tipHeader = await client.getTipHeader();
  return BigInt(String(tipHeader.epoch).split(",")[0]);
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
    durationEpochs: number;
    tokenWeighted?: boolean;
    udtTypeHash?: string;
  }
): Promise<any> {
  const client = signer.client;
  const tipHeader = await client.getTipHeader();
  const currentEpoch = await getTipEpoch(client);
  const creatorLockHash = await getSignerLockHash(signer);

  const pollData = encodePollData({
    question: input.question,
    options: input.options,
    vote_counts: input.options.map(() => 0n),
    deadline: currentEpoch + BigInt(input.durationEpochs),
    creator: creatorLockHash,
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: input.tokenWeighted ?? false,
    udt_type_hash: (ccc as any).bytesFrom(input.udtTypeHash ?? ZERO_HASH_HEX),
  });

  const signerAddress = await getSignerAddressObj(signer);
  const pollScope = generateRandomScopeHex();
  const pollType = buildGovernanceTypeScript(OP.CREATE_POLL, pollScope);
  const capacity =
    CREATOR_DEPOSIT_SHANNONS +
    estimateOutputCapacity(signerAddress.script, pollType, pollData.length);
  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    headerDeps: [tipHeader.hash],
    outputs: [
      {
        lock: signerAddress.script,
        type: pollType,
        capacity,
      },
    ],
    outputsData: [bytesToHex(pollData)],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
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
    weightUnits?: number;
  }
): Promise<any> {
  const client = signer.client;
  const tipHeader = await client.getTipHeader();
  const epoch = await getTipEpoch(client);
  const pollData = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(getCellType(input.pollCell));
  if (pollTypeHash.toLowerCase() !== input.pollTypeHash.toLowerCase()) {
    throw new Error("Selected poll cell does not match the poll type hash");
  }
  if (pollData.is_closed) {
    throw new Error("Poll is already closed");
  }
  if (epoch > pollData.deadline) {
    throw new Error("Poll deadline has already passed");
  }
  const voteWeightUnits = sanitizeWeightUnits(input.weightUnits, pollData.token_weighted);

  const signerLockHash = await getSignerLockHash(signer);
  const voterLockHash = input.delegationCell
    ? decodeDelegationData((ccc as any).bytesFrom(input.delegationCell.outputData ?? "0x")).delegator_lock_hash
    : signerLockHash;
  const signerAddress = await getSignerAddressObj(signer);
  const excludedOutPoints: string[] = [];
  if (input.delegationCell) {
    excludedOutPoints.push(
      `${input.delegationCell.outPoint.txHash}:${Number(input.delegationCell.outPoint.index)}`
    );
  }
  const signerAuthCell = await findSignerAuthCell(
    signer,
    excludedOutPoints
  );
  const refundLock = normalizeScript(
    input.delegationCell?.cellOutput?.lock ??
    input.delegationCell?.output?.lock ??
    signerAddress.script
  );
  const intentLock = denormalizeScript(refundLock);

  const intentData = encodeVoteIntentData({
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash),
    voter_lock_hash: voterLockHash,
    option_index: input.optionIndex,
    voted_at_epoch: epoch,
    aggregated: false,
    refund_lock: refundLock,
  });
  const intentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, input.pollTypeHash);
  const intentCapacity = estimateOutputCapacity(intentLock, intentType, intentData.length);
  const weightedIntentCapacity = voteWeightUnits * VOTER_DEPOSIT_SHANNONS;
  const maxWeightedIntentCapacity = MAX_WEIGHT_UNITS_PER_INTENT * VOTER_DEPOSIT_SHANNONS;
  let outputIntentCapacity = [intentCapacity, weightedIntentCapacity]
    .reduce((max, current) => (current > max ? current : max), 0n);

  if (pollData.token_weighted && outputIntentCapacity > maxWeightedIntentCapacity) {
    throw new Error(
      `Weighted intent occupied capacity exceeds cap (${maxWeightedIntentCapacity / SHANNONS_PER_CKB} CKB)`
    );
  }

  const tx = (ccc as any).Transaction.from({
    cellDeps: [
      buildGovernanceCellDep(),
      {
        outPoint: getOutPoint(input.pollCell),
        depType: "code",
      },
    ],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: getOutPoint(signerAuthCell) },
      ...(input.delegationCell ? [{ previousOutput: getOutPoint(input.delegationCell) }] : []),
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
  await tx.completeFeeBy(signer, 1000);
  return tx;
}

/**
 * @notice Builds a DELEGATE transaction.
 * @dev Creates a delegation cell scoped to all polls or one poll type hash.
 */
export async function buildDelegateTx(
  signer: any,
  input: { delegateLockHash: string; pollTypeHash?: string; expiresEpoch?: bigint }
): Promise<any> {
  const tipHeader = await signer.client.getTipHeader();
  const signerAddress = await getSignerAddressObj(signer);
  const delegatorLockHash = await getSignerLockHash(signer);
  const delegateLockHash = await resolveDelegateLockHash(signer, input.delegateLockHash);
  const delegationData = encodeDelegationData({
    delegator_lock_hash: delegatorLockHash,
    delegate_lock_hash: (ccc as any).bytesFrom(delegateLockHash),
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash ?? ZERO_HASH_HEX),
    expires_epoch: input.expiresEpoch ?? 0n,
  });
  const delegationType = buildGovernanceTypeScript(OP.DELEGATE, input.pollTypeHash ?? ZERO_HASH_HEX);
  const delegationCapacity = estimateOutputCapacity(signerAddress.script, delegationType, delegationData.length);

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    headerDeps: [tipHeader.hash],
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
  await tx.completeFeeBy(signer, 1000);
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

function generateRandomScopeHex(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return ccc.hexFrom(bytes);
}

async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await getSignerAddressObj(signer);
  let fallbackCell: any | null = null;

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

    fallbackCell = fallbackCell ?? cell;
  }

  if (fallbackCell) {
    return fallbackCell;
  }

  throw new Error("No signer auth cell available");
}

/**
 * @notice Builds an AGGREGATE_VOTES transaction.
 * @dev Consumes pending intents, marks them aggregated, and updates poll tallies.
 */
export async function buildAggregateVotesTx(
  signer: any,
  input: { pollCell: any; intentCells: any[] }
): Promise<any> {
  const tipHeader = await signer.client.getTipHeader();
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  const nextVoteCounts = [...previousPoll.vote_counts];

  const nextIntentOutputs = input.intentCells.map((cell) => {
    const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    if (bytesToHex(decoded.poll_type_hash).toLowerCase() !== pollTypeHash.toLowerCase()) {
      throw new Error("Intent cell does not belong to the selected poll");
    }
    const weight = computeIntentWeightUnits(getCellCapacity(cell), previousPoll.token_weighted);
    nextVoteCounts[decoded.option_index] += weight;
    return {
      decoded,
      output: {
        lock: getCellLock(cell),
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

  const appendedVoters = nextIntentOutputs.map((item) => item.decoded.voter_lock_hash);

  const updatedPoll = encodePollData({
    ...previousPoll,
    vote_counts: nextVoteCounts,
    total_voters: previousPoll.total_voters + BigInt(input.intentCells.length),
    pending_intent_count:
      previousPoll.pending_intent_count > BigInt(input.intentCells.length)
        ? previousPoll.pending_intent_count - BigInt(input.intentCells.length)
        : 0n,
    counted_voter_lock_hashes: [...previousPoll.counted_voter_lock_hashes, ...appendedVoters],
  });
  const updatedPollMinCapacity = estimateOutputCapacity(
    pollOutput.lock,
    pollOutput.type,
    updatedPoll.length
  );
  const updatedPollCandidateCapacity = getCellCapacity(input.pollCell) - AGGREGATE_FEE_RESERVE_SHANNONS;
  const updatedPollCapacity = updatedPollCandidateCapacity > updatedPollMinCapacity
    ? updatedPollCandidateCapacity
    : updatedPollMinCapacity;

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: pollOutput.lock,
        type: pollOutput.type,
        capacity: updatedPollCapacity,
      },
      ...nextIntentOutputs.map((item) => item.output),
    ],
    outputsData: [bytesToHex(updatedPoll), ...nextIntentOutputs.map((item) => item.data)],
    witnesses: new Array(input.intentCells.length + 1).fill("0x"),
  });

  return tx;
}

/**
 * @notice Builds creator-authorized CLOSE_POLL transaction.
 * @dev Returns creator deposit and refunds intent deposits through refund locks.
 */
export async function buildClosePollTx(
  signer: any,
  input: { pollCell: any; intentCells: any[] }
): Promise<any> {
  const client = signer.client;
  const tipHeader = await client.getTipHeader();
  const currentEpoch = await getTipEpoch(client);
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
  if (currentEpoch <= previousPoll.deadline) {
    throw new Error("Poll cannot be closed before deadline");
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

  const creatorAddress = await getSignerAddressObj(signer);
  const creatorAuthCell = await findSignerAuthCell(signer, [
    `${input.pollCell.outPoint.txHash}:${Number(input.pollCell.outPoint.index)}`,
    ...input.intentCells.map((cell) => `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`),
  ]);

  const closedPoll = encodePollData({
    ...previousPoll,
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

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      { previousOutput: getOutPoint(creatorAuthCell) },
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: pollOutput.lock,
        type: pollOutput.type,
        capacity: closedPollCapacity,
      },
      {
        lock: creatorAddress.script,
        capacity: previousPoll.creator_deposit,
      },
      ...voterReturns,
    ],
    outputsData: [
      bytesToHex(closedPoll),
      "0x",
      ...voterReturns.map(() => "0x"),
    ],
    witnesses: new Array(input.intentCells.length + 2).fill("0x"),
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  return tx;
}

/**
 * @notice Builds permissionless recovery CLOSE_POLL transaction after grace.
 * @dev Mirrors contract force-close mode by closing without creator auth input.
 */
export async function buildForceCloseTx(
  signer: any,
  input: { pollCell: any; intentCells: any[] }
): Promise<any> {
  const client = signer.client;
  const tipHeader = await client.getTipHeader();
  const currentEpoch = await getTipEpoch(client);
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const pollTypeHash = hashScript(pollOutput.type);
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

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    headerDeps: [tipHeader.hash],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: getCellLock(input.pollCell),
        type: pollOutput.type,
        capacity: closedPollCapacity,
      },
      {
        lock: getCellLock(input.pollCell),
        capacity: previousPoll.creator_deposit,
      },
      ...voterReturns,
    ],
    outputsData: [
      bytesToHex(closedPoll),
      "0x",
      ...voterReturns.map(() => "0x"),
    ],
    witnesses: new Array(input.intentCells.length + 1).fill("0x"),
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  return tx;
}

/**
 * @notice Builds a REVOKE_DELEGATION transaction.
 * @dev Consumes delegation cell and unlocks its occupied capacity back to delegator lock.
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

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
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
}): string | null {
  if (!input.question.trim()) return "Question is required";
  if (input.question.length > 256) return "Question exceeds 256 bytes";
  if (input.options.length < 2 || input.options.length > MAX_OPTIONS) return "Options must be between 2 and 10";
  if (input.options.some((option) => !option.trim() || option.length > 64)) return "Each option must be 1-64 bytes";
  if (BigInt(input.durationEpochs) < MIN_DURATION_EPOCHS || BigInt(input.durationEpochs) > MAX_DURATION_EPOCHS) {
    return "Duration must be between 1 and 1000 epochs";
  }
  return null;
}
