import { TallySmtProvider } from "./tally-smt-wasm-pkg/tally_smt.js";

export interface NodeTallySmtTransition {
  beforeRoot: Uint8Array;
  afterRoot: Uint8Array;
  compiledProof: Uint8Array;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

function assertHash(value: Uint8Array, field: string): void {
  if (value.length !== 32) throw new Error(`${field} must be exactly 32 bytes`);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Build the same sparse-Merkle set transition used by the browser builder.
 *
 * Flow: reconstruct the old tree from indexed aggregated markers, require its
 * root to match the live lane, prove pending keys absent, then insert them and
 * return the new root. The tree and proof algorithms live in the shared Rust
 * WASM wrapper; this file only enforces deployment-tool inputs.
 */
export function buildNodeTallySmtTransition(input: {
  expectedBeforeRoot: Uint8Array;
  existingVoterKeys: Uint8Array[];
  pendingVoterKeys: Uint8Array[];
}): NodeTallySmtTransition {
  assertHash(input.expectedBeforeRoot, "expected lane root");
  if (input.pendingVoterKeys.length === 0) {
    throw new Error("aggregation proof requires at least one pending voter");
  }

  const existingKeys = new Set<string>();
  for (const key of input.existingVoterKeys) {
    assertHash(key, "existing voter key");
    const encoded = bytesToHex(key);
    if (existingKeys.has(encoded)) throw new Error("duplicate existing voter key");
    existingKeys.add(encoded);
  }

  const pendingKeys = new Set<string>();
  for (const key of input.pendingVoterKeys) {
    assertHash(key, "pending voter key");
    const encoded = bytesToHex(key);
    if (existingKeys.has(encoded)) throw new Error("pending voter is already counted");
    if (pendingKeys.has(encoded)) throw new Error("duplicate pending voter key");
    pendingKeys.add(encoded);
  }

  const tree = new TallySmtProvider();
  for (const key of input.existingVoterKeys) tree.insert_present(key);
  const beforeRoot = new Uint8Array(tree.root());
  if (!equalBytes(beforeRoot, input.expectedBeforeRoot)) {
    throw new Error("indexed aggregated markers do not reconstruct the live tally lane root");
  }

  const compiledProof = new Uint8Array(tree.compile_transition_proof(input.pendingVoterKeys));
  for (const key of input.pendingVoterKeys) tree.insert_present(key);
  const afterRoot = new Uint8Array(tree.root());
  tree.free();
  return { beforeRoot, afterRoot, compiledProof };
}
