import initTallySmt, { TallySmtProvider } from "./tally-smt-wasm-pkg/tally_smt.js";

interface TallySmtEngine {
  insert_present(key: Uint8Array): void;
  root(): Uint8Array;
  compile_transition_proof(keys: Uint8Array[]): Uint8Array;
}

export interface TallySmtTransition {
  beforeRoot: Uint8Array;
  afterRoot: Uint8Array;
  compiledProof: Uint8Array;
}

export type TallySmtEngineFactory = () => Promise<TallySmtEngine>;

let initializedModule: Promise<unknown> | null = null;

const bytesToHex = (bytes: Uint8Array): string =>
  `0x${Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("")}`;

async function defaultEngineFactory(): Promise<TallySmtEngine> {
  // The generated module is statically imported so Vite includes both its JS
  // adapter and WASM bytes in production builds. Initialization is shared.
  initializedModule ??= initTallySmt();
  await initializedModule;
  return new TallySmtProvider();
}

function assertHash(value: Uint8Array, field: string): void {
  if (value.length !== 32) throw new Error(`${field} must be exactly 32 bytes`);
}

function uniqueKeys(keys: Uint8Array[], label: string): Uint8Array[] {
  const seen = new Set<string>();
  for (const key of keys) {
    assertHash(key, `${label} key`);
    const hex = bytesToHex(key).toLowerCase();
    if (seen.has(hex)) throw new Error(`${label} contains a duplicate represented voter`);
    seen.add(hex);
  }
  return keys;
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/**
 * Reconstruct and advance one lane's counted-voter sparse Merkle tree.
 *
 * A sparse Merkle tree maps every possible 32-byte voter key to a value. Keys
 * absent from the set have the all-zero value; counted voters have 32 bytes of
 * `0x01`. Its 32-byte root commits to the whole set without growing lane data.
 * The compiled proof carries only the sibling hashes needed to prove selected
 * keys were absent before and are present after this transition.
 */
export async function buildTallySmtTransition(
  input: {
    expectedBeforeRoot: Uint8Array;
    existingVoterKeys: Uint8Array[];
    pendingVoterKeys: Uint8Array[];
  },
  createEngine: TallySmtEngineFactory = defaultEngineFactory
): Promise<TallySmtTransition> {
  assertHash(input.expectedBeforeRoot, "expected lane root");
  const existing = uniqueKeys(input.existingVoterKeys, "indexed aggregated markers");
  const pending = uniqueKeys(input.pendingVoterKeys, "aggregation batch");
  if (pending.length === 0) throw new Error("aggregation proof requires at least one pending voter");

  const existingSet = new Set(existing.map((key) => bytesToHex(key).toLowerCase()));
  for (const key of pending) {
    if (existingSet.has(bytesToHex(key).toLowerCase())) {
      throw new Error("aggregation batch includes a voter already committed to this lane");
    }
  }

  const engine = await createEngine();
  for (const key of existing) engine.insert_present(key);
  const beforeRoot = new Uint8Array(engine.root());
  if (!equalBytes(beforeRoot, input.expectedBeforeRoot)) {
    throw new Error(
      "Indexed aggregated markers do not reconstruct the live tally lane root; wait for indexer sync"
    );
  }

  const compiledProof = new Uint8Array(engine.compile_transition_proof(pending));
  for (const key of pending) engine.insert_present(key);
  const afterRoot = new Uint8Array(engine.root());
  return { beforeRoot, afterRoot, compiledProof };
}
