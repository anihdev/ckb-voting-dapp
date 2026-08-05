# Sharded Aggregation Explained

This note explains why I moved the voting protocol from poll-cell aggregation to sharded tally aggregation, how the shard logic reduces contention, and how the current flow should work.

It is written as a design explanation for reviewers, contributors, and future implementation sessions. It is not a new protocol spec. For the full current protocol spec, see `README.md` and the contract code.

The current worktree uses a v2 fixed-root tally-lane codec. Each lane stores a
constant-size sparse-Merkle root that records represented voters already counted,
instead of growing one 32-byte hash per voter. That binary is deployed on CKB
testnet under code hash
`0xb2c2ea67113fba954966700558ceb6121abb3935076c5165986d1586bcfbd954`.
The complete multi-actor lifecycle rehearsal remains pending.

## Where The Problem Started

The earlier voting flow used one poll cell as the live tally state.

Conceptually it looked like this:

```text
VoteIntent cells
  -> AGGREGATE_VOTES (retired opcode 0x03)
  -> consume PollCell
  -> update PollData.vote_counts / total_voters / counted_voter_lock_hashes
  -> output new PollCell
```

That model was simple, but it fought the CKB cell model.

On CKB, a cell is immutable once it is on chain. To change its data, a transaction consumes the old cell and creates a new one. A consumed cell is dead and cannot be consumed again. The official CKB Cell Model documentation describes this as consumption of live cells into new cells.

That means if every aggregation transaction needs the same current `PollCell`, then every aggregator is competing for the same input.

```text
Aggregator A consumes PollCell v1 -> produces PollCell v2
Aggregator B also tries PollCell v1 -> invalid once A wins
Aggregator C also tries PollCell v1 -> invalid once A wins
```

This is the serialization problem. It is not a bug in a verifier or frontend. It follows directly from the CKB cell model.

The previous permission-model work did solve one important thing: vote intent cells became governance-locked, so third-party aggregators no longer needed voter signatures to consume pending intents. But it did not solve the single shared poll-cell bottleneck.

## Why Groth16 Was Not The First Fix

I started looking at ZK because I wanted off-chain aggregation and proof-based verification. That is still useful later.

But Groth16 by itself does not change the fact that a CKB cell can only be consumed once. If the final tally still lives in one live `PollCell`, then every proof-based aggregation transaction would still compete for that same poll cell.

So I separated two problems:

```text
Contention problem:
  Where does mutable state live?

Correctness/completeness problem:
  How do I prove the tally is correct and complete?
```

Shards solve the first problem. ZK may later help with the second problem, but ZK/Groth16 work is deferred and outside the current DAO Builder SDK grant scope.

## The Design Decision

The key decision was:

> Keep the poll cell as poll configuration and lifecycle state. Move live mutable tally state into separate tally shard cells.

So the protocol moved from this:

```text
PollCell
  metadata
  vote_counts
  total_voters
  counted voters
```

to this:

```text
PollCell
  metadata
  deadline
  creator
  shard_count
  lifecycle state

TallyShardCell 0
  vote_counts for shard 0
  total_voters for shard 0
  fixed root committing counted voters for shard 0

TallyShardCell 1
  vote_counts for shard 1
  total_voters for shard 1
  fixed root committing counted voters for shard 1

...
```

The poll cell no longer has to be consumed during normal aggregation. It is referenced as a dependency so the contract can verify poll configuration, while the live mutable tally update happens in one shard cell. Deadline eligibility comes from each consumed intent cell's authenticated creation header, not from a caller-selected header dep.

## What A Shard Means Here

In this project, a shard is not a separate blockchain and not a user-facing community group.

I use the word "shard" in the database/protocol sense: one larger piece of state is split into smaller independent pieces so they can be updated separately.

In plain terms, a tally shard is one bucket of votes for a poll. Instead of keeping every counted voter and every vote total in one poll cell, the protocol divides the tally into multiple bucket cells:

```text
Poll tally
  -> shard 0
  -> shard 1
  -> shard 2
  -> ...
```

Each shard stores the vote counts assigned to that bucket plus one fixed
32-byte sparse-Merkle root committing its counted represented-voter keys. So a
shard is an independent tally lane for one poll without a growing voter list in
cell data.

I chose the term because it matches the engineering purpose: split one hot aggregation state into several smaller state cells. It should not be presented to normal voters as a complicated concept. In the UI, it is better to say "aggregation lane", "tally lane", or simply hide the detail unless the user is looking at protocol status.

Each voter maps deterministically to exactly one shard:

```text
shard_id = hash(poll_type_hash || voter_lock_hash) % shard_count
```

That means every valid vote intent has one canonical shard. Aggregators do not choose where a voter goes. The contract and frontend derive the same shard id from the poll identity and voter lock hash.

Local implementation references:

- Rust shard derivation: `backend/contracts-rust/contracts/governance/src/helpers.rs` (`derive_tally_shard_id`)
- TypeScript mirror: `frontend/src/lib/ckb.ts` (`deriveTallyShardId`)
- Deterministic shard-assignment tests: `tests/ckb-helpers.test.ts`
- Contract lifecycle/runtime tests: `backend/contracts-rust/integration-tests/tests/governance_vm.rs`

## How Shards Reduce Contention

Without shards, all aggregators fight over one mutable cell:

```text
PollCell is the live tally cell

Aggregator A -> consumes PollCell
Aggregator B -> also needs PollCell
Aggregator C -> also needs PollCell
```

With shards, aggregators can work on different cells:

```text
Aggregator A -> consumes TallyShardCell 0
Aggregator B -> consumes TallyShardCell 1
Aggregator C -> consumes TallyShardCell 2
```

These transactions do not conflict if they touch different shard cells.

The poll cell is still part of the protocol, but it is not the hot aggregation input anymore.

This does not make contention disappear completely. It changes the contention boundary:

```text
Before:
  every aggregation transaction contends on one poll cell

After:
  only aggregators working on the same shard contend with each other
```

If a poll has 8 shards, there can be up to 8 independent aggregation lanes. If a poll has 32 shards, there can be up to 32 lanes. More shards create more parallelism, but also make close/merge more complex, so the project now uses bounded close and merge rules.

## Current Protocol Flow

The current flow is:

```text
CREATE_POLL
  -> creates the poll cell
  -> creates the complete tally shard set atomically

CREATE_VOTE_INTENT
  -> voter or delegate creates an independent governance-locked intent cell

CREATE_TALLY_SHARD aggregation
  -> aggregator consumes pending intents for one shard
  -> each intent input proves its creation epoch through Source::Input
  -> intent must have been created at or before the deadline
  -> aggregator updates only that shard cell
  -> a compiled sparse-Merkle proof verifies selected voters were absent under
     the old lane root and present under the new root
  -> consumed pending intents become aggregated marker cells
  -> poll cell is not consumed
  -> timely intents can aggregate after the deadline until shard finalization

CREATE_TALLY_SHARD finalization
  -> consumes 1..8 ordered same-poll lanes per transaction
  -> every lane input carries absolute epoch since strictly after deadline
  -> finalization freezes those lane tallies without changing roots or counts

Small poll close
  -> if shard_count <= MAX_DIRECT_CLOSE_SHARDS
  -> CLOSE_POLL consumes poll cell plus complete finalized shard set
  -> final result is derived from shard data

Large poll close
  -> if shard_count > MAX_DIRECT_CLOSE_SHARDS
  -> MERGE_TALLY_SHARDS consumes finalized shards or previous merge results
  -> creates bounded merge result cells
  -> repeat until one complete merge result covers all shards
  -> CLOSE_POLL consumes poll cell plus complete merge result

Post-close omitted intent refund
  -> omitted live intent cells can be refunded after close
  -> this protects deposits, but does not prove the omitted vote was counted

Immediate late intent refund
  -> an intent created after the deadline cannot be aggregated
  -> its authenticated creation epoch enables exact full-capacity refund
```

Local implementation references:

- Operation constants: `backend/contracts-rust/contracts/governance/src/constants.rs`
- Shard aggregation validator: `backend/contracts-rust/contracts/governance/src/entry.rs` (`validate_aggregate_tally_shard`)
- Shard finalization validator: `backend/contracts-rust/contracts/governance/src/entry.rs` (`validate_finalize_tally_shard`)
- Merge validator: `backend/contracts-rust/contracts/governance/src/entry.rs` (`validate_merge_tally_shards`)
- Close validator: `backend/contracts-rust/contracts/governance/src/entry.rs` (`validate_close_poll`)
- Frontend aggregation builder: `frontend/src/lib/ckb.ts` (`buildAggregateTallyShardTx`)
- Frontend finalization builders: `frontend/src/lib/ckb.ts`
  (`buildFinalizeTallyShardTx`, `buildFinalizeTallyShardsTx`)
- Frontend merge builder: `frontend/src/lib/ckb.ts` (`buildMergeTallyShardsTx`)
- Frontend close builders: `frontend/src/lib/ckb.ts` (`buildClosePollTx`, `buildForceCloseTx`)
- Tally display frontier: `frontend/src/lib/protocolUi.ts` (`computeCanonicalTallyFrontier`)
- VM coverage: `backend/contracts-rust/integration-tests/tests/governance_vm.rs`

## Why Shards Are Created With The Poll

I chose atomic poll plus shard creation because standalone shard creation cannot prove uniqueness by itself.

The safe MVP rule is:

```text
CREATE_POLL creates:
  output 0: the poll cell
  output 1..N: the complete shard set
```

This gives the contract a concrete uniqueness boundary. The shard set exists from the start, ordered by shard id and bound to the poll type hash.

If shard cells could be created later by anyone, then the protocol would need another uniqueness mechanism, such as a registry cell or more complex Type ID rule for every shard. That would add more shared state before aggregation was even stable.

So I chose the simpler and safer MVP path: the poll and its shard set are born together.

## What Aggregation Does Now

During aggregation, the transaction consumes:

```text
one TallyShardCell
one or more pending VoteIntent cells assigned to that shard
```

and produces:

```text
updated TallyShardCell
aggregated marker cells for the consumed intents
```

The aggregated marker matters because the voter deposit remains in a live governance cell. The marker preserves refund semantics and records that the intent has already been counted.

The contract checks:

- the poll is still open
- the shard belongs to the poll
- the shard is not finalized
- each intent belongs to the same poll
- each intent's exact creation header is present and authenticates an epoch at or before the deadline
- each intent maps to that shard
- option index is valid
- voter has not already been counted in that shard
- the versioned compiled proof verifies every selected key is absent under the
  input root and present under the output root
- intent capacity is preserved in the marker
- shard capacity is preserved

The important point is that the poll cell is not consumed in this transaction.

The aggregation transaction itself may be committed after the deadline. That is intentional: inclusion time belongs to the intent being counted, while finalization closes the shard to further aggregation. A header supplied as `header_deps[0]` is caller-selected and is never treated as the chain tip.

## Why Close And Merge Became More Complex

Moving tally state out of the poll cell solves the hot aggregation bottleneck, but final close must still compute one final result.

For small shard counts, the protocol can close directly:

```text
CLOSE_POLL consumes:
  poll cell
  all finalized shard cells

CLOSE_POLL outputs:
  closed poll cell with final vote_counts
  creator return
  shard capacity returns
  included voter refunds
```

For large shard counts, consuming every shard in one close transaction can become too large. That is why the protocol has `MERGE_TALLY_SHARDS`.

Merge lets the protocol reduce many finalized shard cells into bounded merge result cells:

```text
finalized shards / merge results
  -> MERGE_TALLY_SHARDS
  -> TallyMergeResultCell
```

The merge result carries:

- poll identity
- shard coverage bitmap
- per-option vote totals
- total voters
- merge level
- version

Then the final close can consume one complete merge result instead of every shard.

## What The Frontend Should Show

The frontend should not naively sum every shard and merge result it sees. That can double-count.

It should display a canonical tally frontier:

```text
1. If a complete merge result exists, show that.
2. Otherwise, use disjoint merge results first.
3. Then fill uncovered shard ids with live shard cells.
4. Never count the same shard twice.
5. If coverage is incomplete, show that the displayed tally is partial.
```

This is implemented in `frontend/src/lib/protocolUi.ts` as `computeCanonicalTallyFrontier`.

The reason is practical. During a large-poll merge, shard cells are consumed and replaced by merge result cells. A direct shard-only UI can make the tally appear to drop. A naive "sum everything" UI can double-count. The frontier model is the middle path: it shows the best indexed non-overlapping view and tells the user whether it is complete.

## What This Does Not Solve

This design reduces aggregation contention. It does not solve every governance problem.

It does not prove vote completeness. If valid live intents remain unaggregated and shards are finalized, those omitted intents can be refunded after close, but their votes are not added to the final tally.

Final tally correctness is therefore over the intents actually aggregated. Completeness remains coordinator/indexer-dependent. Consuming applications define quorum, pass/fail thresholds, and decision policy; this protocol does not execute treasury actions automatically.

It does not provide privacy. Current vote intent data still exposes the option choice and voting authority information.

It does not give aggregators a protocol reward yet. Permissionless means anyone is authorized, not that anyone is paid. The testnet demo funds operator roles. Creator-funded maintenance budgets, managed operators, Fiber reimbursement, or protocol bounty cells are future work.

It does not prevent conflicting live intents at creation in testnet v1. All choices for one represented voter map to the same shard, so aggregation prevents double counting, but the first valid choice aggregated becomes canonical. A reviewed one-shot represented-principal authority is required before freezing the public SDK voting API.

It does not yet provide the intended real-funds delegation policy. In testnet v1, the delegate funds the intent capacity and the represented delegator receives the exact refund. The planned poll-scoped authority design keeps voting authority, committed capacity, and refund ownership with the represented principal.

It does not provide token- or capacity-weighted voting in the current deployment. New polls are equal-weight only; retained weighted fields exist for codec compatibility and historical-cell recovery.

It does not remove all contention. Same-shard aggregation still serializes on that shard cell. Finalization, merge, and close also have their own lifecycle dependencies.

## Why I Think This Is The Right Direction

I chose sharded aggregation because it is the most direct CKB-native answer to the bottleneck.

The previous structure made one cell carry too much responsibility:

```text
PollCell = metadata + live tally + counted voters + close state
```

The new structure separates responsibilities:

```text
PollCell = identity, metadata, lifecycle
TallyShardCell = live tally lane
TallyMergeResultCell = bounded final aggregation artifact
VoteIntentCell = voter submission and deposit/refund surface
```

That matches the CKB model better. State is explicit in cells. Independent state can be updated independently. Scripts verify transitions instead of pretending the chain has one mutable account object.

The cost is complexity: more cells, more lifecycle steps, more frontend states, and more indexing requirements. But that complexity is in service of the actual CKB constraint that caused the original problem.

## References

Official CKB resources:

- [CKB Cell Model](https://docs.nervos.org/docs/ckb-fundamentals/cell-model)
- [CKB transaction structure and transaction states](https://docs.nervos.org/docs/tech-explanation/transaction)
- [How CKB works](https://docs.nervos.org/docs/getting-started/how-ckb-works)
- [Script group execution](https://docs.nervos.org/docs/tech-explanation/script-group-exe)

Repository documents:

- [README.md](README.md)
- [Nervos sparse-merkle-tree](https://github.com/nervosnetwork/sparse-merkle-tree)

Timing references:

- [RFC 0017: transaction since](https://nervosnetwork.github.io/rfcs/rfcs/0017-tx-valid-since/0017-tx-valid-since.html)
- [RFC 0022: transaction header deps](https://nervosnetwork.github.io/rfcs/rfcs/0022-transaction-structure/0022-transaction-structure.html)
- [RFC 0009: VM syscalls](https://nervosnetwork.github.io/rfcs/rfcs/0009-vm-syscalls/0009-vm-syscalls.html)

Repository implementation:

- `backend/contracts-rust/contracts/governance/src/entry.rs`
- `backend/contracts-rust/contracts/governance/src/codec.rs`
- `backend/contracts-rust/contracts/governance/src/helpers.rs`
- `backend/contracts-rust/contracts/governance/src/constants.rs`
- `frontend/src/lib/ckb.ts`
- `frontend/src/lib/protocolUi.ts`
- `frontend/src/hooks/usePolls.ts`
- `backend/contracts-rust/integration-tests/tests/governance_vm.rs`
- `tests/ckb-helpers.test.ts`
- `tests/protocol-ui.test.ts`
