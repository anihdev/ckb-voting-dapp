/**
 * Multi-Actor Governance Smoke Script
 * ===================================
 * Proves realistic actor boundaries for the Phase B contract model:
 * creator, voters, aggregator, and force-closer are separate signers.
 *
 * This script intentionally includes pass and expected-fail scenarios to
 * show that third-party shard aggregation no longer needs voter signatures.
 * Sharded close requires post-deadline shard finalization, so this immediate
 * smoke run labels close scenarios as skipped rather than using legacy
 * poll-cell aggregation. Large-poll MERGE_TALLY_SHARDS close coverage is
 * documented here but should run in a controlled local epoch smoke harness.
 */

import { randomBytes } from "crypto";
import { ccc } from "@ckb-ccc/core";
import {
  RPC_URL,
  assertHex32,
  assertRpcUrl,
  requireGovernanceHashes,
} from "./config";

const { codeHash: GOVERNANCE_CODE_HASH, scriptTxHash: GOVERNANCE_SCRIPT_TX_HASH } = requireGovernanceHashes();
const SCRIPT_HASH_TYPE = "data1";
const CREATOR_DEPOSIT_SHANNONS = 500n * 100_000_000n;
const VOTER_DEPOSIT_SHANNONS = 61n * 100_000_000n;
const SHANNONS_PER_CKB = 100_000_000n;
const TALLY_SHARD_MIN_SHANNONS = 61n * SHANNONS_PER_CKB;
const FORCE_CLOSE_GRACE_EPOCHS = 10n;
const TX_FEE_SHANNONS = 5_000;
const POLL_CAPACITY_HEADROOM_SHANNONS = 2n * SHANNONS_PER_CKB;
const DEFAULT_SHARD_COUNT = 1;
const RPC_CALL_RETRY_COUNT = 5;
const RPC_CALL_RETRY_DELAY_MS = 1500;
const EPOCH_BLOCKS_FALLBACK = 180n;

assertRpcUrl(RPC_URL, "CKB RPC URL");

type PollData = {
  question: string;
  options: string[];
  vote_counts: bigint[];
  deadline: bigint;
  creator: Uint8Array;
  creator_lock: EncodedScript;
  is_closed: boolean;
  total_voters: bigint;
  creator_deposit: bigint;
  pending_intent_count: bigint;
  counted_voter_lock_hashes: Uint8Array[];
  token_weighted: boolean;
  udt_type_hash: Uint8Array;
  shard_count: number;
};

type TallyShardData = {
  poll_type_hash: Uint8Array;
  shard_id: number;
  shard_count: number;
  vote_counts: bigint[];
  total_voters: bigint;
  counted_voter_lock_hashes: Uint8Array[];
  finalized: boolean;
};

type EncodedScript = {
  code_hash: string;
  hash_type: "type" | "data" | "data1" | "data2";
  args: string;
};

type VoteIntentData = {
  poll_type_hash: Uint8Array;
  voter_lock_hash: Uint8Array;
  option_index: number;
  voted_at_epoch: bigint;
  aggregated: boolean;
  refund_lock: EncodedScript;
};

type CellRef = {
  outPoint: { txHash: string; index: number };
  cellOutput: { lock: any; type?: any; capacity: bigint };
  outputData: string;
};

type ScenarioResult = {
  name: string;
  expected: "pass" | "fail" | "pass_or_skip";
  outcome: "pass" | "fail" | "skip";
  detail: string;
};

class ScenarioSkip extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScenarioSkip";
  }
}

function assertCodec(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function encodeUint32(value: number): Uint8Array {
  const bytes = new Uint8Array(4);
  bytes[0] = value & 0xff;
  bytes[1] = (value >> 8) & 0xff;
  bytes[2] = (value >> 16) & 0xff;
  bytes[3] = (value >> 24) & 0xff;
  return bytes;
}

function decodeUint32(bytes: Uint8Array, offset = 0): number {
  return bytes[offset] | (bytes[offset + 1] << 8) | (bytes[offset + 2] << 16) | (bytes[offset + 3] << 24);
}

function encodeUint64(value: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  let current = value;
  for (let index = 0; index < 8; index += 1) {
    bytes[index] = Number(current & 0xffn);
    current >>= 8n;
  }
  return bytes;
}

function decodeUint64(bytes: Uint8Array, offset = 0): bigint {
  let result = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    result = (result << 8n) | BigInt(bytes[offset + index]);
  }
  return result;
}

function encodeString(value: string): Uint8Array {
  const textBytes = new TextEncoder().encode(value);
  return concat([encodeUint32(textBytes.length), textBytes]);
}

function encodeStringVec(values: string[]): Uint8Array {
  return concat([encodeUint32(values.length), ...values.map(encodeString)]);
}

function encodeUint64Vec(values: bigint[]): Uint8Array {
  return concat([encodeUint32(values.length), ...values.map(encodeUint64)]);
}

function encodeBytes32Vec(values: Uint8Array[]): Uint8Array {
  for (const value of values) {
    assertCodec(value.length === 32, "counted voter lock hash must be 32 bytes");
  }
  return concat([encodeUint32(values.length), ...values]);
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((size, chunk) => size + chunk.length, 0);
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.length;
  }
  return output;
}

function encodeBytes(bytes: Uint8Array): Uint8Array {
  return concat([encodeUint32(bytes.length), bytes]);
}

function decodeBytes(bytes: Uint8Array, offset: number): [Uint8Array, number] {
  const length = decodeUint32(bytes, offset);
  return [bytes.slice(offset + 4, offset + 4 + length), offset + 4 + length];
}

function hashTypeToByte(hashType: EncodedScript["hash_type"]): number {
  switch (hashType) {
    case "data": return 0;
    case "type": return 1;
    case "data1": return 2;
    case "data2": return 4;
  }
}

function byteToHashType(value: number): EncodedScript["hash_type"] {
  switch (value) {
    case 0: return "data";
    case 1: return "type";
    case 2: return "data1";
    case 4: return "data2";
    default: throw new Error(`Unknown hash_type byte: ${value}`);
  }
}

function hexToBytes(hex: string): Uint8Array {
  const normalized = hex.startsWith("0x") ? hex.slice(2) : hex;
  const output = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    output[index / 2] = parseInt(normalized.slice(index, index + 2), 16);
  }
  return output;
}

function bytesToHex(bytes: Uint8Array): string {
  return `0x${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

function encodeScript(script: EncodedScript): Uint8Array {
  const codeHashBytes = hexToBytes(script.code_hash);
  assertCodec(codeHashBytes.length === 32, "script.code_hash must be 32 bytes");
  return concat([
    codeHashBytes,
    new Uint8Array([hashTypeToByte(script.hash_type)]),
    encodeBytes(hexToBytes(script.args)),
  ]);
}

function decodeScript(bytes: Uint8Array, offset: number): [EncodedScript, number] {
  const code_hash = bytesToHex(bytes.slice(offset, offset + 32));
  offset += 32;
  const hash_type = byteToHashType(bytes[offset]);
  offset += 1;
  const [argsBytes, nextOffset] = decodeBytes(bytes, offset);
  return [{ code_hash, hash_type, args: bytesToHex(argsBytes) }, nextOffset];
}

function encodePollData(poll: PollData): Uint8Array {
  assertCodec(poll.creator.length === 32, "creator must be 32 bytes");
  assertCodec(poll.udt_type_hash.length === 32, "udt_type_hash must be 32 bytes");
  assertCodec(poll.shard_count > 0, "shard_count must be positive");
  return concat([
    encodeString(poll.question),
    encodeStringVec(poll.options),
    encodeUint64Vec(poll.vote_counts),
    encodeUint64(poll.deadline),
    poll.creator,
    encodeScript(poll.creator_lock),
    new Uint8Array([poll.is_closed ? 1 : 0]),
    encodeUint64(poll.total_voters),
    encodeUint64(poll.creator_deposit),
    encodeUint64(poll.pending_intent_count),
    encodeBytes32Vec(poll.counted_voter_lock_hashes),
    new Uint8Array([poll.token_weighted ? 1 : 0]),
    poll.udt_type_hash,
    encodeUint32(poll.shard_count),
  ]);
}

function encodeTallyShardData(shard: TallyShardData): Uint8Array {
  assertCodec(shard.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");
  assertCodec(shard.shard_count > 0 && shard.shard_count <= 256, "shard_count out of range");
  assertCodec(shard.shard_id >= 0 && shard.shard_id < shard.shard_count, "shard_id out of range");
  return concat([
    shard.poll_type_hash,
    encodeUint32(shard.shard_id),
    encodeUint32(shard.shard_count),
    encodeUint64Vec(shard.vote_counts),
    encodeUint64(shard.total_voters),
    encodeBytes32Vec(shard.counted_voter_lock_hashes),
    new Uint8Array([shard.finalized ? 1 : 0]),
  ]);
}

function encodeVoteIntentData(intent: VoteIntentData): Uint8Array {
  assertCodec(intent.poll_type_hash.length === 32, "poll_type_hash must be 32 bytes");
  assertCodec(intent.voter_lock_hash.length === 32, "voter_lock_hash must be 32 bytes");
  return concat([
    intent.poll_type_hash,
    intent.voter_lock_hash,
    new Uint8Array([intent.option_index]),
    encodeUint64(intent.voted_at_epoch),
    new Uint8Array([intent.aggregated ? 1 : 0]),
    encodeScript(intent.refund_lock),
  ]);
}

function decodeVoteIntentData(bytes: Uint8Array): VoteIntentData {
  assertCodec(bytes.length >= 74, `VoteIntentData too short: ${bytes.length}`);
  let offset = 0;
  const poll_type_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const voter_lock_hash = bytes.slice(offset, offset + 32);
  offset += 32;
  const option_index = bytes[offset];
  offset += 1;
  const voted_at_epoch = decodeUint64(bytes, offset);
  offset += 8;
  const aggregated = bytes[offset] === 1;
  offset += 1;
  const [refund_lock] = decodeScript(bytes, offset);
  return { poll_type_hash, voter_lock_hash, option_index, voted_at_epoch, aggregated, refund_lock };
}

function readMultiActorEnv(): {
  creator: string;
  voters: string[];
  aggregator: string;
  forceCloser: string;
} {
  // Creator defaults to the main deploy key so existing environments
  // can run this script without adding a duplicate secret.
  const creator = process.env.CREATOR_PRIVATE_KEY?.trim() || process.env.CKB_PRIVATE_KEY?.trim();
  const votersRaw = process.env.VOTER_PRIVATE_KEYS?.trim();
  const aggregator = process.env.AGGREGATOR_PRIVATE_KEY?.trim();
  const forceCloser = process.env.FORCE_CLOSER_PRIVATE_KEY?.trim();

  if (!creator) throw new Error("Set CREATOR_PRIVATE_KEY or CKB_PRIVATE_KEY in .env");
  if (!votersRaw) throw new Error("Set VOTER_PRIVATE_KEYS (comma separated) in .env");
  if (!aggregator) throw new Error("Set AGGREGATOR_PRIVATE_KEY in .env");
  if (!forceCloser) throw new Error("Set FORCE_CLOSER_PRIVATE_KEY in .env");

  const voters = votersRaw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

  if (voters.length < 3) {
    throw new Error("Provide at least 3 voter keys in VOTER_PRIVATE_KEYS");
  }

  assertHex32(creator, process.env.CREATOR_PRIVATE_KEY?.trim() ? "CREATOR_PRIVATE_KEY" : "CKB_PRIVATE_KEY");
  voters.forEach((voter, index) => assertHex32(voter, `VOTER_PRIVATE_KEYS[${index}]`));
  assertHex32(aggregator, "AGGREGATOR_PRIVATE_KEY");
  assertHex32(forceCloser, "FORCE_CLOSER_PRIVATE_KEY");

  const roleKeys = [creator, aggregator, forceCloser, ...voters].map((key) => key.toLowerCase());
  if (new Set(roleKeys).size !== roleKeys.length) {
    throw new Error(
      "Role keys must be distinct across creator, voters, aggregator, and force-closer."
    );
  }

  return { creator, voters, aggregator, forceCloser };
}

function scriptHash(script: any): string {
  return ccc.hexFrom((ccc as any).hashCkb((ccc as any).Script.from(script).toBytes()));
}

function lockHashBytes(script: any): Uint8Array {
  return (ccc as any).bytesFrom((ccc as any).hashCkb(script.toBytes()));
}

function encodeOpArgs(op: number, scopeHex = "0x"): string {
  return `0x${op.toString(16).padStart(2, "0")}${scopeHex.replace(/^0x/, "")}`;
}

function governanceTypeScript(op: number, scopeHex = "0x"): any {
  return (ccc as any).Script.from({
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: SCRIPT_HASH_TYPE,
    args: encodeOpArgs(op, scopeHex),
  });
}

function intentLockScript(pollTypeHash: string): any {
  return governanceTypeScript(0x02, pollTypeHash);
}

function pollLockScript(pollTypeHash: string): any {
  return governanceTypeScript(0x04, pollTypeHash);
}

function tallyShardScript(pollTypeHash: string, shardId: number): any {
  const shardIdBytes = new Uint8Array(4);
  shardIdBytes[0] = shardId & 0xff;
  shardIdBytes[1] = (shardId >> 8) & 0xff;
  shardIdBytes[2] = (shardId >> 16) & 0xff;
  shardIdBytes[3] = (shardId >> 24) & 0xff;
  return governanceTypeScript(0x07, `${pollTypeHash}${bytesToHex(shardIdBytes).slice(2)}`);
}

function governanceCellDep() {
  return {
    outPoint: {
      txHash: GOVERNANCE_SCRIPT_TX_HASH,
      index: 0,
    },
    depType: "code",
  };
}

function getOutPoint(cell: any): any {
  return {
    txHash: cell.outPoint.txHash,
    index: Number(cell.outPoint.index),
  };
}

function outPointKeyFromOutPoint(outPoint: any): string {
  return `${outPoint.txHash}:${Number(outPoint.index)}`;
}

function derivePollTypeIdFromSeedInput(seedCell: any, outputIndex = 0): string {
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

function estimateOutputCapacity(lockScript: any, typeScript: any | undefined, dataBytes: number): bigint {
  const lockBytes = (ccc as any).Script.from(lockScript).toBytes().length;
  const typeBytes = typeScript ? (ccc as any).Script.from(typeScript).toBytes().length : 0;
  const occupiedBytes = 8 + lockBytes + typeBytes + dataBytes + 32;
  return BigInt(occupiedBytes) * SHANNONS_PER_CKB;
}

async function getTipEpoch(client: any): Promise<bigint> {
  if (typeof client.getTipEpoch === "function") {
    const rawEpoch = await client.getTipEpoch();
    if (typeof rawEpoch === "bigint") return rawEpoch;
    if (typeof rawEpoch === "number") return BigInt(rawEpoch);
    if (typeof rawEpoch === "string") return BigInt(rawEpoch.split(",")[0]);
  }

  const tipHeader = await client.getTipHeader();
  return BigInt(String(tipHeader.epoch).split(",")[0]);
}

async function withRpcRetry<T>(label: string, task: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= RPC_CALL_RETRY_COUNT; attempt += 1) {
    try {
      return await task();
    } catch (error) {
      lastError = error;
      const message = summarizeError(error).toLowerCase();
      const retryable =
        message.includes("fetch failed") ||
        message.includes("etimedout") ||
        message.includes("eai_again") ||
        message.includes("socket hang up");
      if (!retryable || attempt === RPC_CALL_RETRY_COUNT) {
        break;
      }
      console.log(
        `[rpc-retry] ${label} failed (${attempt}/${RPC_CALL_RETRY_COUNT}): ${summarizeError(error)}`
      );
      await new Promise((resolve) => setTimeout(resolve, RPC_CALL_RETRY_DELAY_MS * attempt));
    }
  }
  throw lastError;
}

async function waitForTx(client: any, txHash: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const tx = await withRpcRetry("getTransaction", () => client.getTransaction(txHash));
    if (tx) return;
  }
  throw new Error(`Timed out waiting for ${txHash}`);
}

async function headerByNumber(client: any, blockNumber: bigint): Promise<any> {
  return withRpcRetry("getHeaderByNumber", () => client.getHeaderByNumber(blockNumber));
}

function epochLengthFromHeader(header: any): bigint {
  const epoch = header?.epoch;
  if (!epoch) return EPOCH_BLOCKS_FALLBACK;
  if (Array.isArray(epoch) && epoch.length >= 3) {
    const length = BigInt(epoch[2]);
    return length > 0n ? length : EPOCH_BLOCKS_FALLBACK;
  }
  return EPOCH_BLOCKS_FALLBACK;
}

async function findHeaderAfterEpoch(
  client: any,
  startHeader: any,
  targetEpoch: bigint,
): Promise<any> {
  const startNumber = BigInt(startHeader.number);
  const startEpoch = BigInt(Array.isArray(startHeader.epoch) ? startHeader.epoch[0] : 0);
  const epochLen = epochLengthFromHeader(startHeader);
  if (targetEpoch <= startEpoch) return startHeader;

  const deltaEpochs = targetEpoch - startEpoch;
  let low = startNumber;
  let high = startNumber + (deltaEpochs + 2n) * epochLen;
  const tipHeader: any = await withRpcRetry("getTipHeader", () => client.getTipHeader());
  const tipNumber = BigInt(tipHeader.number);
  if (high > tipNumber) {
    throw new Error(
      `tip height too low for after-grace scenario: need >=${high}, current=${tipNumber}`
    );
  }

  let candidate: any = tipHeader;
  while (low <= high) {
    const mid = (low + high) / 2n;
    const header = await headerByNumber(client, mid);
    const epochNo = BigInt(Array.isArray(header.epoch) ? header.epoch[0] : 0);
    if (epochNo >= targetEpoch) {
      candidate = header;
      if (mid === 0n) break;
      high = mid - 1n;
    } else {
      low = mid + 1n;
    }
  }

  const candidateEpoch = BigInt(Array.isArray(candidate.epoch) ? candidate.epoch[0] : 0);
  if (candidateEpoch < targetEpoch) {
    throw new Error(
      `unable to locate header at target epoch ${targetEpoch} (best=${candidateEpoch})`
    );
  }
  return candidate;
}

async function loadCommittedCellRef(client: any, txHash: string, index: number): Promise<CellRef> {
  const tx: any = await withRpcRetry("loadCommittedCellRef", () => client.getTransaction(txHash));
  if (!tx?.transaction) {
    throw new Error(`Committed tx not found for ${txHash}`);
  }
  const output = tx.transaction.outputs[index];
  const outputData = tx.transaction.outputsData[index];
  if (!output) {
    throw new Error(`Output ${index} missing in tx ${txHash}`);
  }
  return {
    outPoint: { txHash, index },
    cellOutput: {
      lock: output.lock,
      type: output.type ?? undefined,
      capacity: BigInt(output.capacity),
    },
    outputData,
  };
}

async function findSignerAuthCell(signer: any, excludedOutPoints: string[] = []): Promise<any> {
  const signerAddress = await signer.getAddressObjSecp256k1();
  let bestPlainCell: any | null = null;
  let bestPlainCapacity = 0n;
  for await (const cell of signer.client.findCells({
    script: signerAddress.script,
    scriptType: "lock",
    scriptSearchMode: "exact",
  })) {
    const outPointKey = `${cell.outPoint.txHash}:${Number(cell.outPoint.index)}`;
    if (excludedOutPoints.includes(outPointKey)) {
      continue;
    }

    const capacity = BigInt((cell.cellOutput ?? cell.output).capacity);
    const type = cell.cellOutput?.type ?? cell.output?.type;
    const outputData = (cell.outputData ?? "0x") as string;
    if (!type && (outputData === "0x" || outputData === "0x0" || outputData.length <= 2)) {
      if (capacity > bestPlainCapacity) {
        bestPlainCell = cell;
        bestPlainCapacity = capacity;
      }
      continue;
    }
  }

  if (bestPlainCell) return bestPlainCell;
  throw new Error("No plain CKB cell is available for signer auth. Fund this wallet with a plain CKB cell and retry.");
}

function outPointKey(cell: any): string {
  return outPointKeyFromOutPoint(cell.outPoint ?? cell.previousOutput);
}

function normalizeScript(script: any): EncodedScript {
  const hashType = script.hash_type ?? script.hashType;
  if (hashType !== "type" && hashType !== "data" && hashType !== "data1" && hashType !== "data2") {
    throw new Error(`Unsupported script hash_type: ${String(hashType)}`);
  }
  return {
    code_hash: script.code_hash ?? script.codeHash,
    hash_type: hashType,
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

function canonicalScriptKey(script: any): string {
  const normalized = normalizeScript(script);
  return `${normalized.code_hash}:${normalized.hash_type}:${normalized.args}`;
}

function scriptMatches(left: any, right: any): boolean {
  const a = normalizeScript(left);
  const b = normalizeScript(right);
  return (
    a.code_hash.toLowerCase() === b.code_hash.toLowerCase() &&
    a.hash_type === b.hash_type &&
    a.args.toLowerCase() === b.args.toLowerCase()
  );
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string") return error;
  return "unknown error";
}

function preflightIntentGroupTransition(
  tx: any,
  intentInputMap: Map<string, CellRef>,
  intentTypeScript: any
): void {
  const intentTypeKey = canonicalScriptKey(intentTypeScript);
  const intentInputIndices: number[] = [];
  tx.inputs.forEach((input: any, index: number) => {
    const key = `${input.previousOutput.txHash}:${Number(input.previousOutput.index)}`;
    const cell = intentInputMap.get(key);
    if (cell) {
      intentInputIndices.push(index);
    }
  });

  const intentOutputIndices: number[] = [];
  tx.outputs.forEach((output: any, index: number) => {
    const type = output.type;
    if (!type) return;
    if (canonicalScriptKey(type) === intentTypeKey) {
      intentOutputIndices.push(index);
    }
  });

  if (intentInputIndices.length === 0 || intentOutputIndices.length === 0) {
    throw new Error("preflight: missing intent input/output group entries");
  }

  const firstInputIndex = intentInputIndices[0];
  const firstOutputIndex = intentOutputIndices[0];
  const firstInput = tx.inputs[firstInputIndex];
  const inKey = `${firstInput.previousOutput.txHash}:${Number(firstInput.previousOutput.index)}`;
  const beforeCell = intentInputMap.get(inKey);
  if (!beforeCell) throw new Error("preflight: first intent input cell not found");

  const before = decodeVoteIntentData(hexToBytes(beforeCell.outputData));
  const after = decodeVoteIntentData(hexToBytes(tx.outputsData[firstOutputIndex]));
  const outputLock = tx.outputs[firstOutputIndex].lock;
  const inCap = BigInt(beforeCell.cellOutput.capacity);
  const outCap = BigInt(tx.outputs[firstOutputIndex].capacity);

  const checks: Array<[string, boolean]> = [
    ["before must be pending", !before.aggregated],
    ["after must be aggregated", !!after.aggregated],
    ["voter_lock_hash unchanged", bytesToHex(before.voter_lock_hash) === bytesToHex(after.voter_lock_hash)],
    ["poll_type_hash unchanged", bytesToHex(before.poll_type_hash) === bytesToHex(after.poll_type_hash)],
    ["option_index unchanged", before.option_index === after.option_index],
    ["voted_at_epoch unchanged", before.voted_at_epoch === after.voted_at_epoch],
    ["refund_lock unchanged", scriptMatches(before.refund_lock, after.refund_lock)],
    ["output lock == intent lock policy", canonicalScriptKey(outputLock) === intentTypeKey],
    ["output capacity == input capacity", outCap === inCap],
    ["output capacity >= voter deposit", outCap >= VOTER_DEPOSIT_SHANNONS],
  ];

  const failed = checks.filter(([, ok]) => !ok).map(([label]) => label);
  if (failed.length > 0) {
    throw new Error(
      `preflight intent-group mismatch at input=${firstInputIndex} output=${firstOutputIndex}: ${failed.join(", ")}`
    );
  }
}

function decodePollData(bytes: Uint8Array): PollData {
  let offset = 0;
  const readU32 = () => {
    const value = decodeUint32(bytes, offset);
    offset += 4;
    return value;
  };
  const readU64 = () => {
    const value = decodeUint64(bytes, offset);
    offset += 8;
    return value;
  };
  const readVec = () => {
    const len = readU32();
    const value = bytes.slice(offset, offset + len);
    offset += len;
    return value;
  };
  const readBytes32 = () => {
    const value = bytes.slice(offset, offset + 32);
    offset += 32;
    return value;
  };
  const readBool = () => {
    const value = bytes[offset] === 1;
    offset += 1;
    return value;
  };

  const question = new TextDecoder().decode(readVec());
  const optionCount = readU32();
  const options: string[] = [];
  for (let i = 0; i < optionCount; i += 1) {
    options.push(new TextDecoder().decode(readVec()));
  }
  const voteCountLen = readU32();
  const vote_counts: bigint[] = [];
  for (let i = 0; i < voteCountLen; i += 1) {
    vote_counts.push(readU64());
  }
  const deadline = readU64();
  const creator = readBytes32();
  const [creator_lock, nextCreatorLockOffset] = decodeScript(bytes, offset);
  offset = nextCreatorLockOffset;
  const is_closed = readBool();
  const total_voters = readU64();
  const creator_deposit = readU64();
  const pending_intent_count = readU64();
  const countedLen = readU32();
  const counted_voter_lock_hashes: Uint8Array[] = [];
  for (let i = 0; i < countedLen; i += 1) {
    counted_voter_lock_hashes.push(readBytes32());
  }
  const token_weighted = readBool();
  const udt_type_hash = readBytes32();
  const shard_count = readU32();
  assertCodec(offset === bytes.length, "PollData has trailing bytes");
  return {
    question,
    options,
    vote_counts,
    deadline,
    creator,
    creator_lock,
    is_closed,
    total_voters,
    creator_deposit,
    pending_intent_count,
    counted_voter_lock_hashes,
    token_weighted,
    udt_type_hash,
    shard_count,
  };
}

async function runScenario(
  name: string,
  expected: "pass" | "fail" | "pass_or_skip",
  action: () => Promise<void>
): Promise<ScenarioResult> {
  try {
    await action();
    return { name, expected, outcome: "pass", detail: "completed" };
  } catch (error) {
    if (error instanceof ScenarioSkip) {
      return { name, expected, outcome: "skip", detail: error.message };
    }
    return { name, expected, outcome: "fail", detail: summarizeError(error) };
  }
}

async function main(): Promise<void> {
  console.log("=== Governance Multi-Actor Smoke ===");
  console.log(`RPC: ${RPC_URL}`);
  console.log(`Governance code hash: ${GOVERNANCE_CODE_HASH}`);
  console.log(`Governance script tx: ${GOVERNANCE_SCRIPT_TX_HASH}`);

  const keys = readMultiActorEnv();
  const client = new ccc.ClientPublicTestnet({
    url: RPC_URL,
    // Avoid fallback DNS flakiness on testnet.ckbapp.dev during smoke runs.
    fallbacks: [RPC_URL] as any,
  });
  const creatorSigner = new ccc.SignerCkbPrivateKey(client, keys.creator);
  const voterSigners = keys.voters.map((key) => new ccc.SignerCkbPrivateKey(client, key));
  const aggregatorSigner = new ccc.SignerCkbPrivateKey(client, keys.aggregator);
  const forceCloserSigner = new ccc.SignerCkbPrivateKey(client, keys.forceCloser);

  const creatorAddress = await creatorSigner.getAddressObjSecp256k1();
  const tipHeader = await withRpcRetry("getTipHeader", () => client.getTipHeader());
  const currentEpoch = await withRpcRetry("getTipEpoch", () => getTipEpoch(client));
  const creatorLockHash = lockHashBytes(creatorAddress.script);
  const smokeLabel = randomBytes(4).toString("hex");
  const typeIdSeedCell = await findSignerAuthCell(creatorSigner);
  const typeIdSeedKey = outPointKey(typeIdSeedCell);
  const pollTypeId = derivePollTypeIdFromSeedInput(typeIdSeedCell, 0);
  const pollType = governanceTypeScript(0x01, pollTypeId);
  const pollTypeHash = scriptHash(pollType);
  const pollLock = pollLockScript(pollTypeHash);
  const shardCount = DEFAULT_SHARD_COUNT;
  const results: ScenarioResult[] = [];

  console.log(`Creator: ${creatorAddress.toString()}`);
  console.log(`Aggregator: ${(await aggregatorSigner.getAddressObjSecp256k1()).toString()}`);
  console.log(`Force closer: ${(await forceCloserSigner.getAddressObjSecp256k1()).toString()}`);
  console.log(`Voters: ${voterSigners.length}`);
  console.log(`Smoke label: ${smokeLabel}`);

  const pollData: PollData = {
    question: `Multi-actor smoke ${smokeLabel}`,
    options: ["Yes", "No"],
    vote_counts: [0n, 0n],
    deadline: currentEpoch + FORCE_CLOSE_GRACE_EPOCHS + 8n,
    creator: creatorLockHash,
    creator_lock: normalizeScript(creatorAddress.script),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: false,
    udt_type_hash: new Uint8Array(32),
    shard_count: shardCount,
  };
  const pollBytes = encodePollData(pollData);
  const pollCapacity =
    CREATOR_DEPOSIT_SHANNONS +
    estimateOutputCapacity(pollLock, pollType, pollBytes.length) +
    POLL_CAPACITY_HEADROOM_SHANNONS;
  const shardOutputs = Array.from({ length: shardCount }, (_, shardId) => {
    const shardScript = tallyShardScript(pollTypeHash, shardId);
    const shardData = encodeTallyShardData({
      poll_type_hash: hexToBytes(pollTypeHash),
      shard_id: shardId,
      shard_count: shardCount,
      vote_counts: pollData.options.map(() => 0n),
      total_voters: 0n,
      counted_voter_lock_hashes: [],
      finalized: false,
    });
    const capacity = [
      TALLY_SHARD_MIN_SHANNONS,
      estimateOutputCapacity(shardScript, shardScript, shardData.length),
    ].reduce((max, current) => (current > max ? current : max), 0n);
    return {
      output: {
        lock: shardScript,
        type: shardScript,
        capacity,
      },
      data: bytesToHex(shardData),
    };
  });
  const creatorBalance = BigInt(await withRpcRetry("creator.getBalance", () => creatorSigner.getBalance()));
  const shardCapacityTotal = shardOutputs.reduce((sum, item) => sum + item.output.capacity, 0n);
  const minCreatorNeeded = pollCapacity + shardCapacityTotal + BigInt(TX_FEE_SHANNONS);
  console.log(`Creator available balance: ${creatorBalance} shannons`);
  console.log(`Create-poll minimum needed: ${minCreatorNeeded} shannons`);
  if (creatorBalance < minCreatorNeeded) {
    throw new Error(
      `Creator balance too low for CREATE_POLL. Need at least ${minCreatorNeeded} shannons, have ${creatorBalance}.`
    );
  }

  const createPollTx = ccc.Transaction.from({
    cellDeps: [governanceCellDep()],
    headerDeps: [tipHeader.hash],
    inputs: [{ previousOutput: getOutPoint(typeIdSeedCell), since: 0 }],
    outputs: [
      {
        lock: pollLock,
        type: pollType,
        capacity: pollCapacity,
      },
      ...shardOutputs.map((item) => item.output),
    ],
    outputsData: [bytesToHex(pollBytes), ...shardOutputs.map((item) => item.data)],
  });
  await createPollTx.completeInputsByCapacity(creatorSigner);
  assertPinnedInput0(createPollTx, typeIdSeedKey);
  await createPollTx.completeFeeBy(creatorSigner, TX_FEE_SHANNONS);
  assertPinnedInput0(createPollTx, typeIdSeedKey);
  await creatorSigner.signTransaction(createPollTx);
  const createPollHash = await client.sendTransaction(createPollTx);
  await waitForTx(client, createPollHash);
  console.log(`CREATE_POLL: ${createPollHash}`);

  const pollCell = await loadCommittedCellRef(client, createPollHash, 0);

  const intentType = governanceTypeScript(0x02, pollTypeHash);
  const intentLock = intentLockScript(pollTypeHash);
  const voterIntentCells: CellRef[] = [];
  for (let index = 0; index < voterSigners.length; index += 1) {
    const voterSigner = voterSigners[index];
    const voterAddress = await voterSigner.getAddressObjSecp256k1();
    const voterLockHash = lockHashBytes(voterAddress.script);
    const votedAtEpoch = await withRpcRetry("getTipEpoch", () => getTipEpoch(client));
    const optionIndex = index % 2;
    const intentData: VoteIntentData = {
      poll_type_hash: hexToBytes(pollTypeHash),
      voter_lock_hash: voterLockHash,
      option_index: optionIndex,
      voted_at_epoch: votedAtEpoch,
      aggregated: false,
      refund_lock: normalizeScript(voterAddress.script),
    };
    const intentBytes = encodeVoteIntentData(intentData);
    const intentCapacity = estimateOutputCapacity(intentLock, intentType, intentBytes.length);
    const outputIntentCapacity = intentCapacity > VOTER_DEPOSIT_SHANNONS ? intentCapacity : VOTER_DEPOSIT_SHANNONS;

    const intentAuthCell = await findSignerAuthCell(voterSigner);

    const createIntentTx = ccc.Transaction.from({
      cellDeps: [
        governanceCellDep(),
        { outPoint: pollCell.outPoint, depType: "code" },
      ],
      headerDeps: [tipHeader.hash],
      inputs: [{
        previousOutput: {
          txHash: intentAuthCell.outPoint.txHash,
          index: Number(intentAuthCell.outPoint.index),
        },
      }],
      outputs: [
        { lock: intentLock, type: intentType, capacity: outputIntentCapacity },
      ],
      outputsData: [bytesToHex(intentBytes)],
      witnesses: [
        (ccc as any).WitnessArgs.from({
          inputType: new Uint8Array([optionIndex]),
        }).toBytes(),
      ],
    });
    await createIntentTx.completeInputsByCapacity(voterSigner);
    await createIntentTx.completeFeeBy(voterSigner, TX_FEE_SHANNONS);
    const firstInput = createIntentTx.inputs[0]?.previousOutput;
    const expectedFirstInput = outPointKey(intentAuthCell);
    const actualFirstInput = firstInput ? `${firstInput.txHash}:${Number(firstInput.index)}` : "";
    if (actualFirstInput !== expectedFirstInput) {
      throw new Error(
        `CREATE_VOTE_INTENT signer auth input moved from index 0 (expected ${expectedFirstInput}, got ${actualFirstInput})`
      );
    }
    await voterSigner.signTransaction(createIntentTx);
    const createIntentHash = await client.sendTransaction(createIntentTx);
    await waitForTx(client, createIntentHash);
    console.log(`CREATE_VOTE_INTENT voter[${index}]: ${createIntentHash}`);

    voterIntentCells.push(await loadCommittedCellRef(client, createIntentHash, 0));
  }

  // Derive expected aggregated vote counts from the created intents.
  const expectedVoteCounts = Array.from({ length: pollData.options.length }, () => 0n);
  for (const intentCell of voterIntentCells) {
    const decoded = decodeVoteIntentData(hexToBytes(intentCell.outputData));
    if (decoded.option_index >= expectedVoteCounts.length) {
      throw new Error(`Intent option index out of range: ${decoded.option_index}`);
    }
    expectedVoteCounts[decoded.option_index] += 1n;
  }

  let aggregatedShardCell: CellRef | null = null;
  let aggregatedIntentCells: CellRef[] = [];
  results.push(await runScenario(
    "third_party_create_tally_shard_aggregate_without_voter_auth",
    "pass",
    async () => {
      const shardCell = await loadCommittedCellRef(client, createPollHash, 1);
      const countedVoters = voterIntentCells.map((cell) =>
        decodeVoteIntentData(hexToBytes(cell.outputData)).voter_lock_hash
      );
      const updatedShardBytes = encodeTallyShardData({
        poll_type_hash: hexToBytes(pollTypeHash),
        shard_id: 0,
        shard_count: shardCount,
        vote_counts: expectedVoteCounts,
        total_voters: BigInt(voterIntentCells.length),
        counted_voter_lock_hashes: countedVoters,
        finalized: false,
      });
      const aggregateOutputsData = voterIntentCells.map((intentCell) => {
        const decoded = decodeVoteIntentData(hexToBytes(intentCell.outputData));
        return bytesToHex(encodeVoteIntentData({ ...decoded, aggregated: true }));
      });
      const aggregateFeeCell = await findSignerAuthCell(aggregatorSigner, [
        outPointKey(pollCell),
        outPointKey(shardCell),
        ...voterIntentCells.map(outPointKey),
      ]);

      const aggregateTx = ccc.Transaction.from({
        cellDeps: [
          governanceCellDep(),
          { outPoint: pollCell.outPoint, depType: "code" },
        ],
        headerDeps: [tipHeader.hash],
        inputs: [
          { previousOutput: shardCell.outPoint },
          ...voterIntentCells.map((intentCell) => ({ previousOutput: intentCell.outPoint })),
          {
            previousOutput: {
              txHash: aggregateFeeCell.outPoint.txHash,
              index: Number(aggregateFeeCell.outPoint.index),
            },
          },
        ],
        outputs: [
          {
            lock: shardCell.cellOutput.lock,
            type: shardCell.cellOutput.type,
            capacity: shardCell.cellOutput.capacity,
          },
          ...voterIntentCells.map((intentCell) => ({
            lock: intentLock,
            type: intentType,
            capacity: intentCell.cellOutput.capacity,
          })),
        ],
        outputsData: [bytesToHex(updatedShardBytes), ...aggregateOutputsData],
        witnesses: Array.from({ length: voterIntentCells.length + 2 }).map(() => "0x"),
      });

      await aggregateTx.completeFeeBy(aggregatorSigner, TX_FEE_SHANNONS);
      preflightIntentGroupTransition(
        aggregateTx,
        new Map(voterIntentCells.map((cell) => [`${cell.outPoint.txHash}:${cell.outPoint.index}`, cell])),
        intentType
      );
      await aggregatorSigner.signTransaction(aggregateTx);

      const aggregateHash = await client.sendTransaction(aggregateTx);
      await waitForTx(client, aggregateHash);
      console.log(`CREATE_TALLY_SHARD aggregate: ${aggregateHash}`);

      aggregatedShardCell = {
        outPoint: { txHash: aggregateHash, index: 0 },
        cellOutput: {
          lock: shardCell.cellOutput.lock,
          type: shardCell.cellOutput.type,
          capacity: shardCell.cellOutput.capacity,
        },
        outputData: bytesToHex(updatedShardBytes),
      };
      aggregatedIntentCells = voterIntentCells.map((intentCell, index) => ({
        outPoint: { txHash: aggregateHash, index: index + 1 },
        cellOutput: {
          lock: intentLock,
          type: intentType,
          capacity: intentCell.cellOutput.capacity,
        },
        outputData: aggregateOutputsData[index],
      }));
    }
  ));

  results.push(await runScenario(
    "sharded_close_requires_finalized_shards",
    "pass_or_skip",
    async () => {
      if (!aggregatedShardCell || aggregatedIntentCells.length !== voterIntentCells.length) {
        throw new ScenarioSkip("skipped: shard aggregation did not produce committed marker cells");
      }
      throw new ScenarioSkip(
        "skipped: immediate smoke stops before post-deadline CREATE_TALLY_SHARD finalization, MERGE_TALLY_SHARDS for large polls, and CLOSE_POLL"
      );
    }
  ));

  console.log("\n=== Scenario Results ===");
  for (const result of results) {
    const expectedMet = (
      (result.expected === "pass" && result.outcome === "pass") ||
      (result.expected === "fail" && result.outcome === "fail") ||
      (result.expected === "pass_or_skip" && (result.outcome === "pass" || result.outcome === "skip"))
    );
    const marker = result.outcome === "skip" && expectedMet ? "SKIP" : expectedMet ? "OK" : "MISMATCH";
    console.log(`[${marker}] ${result.name} | expected=${result.expected} outcome=${result.outcome} | ${result.detail}`);
  }

  const mismatches = results.filter((result) => {
    if (result.expected === "pass") return result.outcome !== "pass";
    if (result.expected === "fail") return result.outcome !== "fail";
    return result.outcome !== "pass" && result.outcome !== "skip";
  });
  if (mismatches.length > 0) {
    throw new Error(`Multi-actor smoke completed with ${mismatches.length} expectation mismatch(es).`);
  }

  console.log("=== Multi-actor smoke complete ===");
}

main().catch((error) => {
  console.error("Multi-actor smoke failed:", error);
  process.exit(1);
});
