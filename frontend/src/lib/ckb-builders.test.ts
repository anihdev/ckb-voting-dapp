/**
 * CKB Builder Layout Tests
 * ========================
 * Executes timing-sensitive builders with real CCC transaction objects while
 * mocking only wallet capacity and fee completion.
 */

import { ccc } from "@ckb-ccc/core";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  absoluteEpochSince,
  buildAggregateTallyShardTx,
  buildClosePollTx,
  buildCreatePollTx,
  buildCreateVoteIntentTx,
  buildDelegateTx,
  buildFinalizeTallyShardTx,
  buildFinalizeTallyShardsTx,
  buildForceCloseTx,
  buildGovernanceTypeScript,
  buildIntentLockScript,
  buildMergeTallyShardsTx,
  buildPollLockScript,
  buildRefundLateIntentTx,
  buildTallyMergeResultTypeScript,
  buildTallyShardTypeScript,
  hashScript,
  MAX_ACTIVE_TALLY_SHARDS,
} from "./ckb";
import {
  bytesToHex,
  decodePollData,
  decodeTallyMergeResultData,
  decodeTallyShardData,
  EncodedScript,
  encodePollData,
  encodeTallyMergeResultData,
  encodeTallyShardData,
  encodeVoteIntentData,
} from "./molecule";
import {
  CREATOR_DEPOSIT_SHANNONS,
  FORCE_CLOSE_GRACE_EPOCHS,
  MAX_SHARDS_PER_MERGE,
  OP,
  SHANNONS_PER_CKB,
  TALLY_MERGE_RESULT_MIN_SHANNONS,
  TALLY_SHARD_MIN_SHANNONS,
  VOTER_DEPOSIT_SHANNONS,
} from "./constants";

vi.mock("./tallySmt", () => ({
  buildTallySmtTransition: vi.fn(async ({ expectedBeforeRoot }: any) => ({
    beforeRoot: expectedBeforeRoot,
    afterRoot: new Uint8Array(32).fill(0x7a),
    compiledProof: new Uint8Array([0x4c, 0x01]),
  })),
}));

const DEADLINE = 100n;
const ORIGIN_HASH = `0x${"ef".repeat(32)}`;

function txHash(byte: number): string {
  return `0x${byte.toString(16).padStart(2, "0").repeat(32)}`;
}

function encodedScript(script: any): EncodedScript {
  return {
    code_hash: String(script.codeHash),
    hash_type: script.hashType,
    args: String(script.args),
  };
}

function outPointKey(input: any): string {
  return `${input.previousOutput.txHash}:${Number(input.previousOutput.index)}`;
}

function liveCell(
  byte: number,
  lock: any,
  type: any | undefined,
  capacity: bigint,
  outputData: string
): any {
  return {
    outPoint: { txHash: txHash(byte), index: 0 },
    cellOutput: { lock, type, capacity },
    outputData,
  };
}

function fixture(tokenWeighted = false) {
  const signerLock = ccc.Script.from({
    codeHash: txHash(0x11),
    hashType: "type",
    args: "0x1234",
  });
  const pollType = buildGovernanceTypeScript(OP.CREATE_POLL, txHash(0x22));
  const pollTypeHash = hashScript(pollType);
  const pollLock = buildPollLockScript(pollTypeHash);
  const shardType = buildTallyShardTypeScript(pollTypeHash, 0);
  const creator = ccc.bytesFrom(hashScript(signerLock));
  const pollData = encodePollData({
    question: "Builder timing fixture",
    options: ["Yes", "No"],
    vote_counts: [0n, 0n],
    deadline: DEADLINE,
    creator,
    creator_lock: encodedScript(signerLock),
    is_closed: false,
    total_voters: 0n,
    creator_deposit: CREATOR_DEPOSIT_SHANNONS,
    pending_intent_count: 0n,
    counted_voter_lock_hashes: [],
    token_weighted: tokenWeighted,
    udt_type_hash: new Uint8Array(32),
    shard_count: 1,
  });
  const pollCell = liveCell(
    0x31,
    pollLock,
    pollType,
    1_000n * SHANNONS_PER_CKB,
    ccc.hexFrom(pollData)
  );

  const shardData = (finalized: boolean) => encodeTallyShardData({
    version: 2,
    poll_type_hash: ccc.bytesFrom(pollTypeHash),
    shard_id: 0,
    shard_count: 1,
    vote_counts: [0n, 0n],
    total_voters: 0n,
    counted_voter_root: new Uint8Array(32),
    finalized,
  });
  const shardCell = (finalized: boolean) => liveCell(
    finalized ? 0x33 : 0x32,
    shardType,
    shardType,
    TALLY_SHARD_MIN_SHANNONS,
    ccc.hexFrom(shardData(finalized))
  );
  const authCell = liveCell(
    0x34,
    signerLock,
    undefined,
    1_000n * SHANNONS_PER_CKB,
    "0x"
  );

  const headers = vi.fn(async () => ({
    header: {
      hash: ORIGIN_HASH,
      epoch: ccc.Epoch.from([DEADLINE, 0n, 1n]),
    },
  }));
  const client = {
    getCellWithHeader: headers,
    getTipHeader: vi.fn(async () => ({
      hash: txHash(0x45),
      epoch: ccc.Epoch.from([DEADLINE + 20n, 0n, 1n]),
    })),
    findCells: async function* () {
      yield authCell;
    },
  };
  const signer = {
    client,
    getAddressObjSecp256k1: vi.fn(async () => ({ script: signerLock })),
  };

  return {
    authCell,
    client,
    pollCell,
    pollTypeHash,
    shardCell,
    signer,
    signerLock,
  };
}

function intentCell(
  byte: number,
  pollTypeHash: string,
  refundLock: any,
  voterByte: number,
  optionIndex: number,
  aggregated = false,
  capacity = VOTER_DEPOSIT_SHANNONS
): any {
  const intentType = buildGovernanceTypeScript(OP.CREATE_VOTE_INTENT, pollTypeHash);
  const data = encodeVoteIntentData({
    poll_type_hash: ccc.bytesFrom(pollTypeHash),
    voter_lock_hash: new Uint8Array(32).fill(voterByte),
    option_index: optionIndex,
    voted_at_epoch: 0n,
    aggregated,
    refund_lock: encodedScript(refundLock),
  });
  return liveCell(
    byte,
    buildIntentLockScript(pollTypeHash),
    intentType,
    capacity,
    ccc.hexFrom(data)
  );
}

function setPollShardCount(pollCell: any, shardCount: number): void {
  const poll = decodePollData(ccc.bytesFrom(pollCell.outputData));
  pollCell.outputData = ccc.hexFrom(encodePollData({ ...poll, shard_count: shardCount }));
}

function tallyLaneCell(input: {
  pollTypeHash: string;
  shardCount: number;
  shardId: number;
  byte: number;
  dataPollTypeHash?: string;
  dataShardCount?: number;
  finalized?: boolean;
  voteCounts?: bigint[];
  totalVoters?: bigint;
  countedVoterRoot?: Uint8Array;
  lockScript?: any;
  typeScript?: any;
  capacity?: bigint;
}): any {
  const canonicalScript = buildTallyShardTypeScript(input.pollTypeHash, input.shardId);
  const lockScript = input.lockScript ?? canonicalScript;
  const typeScript = input.typeScript ?? canonicalScript;
  const data = encodeTallyShardData({
    version: 2,
    poll_type_hash: ccc.bytesFrom(input.dataPollTypeHash ?? input.pollTypeHash),
    shard_id: input.shardId,
    shard_count: input.dataShardCount ?? input.shardCount,
    vote_counts: input.voteCounts ?? [BigInt(input.shardId), BigInt(input.shardId + 1)],
    total_voters: input.totalVoters ?? BigInt(input.shardId + 1),
    counted_voter_root:
      input.countedVoterRoot ?? new Uint8Array(32).fill((input.shardId + 1) & 0xff),
    finalized: input.finalized ?? false,
  });

  return liveCell(
    input.byte,
    lockScript,
    typeScript,
    input.capacity ?? TALLY_SHARD_MIN_SHANNONS,
    ccc.hexFrom(data)
  );
}

function mutateCellOutputData(cell: any, mutate: (bytes: Uint8Array) => void): any {
  const bytes = new Uint8Array(ccc.bytesFrom(cell.outputData));
  mutate(bytes);
  return {
    ...cell,
    outputData: ccc.hexFrom(bytes),
  };
}

function mergeResultCell(input: {
  pollTypeHash: string;
  shardIds: number[];
  byte: number;
  mergeLevel?: number;
  voteCounts?: bigint[];
  totalVoters?: bigint;
  capacity?: bigint;
  lockScript?: any;
  typeScript?: any;
  version?: number;
}): any {
  const mergeScript = buildTallyMergeResultTypeScript(input.pollTypeHash);
  const lockScript = input.lockScript ?? mergeScript;
  const typeScript = input.typeScript ?? mergeScript;
  const coverage = new Uint8Array(32);
  for (const shardId of input.shardIds) {
    coverage[Math.floor(shardId / 8)] |= 1 << (shardId % 8);
  }
  const data = encodeTallyMergeResultData({
    poll_type_hash: ccc.bytesFrom(input.pollTypeHash),
    coverage,
    vote_counts: input.voteCounts ?? [BigInt(input.shardIds.length), 0n],
    total_voters: input.totalVoters ?? BigInt(input.shardIds.length),
    merge_level: input.mergeLevel ?? 1,
    version: input.version ?? 1,
  });

  return liveCell(
    input.byte,
    lockScript,
    typeScript,
    input.capacity ?? TALLY_MERGE_RESULT_MIN_SHANNONS,
    ccc.hexFrom(data)
  );
}

describe("timing-sensitive CCC builders", () => {
  let completionIndex = 0;

  beforeEach(() => {
    completionIndex = 0;
    vi.spyOn(ccc.Transaction.prototype, "completeInputsByCapacity").mockImplementation(
      async function () {
        completionIndex += 1;
        this.inputs.push(ccc.CellInput.from({
          previousOutput: { txHash: txHash(0x70 + completionIndex), index: 0 },
          since: 0,
        }));
        return 1;
      }
    );
    vi.spyOn(ccc.Transaction.prototype, "completeFeeBy").mockImplementation(
      async function () {
        completionIndex += 1;
        this.inputs.push(ccc.CellInput.from({
          previousOutput: { txHash: txHash(0x70 + completionIndex), index: 0 },
          since: 0,
        }));
        return [1, true];
      }
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("aggregation pins shard/intents and deduplicates authenticated origins", async () => {
    const built = fixture();
    const firstIntent = intentCell(0x41, built.pollTypeHash, built.signerLock, 0xa1, 0);
    const secondIntent = intentCell(0x42, built.pollTypeHash, built.signerLock, 0xa2, 1);

    const tx = await buildAggregateTallyShardTx(built.signer, {
      pollCell: built.pollCell,
      shardCell: built.shardCell(false),
      intentCells: [firstIntent, secondIntent],
    });

    expect(tx.headerDeps.map(String)).toEqual([ORIGIN_HASH]);
    expect(tx.inputs.slice(0, 3).map(outPointKey)).toEqual([
      `${txHash(0x32)}:0`,
      `${txHash(0x41)}:0`,
      `${txHash(0x42)}:0`,
    ]);
    expect(built.client.getCellWithHeader).toHaveBeenCalledTimes(2);
  });

  test("vote intent builder rejects the poll creator", async () => {
    const built = fixture();
    built.client.getTipHeader.mockResolvedValueOnce({
      hash: txHash(0x46),
      epoch: ccc.Epoch.from([DEADLINE, 0n, 1n]),
    });

    await expect(buildCreateVoteIntentTx(built.signer, {
      pollTypeHash: built.pollTypeHash,
      optionIndex: 0,
      pollCell: built.pollCell,
    })).rejects.toThrow("Poll creator cannot submit vote intents");
  });

  test("delegation builder rejects self-delegation before selecting capacity", async () => {
    const built = fixture();
    await expect(buildDelegateTx(built.signer, {
      delegateLockHash: hashScript(built.signerLock),
      pollTypeHash: built.pollTypeHash,
    })).rejects.toThrow("Delegator and delegate must be different wallets");
  });

  test("delegation builder rejects missing, malformed, and zero poll scopes", async () => {
    const built = fixture();
    const delegateLockHash = txHash(0x77);

    await expect(buildDelegateTx(built.signer, {
      delegateLockHash,
      pollTypeHash: "",
    })).rejects.toThrow("32-byte type hash");
    await expect(buildDelegateTx(built.signer, {
      delegateLockHash,
      pollTypeHash: "0x1234",
    })).rejects.toThrow("32-byte type hash");
    await expect(buildDelegateTx(built.signer, {
      delegateLockHash,
      pollTypeHash: `0x${"00".repeat(32)}`,
    })).rejects.toThrow("global delegations are disabled");
  });

  test("poll builder rejects weighted creation requests", async () => {
    await expect(buildCreatePollTx(null, {
      question: "Unsupported weighted poll",
      options: ["Yes", "No"],
      deadlineEpoch: DEADLINE,
      tokenWeighted: true,
    })).rejects.toThrow("Weighted polls are unsupported");
  });

  test("poll builder accepts 16 lanes and rejects 17", async () => {
    const built = fixture();
    const tx = await buildCreatePollTx(built.signer, {
      question: "Current-code active cap",
      options: ["Yes", "No"],
      deadlineEpoch: DEADLINE + 21n,
      shardCount: MAX_ACTIVE_TALLY_SHARDS,
    });
    const poll = decodePollData(ccc.bytesFrom(tx.outputsData[0]));
    expect(poll.shard_count).toBe(MAX_ACTIVE_TALLY_SHARDS);

    await expect(buildCreatePollTx(built.signer, {
      question: "Over active cap",
      options: ["Yes", "No"],
      deadlineEpoch: DEADLINE + 21n,
      shardCount: MAX_ACTIVE_TALLY_SHARDS + 1,
    })).rejects.toThrow(`between 1 and ${MAX_ACTIVE_TALLY_SHARDS}`);
  });

  test("poll builder serializes the canonical zero UDT hash", async () => {
    const built = fixture();
    const tx = await buildCreatePollTx(built.signer, {
      question: "Canonical equal-weight poll",
      options: ["Yes", "No"],
      deadlineEpoch: DEADLINE + 21n,
      shardCount: 1,
    });
    const poll = decodePollData(ccc.bytesFrom(tx.outputsData[0]));

    expect(poll.token_weighted).toBe(false);
    expect(bytesToHex(poll.udt_type_hash)).toBe(`0x${"00".repeat(32)}`);
  });

  test("intent and aggregation builders reject indexed weighted polls", async () => {
    const built = fixture(true);

    await expect(buildCreateVoteIntentTx(built.signer, {
      pollTypeHash: built.pollTypeHash,
      optionIndex: 0,
      pollCell: built.pollCell,
    })).rejects.toThrow("Weighted polls are unsupported");

    await expect(buildAggregateTallyShardTx(built.signer, {
      pollCell: built.pollCell,
      shardCell: built.shardCell(false),
      intentCells: [intentCell(0x44, built.pollTypeHash, built.signerLock, 0xa4, 0)],
    })).rejects.toThrow("Weighted polls are unsupported");
    expect(built.client.getCellWithHeader).not.toHaveBeenCalled();
  });

  test("weighted poll recovery builders retain finalization and close", async () => {
    const built = fixture(true);
    const finalizeTx = await buildFinalizeTallyShardTx(built.signer, {
      pollCell: built.pollCell,
      shardCell: built.shardCell(false),
    });
    expect(BigInt(finalizeTx.inputs[0].since)).toBe(absoluteEpochSince(DEADLINE + 2n));

    const closeTx = await buildClosePollTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: [built.shardCell(true)],
      intentCells: [],
    });
    const closed = decodePollData(ccc.bytesFrom(closeTx.outputsData[0]));
    expect(closed.is_closed).toBe(true);
    expect(closed.token_weighted).toBe(true);
  });

  test("equal-weight aggregation counts oversized intent capacity as one", async () => {
    const built = fixture();
    const oversizedIntent = intentCell(
      0x45,
      built.pollTypeHash,
      built.signerLock,
      0xa5,
      0,
      false,
      5n * VOTER_DEPOSIT_SHANNONS
    );

    const tx = await buildAggregateTallyShardTx(built.signer, {
      pollCell: built.pollCell,
      shardCell: built.shardCell(false),
      intentCells: [oversizedIntent],
    });
    const shard = decodeTallyShardData(ccc.bytesFrom(tx.outputsData[0]));

    expect(shard.vote_counts).toEqual([1n, 0n]);
    expect(shard.total_voters).toBe(1n);
  });

  test("finalize, creator close, and force-close retain exact input-zero since", async () => {
    const finalized = fixture();
    const finalizeTx = await buildFinalizeTallyShardTx(finalized.signer, {
      pollCell: finalized.pollCell,
      shardCell: finalized.shardCell(false),
    });
    expect(outPointKey(finalizeTx.inputs[0])).toBe(`${txHash(0x32)}:0`);
    expect(BigInt(finalizeTx.inputs[0].since)).toBe(absoluteEpochSince(DEADLINE + 2n));

    const creator = fixture();
    const closeTx = await buildClosePollTx(creator.signer, {
      pollCell: creator.pollCell,
      shardCells: [creator.shardCell(true)],
      intentCells: [],
    });
    expect(closeTx.inputs.slice(0, 3).map(outPointKey)).toEqual([
      `${txHash(0x31)}:0`,
      `${txHash(0x34)}:0`,
      `${txHash(0x33)}:0`,
    ]);
    expect(BigInt(closeTx.inputs[0].since)).toBe(absoluteEpochSince(DEADLINE + 2n));

    const force = fixture();
    const forceTx = await buildForceCloseTx(force.signer, {
      pollCell: force.pollCell,
      shardCells: [force.shardCell(true)],
      intentCells: [],
    });
    expect(forceTx.inputs.slice(0, 2).map(outPointKey)).toEqual([
      `${txHash(0x31)}:0`,
      `${txHash(0x33)}:0`,
    ]);
    expect(BigInt(forceTx.inputs[0].since)).toBe(
      absoluteEpochSince(DEADLINE + FORCE_CLOSE_GRACE_EPOCHS + 1n)
    );
  });

  test("batch finalization sorts 1, 8, and 16-lane sets and pins the protocol prefix", async () => {
    for (const shardCount of [1, 8, 16]) {
      const built = fixture();
      setPollShardCount(built.pollCell, shardCount);
      const laneCells = Array.from({ length: shardCount }, (_, index) =>
        tallyLaneCell({
          pollTypeHash: built.pollTypeHash,
          shardCount,
          shardId: index,
          byte: 0x35 + index,
        })
      );

      const tx = await buildFinalizeTallyShardsTx(built.signer, {
        pollCell: built.pollCell,
        shardCells: [...laneCells].reverse(),
      });

      expect(tx.inputs.slice(0, shardCount).map(outPointKey)).toEqual(
        laneCells.map((cell) => `${cell.outPoint.txHash}:0`)
      );
      expect(tx.inputs.slice(0, shardCount).map((input: any) => BigInt(input.since))).toEqual(
        Array.from({ length: shardCount }, () => absoluteEpochSince(DEADLINE + 2n))
      );
      expect(tx.outputsData.slice(0, shardCount).map((data: string) =>
        decodeTallyShardData(ccc.bytesFrom(data)).finalized
      )).toEqual(Array.from({ length: shardCount }, () => true));
    }
  });

  test("batch finalization rejects malformed lane sets before signing", async () => {
    const built = fixture();
    setPollShardCount(built.pollCell, 16);

    await expect(buildFinalizeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: Array.from({ length: 9 }, () => ({})),
    })).rejects.toThrow("complete indexed active lane set");

    const completeLaneCells = Array.from({ length: 16 }, (_, index) =>
      tallyLaneCell({
        pollTypeHash: built.pollTypeHash,
        shardCount: 16,
        shardId: index,
        byte: 0x40 + index,
      })
    );

    await expect(buildFinalizeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: [...completeLaneCells.slice(0, 15), completeLaneCells[14]],
    })).rejects.toThrow("exact ordered lane ids");

    await expect(buildFinalizeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: completeLaneCells.filter((_, index) => index !== 7),
    })).rejects.toThrow("complete indexed active lane set");

    const outOfRangeBuilt = fixture();
    setPollShardCount(outOfRangeBuilt.pollCell, 2);
    const outOfRangeLane = mutateCellOutputData(
      tallyLaneCell({
        pollTypeHash: outOfRangeBuilt.pollTypeHash,
        shardCount: 2,
        shardId: 1,
        byte: 0x71,
      }),
      (bytes) => {
        bytes[33] = 2;
      }
    );
    await expect(buildFinalizeTallyShardsTx(outOfRangeBuilt.signer, {
      pollCell: outOfRangeBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: outOfRangeBuilt.pollTypeHash,
          shardCount: 2,
          shardId: 0,
          byte: 0x70,
        }),
        outOfRangeLane,
      ],
    })).rejects.toThrow("shard_id must be inside shard_count");

    const wrongPollBuilt = fixture();
    setPollShardCount(wrongPollBuilt.pollCell, 1);
    await expect(buildFinalizeTallyShardsTx(wrongPollBuilt.signer, {
      pollCell: wrongPollBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: wrongPollBuilt.pollTypeHash,
          dataPollTypeHash: txHash(0xaa),
          shardCount: 1,
          shardId: 0,
          byte: 0x71,
        }),
      ],
    })).rejects.toThrow("does not belong to the selected poll");

    const wrongCountBuilt = fixture();
    setPollShardCount(wrongCountBuilt.pollCell, 1);
    await expect(buildFinalizeTallyShardsTx(wrongCountBuilt.signer, {
      pollCell: wrongCountBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: wrongCountBuilt.pollTypeHash,
          shardCount: 1,
          dataShardCount: 2,
          shardId: 0,
          byte: 0x72,
        }),
      ],
    })).rejects.toThrow("count does not match poll configuration");

    const alreadyFinalizedBuilt = fixture();
    setPollShardCount(alreadyFinalizedBuilt.pollCell, 1);
    await expect(buildFinalizeTallyShardsTx(alreadyFinalizedBuilt.signer, {
      pollCell: alreadyFinalizedBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: alreadyFinalizedBuilt.pollTypeHash,
          shardCount: 1,
          shardId: 0,
          byte: 0x73,
          finalized: true,
        }),
      ],
    })).rejects.toThrow("already finalized");

    const wrongLockBuilt = fixture();
    setPollShardCount(wrongLockBuilt.pollCell, 1);
    await expect(buildFinalizeTallyShardsTx(wrongLockBuilt.signer, {
      pollCell: wrongLockBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: wrongLockBuilt.pollTypeHash,
          shardCount: 1,
          shardId: 0,
          byte: 0x74,
          lockScript: buildTallyShardTypeScript(wrongLockBuilt.pollTypeHash, 1),
        }),
      ],
    })).rejects.toThrow("lock does not match governance policy");

    const wrongTypeBuilt = fixture();
    setPollShardCount(wrongTypeBuilt.pollCell, 1);
    await expect(buildFinalizeTallyShardsTx(wrongTypeBuilt.signer, {
      pollCell: wrongTypeBuilt.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: wrongTypeBuilt.pollTypeHash,
          shardCount: 1,
          shardId: 0,
          byte: 0x75,
          typeScript: buildTallyShardTypeScript(wrongTypeBuilt.pollTypeHash, 1),
        }),
      ],
    })).rejects.toThrow("type does not match governance policy");
  });

  test("batch finalization rejects fee completion that tampers with a later lane since", async () => {
    vi.mocked(ccc.Transaction.prototype.completeFeeBy).mockImplementationOnce(
      async function () {
        this.inputs[1].since = 0n;
        return [0, false];
      }
    );
    const built = fixture();
    const poll = decodePollData(ccc.bytesFrom(built.pollCell.outputData));
    built.pollCell.outputData = ccc.hexFrom(encodePollData({ ...poll, shard_count: 2 }));
    const lanes = [0, 1].map((shardId, index) => {
      const script = buildTallyShardTypeScript(built.pollTypeHash, shardId);
      return liveCell(
        0x38 + index,
        script,
        script,
        TALLY_SHARD_MIN_SHANNONS,
        ccc.hexFrom(encodeTallyShardData({
          version: 2,
          poll_type_hash: ccc.bytesFrom(built.pollTypeHash),
          shard_id: shardId,
          shard_count: 2,
          vote_counts: [0n, 0n],
          total_voters: 0n,
          counted_voter_root: new Uint8Array(32),
          finalized: false,
        }))
      );
    });

    await expect(buildFinalizeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: lanes,
    })).rejects.toThrow("protocol input since changed");
  });

  test("merge builder rejects singleton frontier inputs and preserves multi-input success", async () => {
    const built = fixture();
    setPollShardCount(built.pollCell, 9);

    await expect(buildMergeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: built.pollTypeHash,
          shardCount: 9,
          shardId: 0,
          byte: 0x80,
          finalized: true,
        }),
      ],
    })).rejects.toThrow("Merge requires at least two disjoint tally frontier inputs");

    await expect(buildMergeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      mergeResultCells: [
        mergeResultCell({
          pollTypeHash: built.pollTypeHash,
          shardIds: [0, 1],
          byte: 0x81,
        }),
      ],
    })).rejects.toThrow("Merge requires at least two disjoint tally frontier inputs");

    const tx = await buildMergeTallyShardsTx(built.signer, {
      pollCell: built.pollCell,
      shardCells: [
        tallyLaneCell({
          pollTypeHash: built.pollTypeHash,
          shardCount: 9,
          shardId: 8,
          byte: 0x82,
          finalized: true,
          voteCounts: [4n, 0n],
          totalVoters: 4n,
        }),
      ],
      mergeResultCells: [
        mergeResultCell({
          pollTypeHash: built.pollTypeHash,
          shardIds: [0, 1, 2, 3, 4, 5, 6, 7],
          byte: 0x83,
          voteCounts: [8n, 1n],
          totalVoters: 9n,
        }),
      ],
    });

    expect(tx.inputs.slice(0, 2).map(outPointKey)).toEqual([
      `${txHash(0x82)}:0`,
      `${txHash(0x83)}:0`,
    ]);
    const merged = decodeTallyMergeResultData(ccc.bytesFrom(tx.outputsData[0]));
    expect(merged.merge_level).toBe(2);
  });

  test("large close builders reject stale shard arguments before merge-result close", async () => {
    const creator = fixture();
    const creatorPoll = decodePollData(ccc.bytesFrom(creator.pollCell.outputData));
    creator.pollCell.outputData = ccc.hexFrom(encodePollData({
      ...creatorPoll,
      shard_count: 9,
    }));

    await expect(buildClosePollTx(creator.signer, {
      pollCell: creator.pollCell,
      shardCells: [creator.shardCell(true)],
      intentCells: [],
    })).rejects.toThrow("accepts only the complete merge result");

    const force = fixture();
    const forcePoll = decodePollData(ccc.bytesFrom(force.pollCell.outputData));
    force.pollCell.outputData = ccc.hexFrom(encodePollData({
      ...forcePoll,
      shard_count: 9,
    }));

    await expect(buildForceCloseTx(force.signer, {
      pollCell: force.pollCell,
      shardCells: [force.shardCell(true)],
      intentCells: [],
    })).rejects.toThrow("accepts only the complete merge result");
  });

  test("small close builders reject merge-result arguments", async () => {
    const creator = fixture();
    await expect(buildClosePollTx(creator.signer, {
      pollCell: creator.pollCell,
      shardCells: [creator.shardCell(true)],
      mergeResultCell: {},
      intentCells: [],
    })).rejects.toThrow("accepts only the complete finalized shard set");

    const force = fixture();
    await expect(buildForceCloseTx(force.signer, {
      pollCell: force.pollCell,
      shardCells: [force.shardCell(true)],
      mergeResultCell: {},
      intentCells: [],
    })).rejects.toThrow("accepts only the complete finalized shard set");
  });

  test("timed builder rejects fee completion that tampers with protocol since", async () => {
    vi.mocked(ccc.Transaction.prototype.completeFeeBy).mockImplementationOnce(
      async function () {
        this.inputs[0].since = 0n;
        return [0, false];
      }
    );
    const built = fixture();

    await expect(buildFinalizeTallyShardTx(built.signer, {
      pollCell: built.pollCell,
      shardCell: built.shardCell(false),
    })).rejects.toThrow("protocol input since changed after completion");
  });

  test("late refund rejects aggregated markers before origin lookup", async () => {
    const built = fixture();
    const marker = intentCell(0x43, built.pollTypeHash, built.signerLock, 0xa3, 0, true);

    await expect(buildRefundLateIntentTx(built.signer, {
      pollCell: built.pollCell,
      intentCell: marker,
    })).rejects.toThrow("Aggregated intent markers remain locked until poll close");
    expect(built.client.getCellWithHeader).not.toHaveBeenCalled();
  });
});
