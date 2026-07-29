# ZK Aggregation MVP Plan

Status: frozen historical research. It is not a current implementation brief and is outside the DAO Builder SDK grant scope. Do not resume it without an explicit maintainer decision.

For the current post-sharding ZK completeness research track, use `ZK_COMPLETENESS_DESIGN.md`. This file is historical context for the older poll-cell aggregation idea.

Do not start Groth16, Cecilia verifier integration, or proof-circuit work from this file. The notes below are retained as research context only; current work is the non-ZK DAO Builder SDK, represented-principal authority design, eligibility policy, and controlled testnet rehearsal.

This document records an earlier plan for adding ZK-assisted aggregation to the CKB governance protocol. It is intentionally scoped as an MVP/testnet plan, not a mainnet privacy claim.

The contract source of truth remains:

- `backend/contracts-rust/contracts/governance/src/entry.rs`
- `backend/contracts-rust/contracts/governance/src/codec.rs`

The ZK layer must prove and enforce the same aggregation semantics the Rust contract already defines. It must not weaken intent-cell deposits, refund paths, delegation, or close/force-close rules.

## Historical Decision

The old direction was to build a ZK-assisted aggregation MVP around `AGGREGATE_VOTES`. That path is no longer the active next step because it preserves poll-cell serialization. The current sequence is: shard tally cells first, then evaluate Groth16/Cecilia verifier work as proof infrastructure for shard updates or final merge verification.

The MVP should prove that a batch of consumed vote intent cells produces the claimed poll tally transition. It should not attempt to solve private voting, poll-cell serialization, DAO weighting, or rollup-style data availability in the first milestone.

This gives the project a focused and testable ZK step:

- preserve the current intent-cell voting flow
- preserve permissionless aggregation
- measure real Groth16 verifier costs on CKB-VM
- make proof binding and replay safety explicit
- leave privacy and parallel tallying as later protocol extensions

## MVP Acceptance Bar

The ZK MVP is considered complete only when all of the following are true on testnet or in a reproducible local CKB-VM test harness:

- A prover can generate a proof for a fixed-size aggregation batch.
- The transaction consumes the poll cell and the exact intent cells proven by the circuit.
- The transaction outputs a poll cell whose encoded data matches the proven transition.
- The contract rejects proof reuse across:
  - a different poll
  - a different previous poll state
  - a different output poll state
  - a different intent batch
  - a different aggregation circuit version
- The contract rejects malformed proof/public-input encodings.
- The contract rejects a valid proof paired with the wrong verifying key.
- The frontend or smoke builder can construct the ZK aggregation transaction.
- Benchmarks report:
  - proof size
  - public input count
  - prover time
  - verifier cycles
  - full transaction cycles
  - transaction size and fee

## Current Constraints To Address

### 1. ZK Aggregation Does Not Hide Current Vote Choices

Current vote intent cells contain:

- `poll_type_hash`
- `voter_lock_hash`
- `option_index`
- `voted_at_epoch`
- `aggregated`
- `refund_lock`

Because `option_index` and voter identity are present in live cell data, a ZK proof over those intents does not make the current voting flow private. It can prove the aggregation was correct, but it cannot hide data that has already been published on-chain.

MVP response:

- Do not market the first ZK milestone as private voting.
- Label it as "ZK-assisted aggregation correctness".
- Keep the existing transparent intent flow as the base protocol.
- Add a later privacy track only after the transparent ZK aggregation path is measured.

Later privacy track:

- introduce private intent commitments instead of public `option_index`
- store a public nullifier or voter-scope nullifier to prevent double voting
- store eligibility roots or membership commitments in poll data
- prove eligibility and option validity without revealing voter-to-choice linkage
- keep public tallies and governance outcomes visible

This later track is a protocol change and needs a separate spec. It should not be bundled into the MVP.

### 2. ZK Aggregation Does Not Remove Poll-Cell Serialization

The current design still updates one poll cell. Even if a proof validates a large batch, the transaction must consume the current poll cell and create the next poll cell. That means concurrent aggregators for the same poll still contend on the same poll state.

MVP response:

- Accept poll-cell serialization as an MVP constraint.
- Use ZK to prove batch correctness, not to parallelize final tally writes.
- Measure whether larger proven batches reduce operational pressure enough to justify the added verifier cost.
- Keep the non-ZK aggregation path available until ZK has clear cost or correctness value.

Serialization mitigation roadmap:

- Phase S1: larger batches over the single poll cell.
  - Keep the current poll cell as canonical state.
  - Use ZK to safely aggregate more intents per transaction.
  - This is the MVP-compatible mitigation.
- Phase S2: sharded tally cells.
  - Split tally updates across shard cells keyed by poll plus shard id.
  - Aggregators update different shards independently.
  - Close/finalize consumes shard states and produces final poll result.
  - This reduces aggregation contention but adds close complexity and more indexer work.
- Phase S3: commitment-first aggregation.
  - Maintain an intent registry root or batch commitment root.
  - Prove updates against commitments rather than consuming every intent cell in one transaction.
  - This can reduce transaction size but requires stronger data availability and recovery rules.

Only Phase S1 belongs in the MVP. Phases S2 and S3 are post-MVP protocol extensions.

### 3. Groth16 Requires Trusted Setup And Circuit Versioning

Groth16 has strong verifier performance, but each circuit needs a verifying key generated from a trusted setup. If the circuit changes, the verifying key changes. If the contract accepts the wrong key or ambiguous circuit semantics, proof validity no longer means the intended governance statement.

MVP response:

- Treat the aggregation circuit as versioned protocol logic.
- Include `circuit_version` in public inputs.
- Bind the verifying key cell data hash in the verifier path.
- Record the expected circuit version and verifying key hash in deployment configuration.
- Never silently reuse a verifying key after circuit changes.
- Add tests that a valid proof under one key/version is rejected under another key/version.

Circuit versioning rule:

- `AGGREGATION_CIRCUIT_V1` proves only transparent intent aggregation.
- Any privacy, sharding, DAO weighting, or registry-root change requires a new circuit version.

### 4. Cecilia's Groth16 Verifier Is Pre-Audit

Cecilia's `groth16-ckb` is the most relevant current verifier infrastructure for this MVP. It provides a BN254 Groth16 verifier for CKB-VM using arkworks and includes a verifier-core/wire-format split, benchmarks, fuzzing work, and a threat model.

However, it is pre-audit infrastructure. That means it is appropriate for PoC/testnet integration and benchmarking, but not for a mainnet security claim.

MVP response:

- Integrate it only behind a PoC/testnet path.
- Do not remove the existing non-ZK aggregation path.
- Keep documentation explicit that the ZK path is experimental.
- Track verifier version, commit hash, build hash, and verifying key hash.
- Re-run verifier benchmarks with this project's expected public input count.
- Ask Cecilia for review on:
  - witness/public-input encoding
  - verifying key cell reference model
  - public input count expectations
  - replay binding strategy

Collaboration ask:

> We are building a CKB governance protocol using vote intent cells and permissionless aggregation. We want to test whether `groth16-ckb` can verify an aggregation proof where the public inputs are poll identity, previous/new poll state digests, tally deltas, total voter delta, circuit version, and a digest of consumed intent outpoints/data. Is this a good integration target for your verifier, and what wire format or verifier-boundary assumptions should we follow?

### 5. Proof Validity Must Bind To The Exact State Transition

A proof that only says "some intents produce these tally deltas" is not enough. The contract must know that the proof applies to this poll, this input state, these consumed intents, and this output state.

MVP response:

- Public inputs must bind to:
  - governance domain separator
  - circuit version
  - poll type hash
  - previous poll data digest
  - output poll data digest
  - consumed intent batch digest
  - per-option tally deltas
  - total voter delta
- The contract must recompute the relevant digests from the actual transaction inputs/outputs.
- The contract must reject mismatches before accepting the aggregation transition.

Recommended public inputs:

```text
domain_separator
circuit_version
poll_type_hash
previous_poll_data_hash
next_poll_data_hash
intent_batch_hash
option_count
tally_delta_hash
total_voters_delta
```

To keep Groth16 public input count compact, vectors should be represented by hashes where possible:

- hash the per-option delta vector into `tally_delta_hash`
- hash consumed outpoints and intent data into `intent_batch_hash`
- hash previous and next poll cell data instead of exposing every poll field

The contract still checks the normal poll invariants. The proof adds a compact correctness check for the batch computation.

## Intent Batch Digest

The intent batch digest should commit to both cell identity and intent contents. A first version can use a deterministic Blake2b hash over ordered records:

```text
intent_batch_hash = blake2b256(
  "CKB_GOV_ZK_INTENT_BATCH_V1" ||
  intent_count ||
  for each consumed intent in transaction order:
    out_point.tx_hash ||
    out_point.index ||
    input_capacity ||
    input_type_hash ||
    input_lock_hash ||
    vote_intent_data_hash
)
```

This prevents replaying a proof across a different batch that happens to have the same tally deltas.

Ordering rule:

- The prover and contract use transaction input order after the poll input.
- Duplicate voter checks must match the existing Rust aggregation logic.
- The batch must be bounded by `MAX_INTENTS_PER_AGG` or a new explicit ZK batch limit.

## Poll State Digest

The proof should bind to both the input and output poll data:

```text
previous_poll_data_hash = blake2b256(input poll cell data)
next_poll_data_hash     = blake2b256(output poll cell data)
```

The contract should verify that:

- input hash equals the public input
- output hash equals the public input
- output poll data still satisfies the same immutable-field and lifecycle checks as normal aggregation
- tally/count changes match the proven public outputs

This prevents a valid proof from being paired with a malicious output poll cell.

## Circuit Statement

For `AGGREGATION_CIRCUIT_V1`, the circuit proves:

Given private inputs:

- decoded pending vote intents
- input capacities for those intents
- previous counted voter set or a digest-compatible membership representation
- previous poll option count and token-weighting mode

And public inputs:

- domain separator
- circuit version
- poll type hash
- previous poll data hash
- next poll data hash
- intent batch hash
- option count
- tally delta hash
- total voters delta

The prover knows a batch such that:

- every intent is pending, not already aggregated
- every intent is for the public `poll_type_hash`
- every option index is less than `option_count`
- no intent voter is already counted
- no voter appears twice in the batch
- each weight unit matches the current protocol rule
- tally deltas are computed exactly from option index and weight
- `total_voters_delta` equals the number of newly counted voters
- the intent batch hash matches the consumed outpoints/data
- the output poll state hash matches applying the deltas to the input poll state

Important caveat:

- If the full counted voter set is too large to pass privately into the circuit, the MVP should cap poll size or use the current on-chain counted-voter checks outside the circuit. A later version can move to a Merkleized counted-voter registry.

## Transaction Layout

Historical note: this layout predates the current sharded completeness design. A Groth16 verifier code cell in `cell_deps` only makes code/data available; it does not execute the verifier by itself. Any real implementation must first choose the CKB verifier composition model described in `ZK_COMPLETENESS_DESIGN.md`: embedded verifier logic or a separate verifier-trigger/result cell bound to the same public-input hash.

MVP ZK aggregation transaction:

- Inputs:
  - input 0: current poll cell
  - inputs 1..N: pending vote intent cells
  - optional fee/change inputs after the intent batch
- Cell deps:
  - governance contract code cell
  - Groth16 verifier code cell
  - aggregation verifying key cell
- Outputs:
  - output 0: updated poll cell
  - outputs 1..N: aggregated intent marker cells or protocol-required transition outputs
  - normal change outputs
- Witness:
  - Groth16 proof
  - public input bytes
  - verifier/wire-format metadata required by the verifier

The existing non-ZK aggregation path should remain available during the MVP.

## Privacy Roadmap

Transparent ZK aggregation is not private voting. A privacy-capable version needs different cell data.

Possible later design:

- replace public `option_index` with an encrypted vote or option commitment
- add `nullifier = H(poll_id, voter_secret)` to prevent double voting without revealing voter identity
- store eligibility root in the poll cell
- prove membership in the eligibility set
- prove the committed option is valid
- prove the tally delta corresponds to the hidden option
- reveal only aggregate public tally updates

This would require new intent data layout, new frontend UX, new tests, and a new circuit version. It should be treated as Phase P, not as part of `AGGREGATION_CIRCUIT_V1`.

## Serialization Roadmap

The MVP keeps one poll cell as canonical state. That is acceptable for testnet, but the project should document that aggregation remains serialized.

Post-MVP options:

- Larger ZK batches:
  - lowest complexity
  - reduces number of poll-cell updates
  - does not allow true parallel final tally writes
- Sharded tally cells:
  - improves parallel aggregation
  - requires shard assignment, shard discovery, and finalization logic
  - increases close complexity
- Commitment registry:
  - may reduce transaction size
  - requires data availability and recovery design
  - changes the indexer role from discovery-only to protocol-critical coordination

MVP acceptance does not require solving serialization, but the README and UI must describe the limitation honestly.

## Implementation Phases

### Phase Z1: Spec And Encoding

- Define `AggregationProofPublicInputsV1`.
- Define byte encoding for public inputs.
- Define `intent_batch_hash`.
- Define poll state hashing.
- Define verifier key hash and circuit version configuration.
- Add frontend/contract mirrored constants for domain separator and circuit version.

### Phase Z2: Off-chain Prover

- Build a small fixed-batch aggregation circuit.
- Start with 8, 16, and 32 intent batches.
- Generate proofs from decoded `VoteIntentData`.
- Emit public input bytes compatible with the verifier.
- Record prover time and proof size.

### Phase Z3: Test Harness Integration

- Integrate Cecilia's verifier in a branch or isolated PoC module.
- Build a local CKB-VM test that verifies one proof.
- Confirm expected cycle costs for the project's public input count.
- Reject wrong proof, wrong public inputs, wrong verifying key, and wrong output poll state.

### Phase Z4: Contract Path

- Add a guarded ZK validation branch under `AGGREGATE_VOTES`.
- Recompute `previous_poll_data_hash`, `next_poll_data_hash`, and `intent_batch_hash` from transaction data.
- Verify proof/public inputs through the verifier path.
- Keep normal poll lifecycle checks active.
- Keep the non-ZK aggregation path active.

### Phase Z5: Frontend And Smoke Flow

- Add a builder path for ZK aggregation.
- Display ZK aggregation as experimental/testnet.
- Show proof generation and transaction status separately.
- Keep normal aggregation available.
- Add smoke tests for successful ZK aggregation and rejection cases.

## Test Matrix

Required MVP tests:

- happy path ZK aggregation
- proof for poll A rejected on poll B
- proof for previous poll state A rejected on state B
- proof for output poll state A rejected on output B
- proof for intent batch A rejected on batch B
- proof with wrong circuit version rejected
- proof with wrong verifying key rejected
- duplicate voter in batch rejected
- already-counted voter rejected
- invalid option index rejected
- malformed public input encoding rejected
- malformed proof encoding rejected
- non-ZK aggregation still works
- close/force-close refund paths still work after ZK aggregation

## Benchmark Plan

Run at minimum:

- batch size 8
- batch size 16
- batch size 32
- batch size 64 if transaction size and prover time are acceptable

Record:

- public input count
- proof size
- verifying key size
- prover time
- verifier cycles
- full transaction cycles
- transaction byte size
- fee
- comparison against normal aggregation for the same batch size

Based on Cecilia's published Groth16 verifier numbers, the expected verifier floor is around 100M+ cycles, not the earlier sub-10M target. The MVP should use measured numbers from the integrated path rather than a speculative target.

## External Collaboration

Use Cecilia's work as verifier infrastructure guidance, not as a replacement for the governance protocol.

Questions for Cecilia:

- What public input encoding is easiest to support with `groth16-ckb`?
- Should this project use arkworks directly or circom with arkworks-compatible export?
- What verifier cell and verifying key cell pattern is recommended?
- What public input count should we target to avoid unnecessary cycle growth?
- Are there integration risks around Molecule witness decoding?
- Is the proposed replay-binding strategy sufficient from the verifier's perspective?

Use `ckb-vote-poc` as research input for:

- proof binding to proposal/poll identity
- permissionless settlement
- DAO-weighted voting ideas
- block-history proof tradeoffs

Do not copy its block-history SP1 model into the MVP unless the project deliberately starts a separate zkVM voting track.
