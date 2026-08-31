# Tally Lane Sparse-Merkle Implementation

**Status:** historical August 5, 2026 fixed-root lane implementation record.
The current repository keeps the sparse-Merkle lane model but later hardens
current-code finalization to one-transaction full-set finalization for `1..16`
active lanes after one aggregation-grace epoch.

**Date:** August 5, 2026.

## Why I Changed The Lane Model

The sharded architecture already removed the original poll-wide aggregation
bottleneck. Voters create independent intent cells, and an aggregator updates
only the deterministic tally lane assigned to those voters. Different lanes can
therefore progress independently.

The former lane codec still had a capacity problem. It appended one 32-byte
`voter_lock_hash` for every counted represented voter while requiring the lane
output to preserve the input capacity exactly. CKB capacity limits how much
data, lock, and type-script state a cell can occupy. Once the growing vector no
longer fit, a real node could not admit another aggregation update for that lane.

`MAX_INTENTS_PER_AGG = 50` never meant that a poll accepted only 50 voters. It
is a transaction batch limit: 250 voters may be processed through five batches,
and more batches may follow. The growing vector prevented that intended flow,
so I replaced the vector with a constant-size authenticated set commitment.

The second issue was operational. A default poll creates eight lanes and every
lane, including an empty one, must be frozen before close. The former frontend
submitted eight transactions and required eight wallet approvals. At the August
5 deployment checkpoint I retained the complete-lane requirement but added
bounded finalization of up to eight ordered lanes in one transaction. Later
hardening widened current-code active support to `1..16` lanes and now requires
the complete ordered lane set to finalize together in one transaction.

## What A Merkle Tree Means Here

A Merkle tree combines leaf values into hashes, then combines those hashes until
one root hash remains. Changing any committed leaf changes the root. A proof
contains the sibling hashes needed to recompute the root for selected leaves,
so a verifier does not need the entire tree.

A sparse Merkle tree has a fixed logical position for every possible key. The
Nervos implementation uses 256-bit keys, so it conceptually has `2^256` leaf
positions. The tree is not stored as `2^256` nodes: empty branches are represented
by deterministic default hashes and only populated paths need materialized
storage or proof data.

For one tally lane:

```text
key     = represented voter's 32-byte voter_lock_hash
absent  = 0x00 repeated 32 times
present = 0x01 repeated 32 times
root    = one 32-byte commitment stored in the lane cell
```

The contract verifies a transition, not a caller's summary:

```text
input root + selected keys are absent
                 |
                 | compiled sparse-Merkle proof
                 v
output root + the same selected keys are present
```

The represented-voter keys come from the consumed vote-intent cells. The old
and new roots come from the lane input and output. The witness supplies only a
versioned compiled proof. It cannot choose different keys, roots, tally deltas,
or voter totals for the verifier.

This proves that a represented-voter key committed in the lane cannot be counted
again. It does **not** prove that every timely intent was selected for
aggregation, and it does not solve the separate v1 issue where conflicting live
intents may exist before either is counted.

## Exact Tree And Codec Rules

The contract, host tests, browser provider, and deploy tooling pin the same
[Nervos sparse-merkle-tree revision](https://github.com/nervosnetwork/sparse-merkle-tree/tree/725cd69d95e3e34cd302e83d86178e959fc53687).

- hash: Blake2b-256 with CKB personalization `ckb-default-hash`;
- tree scope: one `(poll_type_hash, shard_id)` lane;
- key: direct 32-byte `voter_lock_hash`, without a second pre-hash;
- absent value: zero `H256`;
- present value: `[1u8; 32]`;
- lane codec version: `2`;
- aggregation proof version: `1`;
- proof byte limit: 64 KiB;
- aggregation batch limit: 50 intents;
- historical August 5 deployment finalization batch limit: 8 lanes.
  The current repository later raises active finalization support to 16 lanes
  and requires the complete ordered current-code lane set in one transaction.

The v2 lane payload is:

```text
version: u8
poll_type_hash: [u8; 32]
shard_id: u32
shard_count: u32
vote_counts: Vec<u64>
total_voters: u64
counted_voter_root: [u8; 32]
finalized: bool
```

The aggregation witness `input_type` is:

```text
version: u8
compiled_proof: length-prefixed bytes
```

Both decoders reject unknown versions, malformed lengths, empty/oversized
proofs, and trailing bytes.

## Aggregation Flow

### 1. Poll Creation

`CREATE_POLL` still creates the poll and its complete ordered lane set atomically.
Every new lane starts with zero tallies, zero voters, the all-zero sparse-Merkle
root, and `finalized = false`. The fixed root means serialized lane size does not
increase when voters are counted.

### 2. Provider Reconstruction

The reference frontend queries live aggregated intent markers for the selected
poll and lane. Its Rust/WASM provider inserts their represented-voter keys and
reconstructs the current root.

The provider compares that root with the root in the live lane cell. If an RPC
or indexer response is stale or incomplete, the roots differ and the builder
fails closed with a synchronization error. The indexer can prevent that provider
from progressing temporarily, but it cannot make an invalid root transition
pass the contract.

This reconstruction is deliberately simple and permissionless for the testnet
reference app. Its browser work is linear in the lane's existing marker count.
A production SDK can add a persistent proof/indexer provider behind the same
boundary without changing the on-chain statement.

### 3. Proof And Transaction Construction

The provider compiles one multi-proof for the pending represented-voter keys,
then computes the output root after inserting those keys. The builder creates:

```text
input 0   current tally lane
inputs 1+ pending timely intents for that lane

output 0  updated lane with the new root and tally
outputs 1+ same-capacity aggregated intent markers

witness 0 input_type = versioned compiled SMT proof
```

Intent creation headers remain in `header_deps` so the contract can authenticate
each consumed intent's creation epoch through `Source::Input`.

### 4. Contract Verification

The Rust validator independently enforces:

- one current lane at global input/output 0;
- one to 50 exact-scope pending intents;
- authenticated creation epoch at or before the deadline;
- correct poll, option, and deterministic lane assignment;
- no duplicate represented-voter key inside the batch;
- pending-to-aggregated marker transition at the same index;
- exact intent capacity, lock, type, refund, and choice preservation;
- absence of every selected key under the input root;
- presence of those same keys under the output root;
- exactly one equal-weight tally increment per accepted represented voter;
- exact `total_voters` increase and immutable lane fields.

A later batch consumes the next lane outpoint and proves against the next root.
Only updates to the same lane serialize. Other lanes still have independent
outpoints and can be aggregated in parallel.

## Batched Finalization Flow

After the deadline, one finalization transaction may consume one to eight
unfinalized lanes from the same poll:

```text
inputs 0..N-1   lanes ordered by shard_id
outputs 0..N-1  exact same lanes with finalized false -> true
remaining       wallet fee input and change only
```

Every lane input carries the required absolute-epoch `since`. The contract
checks the same poll scope, strict shard ordering, same-index lock/type scripts,
exact capacity, unchanged root/tallies/totals, and the one allowed boolean
transition. It rejects interleaved fee inputs, extra lane outputs, mixed polls,
duplicates, more than eight lanes, or one malformed/early `since`.

The default eight-lane poll now needs one finalization transaction and one wallet
approval. A poll with more than eight remaining lanes needs one explicit approval
per bounded batch; the UI never treats one signature as approval for later
transactions. Every lane must still be finalized before direct close or merge.

## Contention Effect

The change does not introduce a poll-wide mutable commitment:

```text
voters -> independent intent cells
                   |
                   v
          deterministic tally lanes
          lane 0   lane 1   ... lane N
```

- unrelated voters do not share an input while submitting intents;
- aggregators working on different lanes do not share a mutable tally input;
- two aggregators updating the same lane still compete for that lane outpoint;
- finalization intentionally consumes several already-frozen-ready lanes once,
  after voting and aggregation have ended.

The sparse-Merkle root fixes lane data growth. It does not remove same-lane
serialization and does not claim vote completeness.

## Implementation Map

- [Rust codec](backend/contracts-rust/contracts/governance/src/codec.rs): v2
  lane and versioned proof decoding.
- [Rust validator](backend/contracts-rust/contracts/governance/src/entry.rs):
  root transition and multi-lane finalization rules.
- [Protocol constants](backend/contracts-rust/contracts/governance/src/constants.rs):
  versions, limits, and present value.
- [WASM provider](frontend/tally-smt-wasm/src/lib.rs): one pinned Rust tree
  implementation compiled for browser and Node adapters.
- [Frontend provider](frontend/src/lib/tallySmt.ts): reconstruction, root check,
  and transition proof generation.
- [Transaction builders](frontend/src/lib/ckb.ts): aggregation witness plus the
  current one-transaction full-set finalization layouts for `1..16` active
  lanes.
- [Lifecycle hook](frontend/src/hooks/usePolls.ts): marker discovery, advisory
  readiness scans, and current complete-lane-set finalization selection.
- [CKB-VM tests](backend/contracts-rust/integration-tests/tests/governance_vm.rs):
  protocol behavior, adversarial proof/finalization cases, and integrated cycles.

## Verification Evidence

The integrated CKB-VM tests enforce a project ceiling of 50,000,000 cycles.
Historical August 5 local measurements were:

| Scenario | CKB-VM cycles |
| --- | ---: |
| 1-intent aggregation | 660,071 |
| 10-intent aggregation | 3,341,782 |
| 25-intent aggregation | 7,837,699 |
| 50-intent aggregation | 15,321,929 |
| 1,024 existing voters plus a 50-intent batch | 19,067,359 |
| 8-lane finalization | 7,386,432 |

The mature-lane 50-intent proof measured 10,067 bytes, below the 64 KiB protocol
bound. Adversarial tests cover duplicate/already-present voters, malformed or
trailing proof bytes, wrong roots, tally/marker mutation, and finalization scope,
ordering, count, output, root, and `since` failures.

`ckb-testtool 1.1.1` executes script groups and checks `outputs_data` shape, but
its `Context::verify_tx_consensus` does not run the full node's
`CapacityVerifier` or complete `SinceVerifier`. The constant-size lane is also
checked with CCC occupied-capacity calculations, but a controlled real-node
testnet rehearsal remains mandatory before end-to-end lifecycle and `since`
behavior claims.

The generated browser and Node WASM adapters are reproducibly rebuilt in CI and
compared against committed output. Hard-coded cross-runtime vectors bind empty,
one-key, two-key, root, and compiled-proof bytes.

## What This Does Not Solve

- A timely intent may still be omitted before finalization; deposit recovery is
  not a completeness proof.
- V1 intent creation still cannot prove that one represented voter has only one
  live intent across separate transactions. The SMT prevents double counting,
  but the first valid conflicting intent aggregated determines the counted
  choice.
- The current delegated-intent funding/refund boundary remains testnet v1 policy.
- Permissionless maintenance has no built-in operator reward.
- The reference proof provider depends on live marker data availability.
- The work has no formal audit and is not mainnet-ready.

These boundaries remain separate from the planned represented-principal
`VoterStateCell`/`VotePermitCell` design and any future vote-completeness proof.

## Versioning And Deployment

The current hardened contract binary and lane codec were deployed as a new
testnet code cell in
[`0xc82294a1...e5fbd97e`](https://pudge.explorer.nervos.org/transaction/0xc82294a1503e51a0d668ab94554eaa60f972a0dd0f2cb14ddf573510e5fbd97e),
with `data1` code hash
`0x2300964979e336dc8196c61a177846e7249091ba7db5a9bfd7db834048f7f6ef`.
Existing cells remain bound to their historical code dependency and are not
silently reinterpreted or migrated. Deployment/configuration is verified; the
complete multi-actor lifecycle rehearsal remains pending. Retired opcodes
`0x03` and `0x06` remain tombstones.

## References

- [Nervos sparse-merkle-tree repository](https://github.com/nervosnetwork/sparse-merkle-tree)
- [Pinned sparse-merkle-tree revision](https://github.com/nervosnetwork/sparse-merkle-tree/tree/725cd69d95e3e34cd302e83d86178e959fc53687)
- [CKB Cell Model](https://docs.nervos.org/docs/ckb-fundamentals/cell-model)
- [CKB RFC 0022: transaction structure, capacity, script groups, Type ID, and header deps](https://nervosnetwork.github.io/rfcs/rfcs/0022-transaction-structure/0022-transaction-structure.html)
- [CKB RFC 0017: transaction `since`](https://nervosnetwork.github.io/rfcs/rfcs/0017-tx-valid-since/0017-tx-valid-since.html)
- [ckb-testtool repository](https://github.com/nervosnetwork/ckb-testtool)
- [ckb-testtool `Context` consensus helper](https://github.com/nervosnetwork/ckb-testtool/blob/master/src/context.rs)
- [Sharded aggregation explainer](SHARDED_AGGREGATION_EXPLAINED.md)
