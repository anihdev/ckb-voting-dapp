import { describe, expect, test } from "vitest";

import { buildTallySmtTransition } from "../../frontend/src/lib/tallySmt";
import { TallySmtProvider } from "./tally-smt-wasm-pkg/tally_smt.js";

const EMPTY_ROOT = `0x${"00".repeat(32)}`;
const ONE_ROOT = "0x9d3a395af589bf01bd60a2abda079948bd83f276a525b566761c5ab009650361";
const TWO_ROOT = "0xc5459bea1d7ae70eb94e9f67a52bb7c3262daad1f6e780d6432ec185e7c0eaaf";
const EMPTY_TO_TWO_PROOF = "0x4c4ffd4c4ffd484f02";

const key = (byte: number): Uint8Array => new Uint8Array(32).fill(byte);
const hex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;

const nodeEngine = async () => new TallySmtProvider();

describe("tally sparse-Merkle WASM provider", () => {
  test("matches the committed CKB-hash roots and compiled proof vector", () => {
    const tree = new TallySmtProvider();
    expect(hex(tree.root())).toBe(EMPTY_ROOT);

    const proof = tree.compile_transition_proof([key(0x11), key(0x22)]);
    expect(hex(proof)).toBe(EMPTY_TO_TWO_PROOF);

    tree.insert_present(key(0x11));
    expect(hex(tree.root())).toBe(ONE_ROOT);
    tree.insert_present(key(0x22));
    expect(hex(tree.root())).toBe(TWO_ROOT);
    tree.free();
  });

  test("builds an empty-to-present transition through the frontend adapter", async () => {
    const transition = await buildTallySmtTransition(
      {
        expectedBeforeRoot: new Uint8Array(32),
        existingVoterKeys: [],
        pendingVoterKeys: [key(0x11), key(0x22)],
      },
      nodeEngine
    );

    expect(hex(transition.beforeRoot)).toBe(EMPTY_ROOT);
    expect(hex(transition.afterRoot)).toBe(TWO_ROOT);
    expect(hex(transition.compiledProof)).toBe(EMPTY_TO_TWO_PROOF);
  });

  test("reconstructs an existing lane before adding another represented voter", async () => {
    const transition = await buildTallySmtTransition(
      {
        expectedBeforeRoot: Uint8Array.from(Buffer.from(ONE_ROOT.slice(2), "hex")),
        existingVoterKeys: [key(0x11)],
        pendingVoterKeys: [key(0x22)],
      },
      nodeEngine
    );

    expect(hex(transition.afterRoot)).toBe(TWO_ROOT);
    expect(transition.compiledProof.length).toBeGreaterThan(0);
  });

  test("fails closed for stale roots and duplicate represented voters", async () => {
    await expect(
      buildTallySmtTransition(
        {
          expectedBeforeRoot: new Uint8Array(32),
          existingVoterKeys: [key(0x11)],
          pendingVoterKeys: [key(0x22)],
        },
        nodeEngine
      )
    ).rejects.toThrow("do not reconstruct");

    await expect(
      buildTallySmtTransition(
        {
          expectedBeforeRoot: new Uint8Array(32),
          existingVoterKeys: [],
          pendingVoterKeys: [key(0x11), key(0x11)],
        },
        nodeEngine
      )
    ).rejects.toThrow("duplicate represented voter");
  });
});
