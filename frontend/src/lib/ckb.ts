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
  MAX_DURATION_EPOCHS,
  MAX_OPTIONS,
  MIN_DURATION_EPOCHS,
  OP,
  SHANNONS_PER_CKB,
  VOTER_DEPOSIT_SHANNONS,
  ZERO_HASH_HEX,
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
  MAX_OPTIONS,
  MIN_DURATION_EPOCHS,
  MAX_DURATION_EPOCHS,
  ZERO_HASH_HEX,
};

export function validateRuntimeConfig(): string | null {
  const isProduction = Boolean((import.meta as any).env?.PROD);

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

  return null;
}

export function shannonsToCkb(shannons: bigint): string {
  const whole = shannons / SHANNONS_PER_CKB;
  const fractional = shannons % SHANNONS_PER_CKB;
  return `${whole}.${fractional.toString().padStart(8, "0")}`;
}

export function estimateCellCapacity(dataBytes: number, extraScriptBytes = 61): bigint {
  return BigInt(dataBytes + extraScriptBytes) * SHANNONS_PER_CKB;
}

function encodeOpArgs(op: number, scopeHex = "0x"): string {
  return `0x${op.toString(16).padStart(2, "0")}${scopeHex.replace(/^0x/, "")}`;
}

export function buildGovernanceTypeScript(op: number, scopeHex = "0x"): any {
  return (ccc as any).Script.from({
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: SCRIPT_HASH_TYPE,
    args: encodeOpArgs(op, scopeHex),
  });
}

export function buildGovernanceCellDep(): any {
  return {
    outPoint: {
      txHash: GOVERNANCE_SCRIPT_TX_HASH,
      index: 0,
    },
    depType: "code",
  };
}

export function hashScript(script: any): string {
  const normalized = normalizeScript(script);
  const hashTypeByte =
    normalized.hash_type === "type" ? "01" : normalized.hash_type === "data1" ? "02" : "00";

  return `0x${hashTypeByte}${String(normalized.code_hash).replace(/^0x/, "")}${String(normalized.args).replace(/^0x/, "")}`
    .slice(0, 66)
    .padEnd(66, "0");
}

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

export async function getSignerLockHash(signer: any): Promise<Uint8Array> {
  const address = await getSignerAddressObj(signer);
  return (ccc as any).bytesFrom(hashScript(address.script));
}

export async function getSignerLockHashHex(signer: any): Promise<string> {
  return bytesToHex(await getSignerLockHash(signer));
}

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
  const capacity = CREATOR_DEPOSIT_SHANNONS + estimateCellCapacity(pollData.length);
  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    outputs: [
      {
        lock: signerAddress.script,
        type: buildGovernanceTypeScript(OP.CREATE_POLL),
        capacity,
      },
    ],
    outputsData: [bytesToHex(pollData)],
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  return tx;
}

export async function buildCreateVoteIntentTx(
  signer: any,
  input: {
    pollTypeHash: string;
    optionIndex: number;
    delegationCell?: any;
  }
): Promise<any> {
  const client = signer.client;
  const epoch = await getTipEpoch(client);
  const signerLockHash = await getSignerLockHash(signer);
  const voterLockHash = input.delegationCell
    ? decodeDelegationData((ccc as any).bytesFrom(input.delegationCell.outputData ?? "0x")).delegator_lock_hash
    : signerLockHash;
  const signerAddress = await getSignerAddressObj(signer);
  const signerAuthCell = await findSignerAuthCell(
    signer,
    input.delegationCell ? [`${input.delegationCell.outPoint.txHash}:${Number(input.delegationCell.outPoint.index)}`] : []
  );

  const intentData = encodeVoteIntentData({
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash),
    voter_lock_hash: voterLockHash,
    option_index: input.optionIndex,
    voted_at_epoch: epoch,
    aggregated: false,
    refund_lock: normalizeScript(
      input.delegationCell?.cellOutput?.lock ??
      input.delegationCell?.output?.lock ??
      signerAddress.script
    ),
  });

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [
      { previousOutput: getOutPoint(signerAuthCell) },
      ...(input.delegationCell ? [{ previousOutput: getOutPoint(input.delegationCell) }] : []),
    ],
    outputs: [
      {
        lock: signerAddress.script,
        type: buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, input.pollTypeHash),
        capacity: VOTER_DEPOSIT_SHANNONS,
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

export async function buildDelegateTx(
  signer: any,
  input: { delegateLockHash: string; pollTypeHash?: string; expiresEpoch?: bigint }
): Promise<any> {
  const signerAddress = await getSignerAddressObj(signer);
  const delegatorLockHash = await getSignerLockHash(signer);
  const delegationData = encodeDelegationData({
    delegator_lock_hash: delegatorLockHash,
    delegate_lock_hash: (ccc as any).bytesFrom(input.delegateLockHash),
    poll_type_hash: (ccc as any).bytesFrom(input.pollTypeHash ?? ZERO_HASH_HEX),
    expires_epoch: input.expiresEpoch ?? 0n,
  });

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    outputs: [
      {
        lock: signerAddress.script,
        type: buildGovernanceTypeScript(OP.DELEGATE, input.pollTypeHash ?? ZERO_HASH_HEX),
        capacity: DELEGATION_MIN_SHANNONS,
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

async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await getSignerAddressObj(signer);

  for await (const cell of signer.client.findCells({
    script: signerAddress.script,
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const outPointKey = `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`;
    if (!excludedOutPoints.includes(outPointKey)) {
      return cell;
    }
  }

  throw new Error("No signer auth cell available");
}

export async function buildAggregateVotesTx(
  signer: any,
  input: { pollCell: any; intentCells: any[] }
): Promise<any> {
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const nextVoteCounts = [...previousPoll.vote_counts];

  const nextIntentOutputs = input.intentCells.map((cell) => {
    const decoded = decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x"));
    nextVoteCounts[decoded.option_index] += 1n;
    return {
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

  const appendedVoters = input.intentCells.map((cell) =>
    decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x")).voter_lock_hash
  );

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

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
    inputs: [
      { previousOutput: getOutPoint(input.pollCell) },
      ...input.intentCells.map((cell) => ({ previousOutput: getOutPoint(cell) })),
    ],
    outputs: [
      {
        lock: pollOutput.lock,
        type: pollOutput.type,
        capacity: getCellCapacity(input.pollCell),
      },
      ...nextIntentOutputs.map((item) => item.output),
    ],
    outputsData: [bytesToHex(updatedPoll), ...nextIntentOutputs.map((item) => item.data)],
    witnesses: new Array(input.intentCells.length + 1).fill("0x"),
  });

  await tx.completeInputsByCapacity(signer);
  await tx.completeFeeBy(signer, 1000);
  return tx;
}

export async function buildClosePollTx(
  signer: any,
  input: { pollCell: any; intentCells: any[] }
): Promise<any> {
  const pollOutput = getCellOutput(input.pollCell);
  const previousPoll = decodePollData((ccc as any).bytesFrom(input.pollCell.outputData ?? "0x"));
  const creatorAddress = await getSignerAddressObj(signer);
  const creatorAuthCell = await findSignerAuthCell(signer, [
    `${input.pollCell.outPoint.txHash}:${Number(input.pollCell.outPoint.index)}`,
    ...input.intentCells.map((cell) => `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`),
  ]);

  const closedPoll = encodePollData({
    ...previousPoll,
    is_closed: true,
  });

  const closedPollCapacity = getCellCapacity(input.pollCell) - previousPoll.creator_deposit;

  const voterReturns = input.intentCells.map((cell) => ({
    lock: denormalizeScript(decodeVoteIntentData((ccc as any).bytesFrom(cell.outputData ?? "0x")).refund_lock),
    capacity: getCellCapacity(cell),
  }));

  const tx = (ccc as any).Transaction.from({
    cellDeps: [buildGovernanceCellDep()],
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

export async function signAndSendTx(signer: any, tx: any): Promise<string> {
  await signer.signTransaction(tx);
  return signer.client.sendTransaction(tx);
}

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
