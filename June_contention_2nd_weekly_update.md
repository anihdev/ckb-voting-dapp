# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 8th June, 2026 - 14th June, 2026

## Focus of the Week

This update covers the shift from a ZK-first interpretation of the governance bottleneck to a contention-first protocol implementation.

At the end of the previous phase, the working assumption was that Cecilia's `groth16-ckb` verifier, or a related Groth16/ZK integration, might be the main path for fixing the protocol's scalability and contention issues. After deeper review and implementation work, that assumption changed.

The conclusion this week is more precise:

- Groth16 can help prove that an aggregation step was computed correctly.
- Groth16 does not remove the CKB cell-model rule that one live cell can only be consumed by one transaction.
- If all aggregation still consumes the same poll cell, then all aggregators still compete for the same poll cell, even if the transition is ZK-proven.
- The real contention fix must change where mutable tally state lives.

The new implementation therefore keeps governance-locked vote intents, but moves active tally mutation out of the single poll cell and into deterministic tally shard cells. ZK remains relevant as a later correctness, compression, or privacy layer, but it is no longer treated as the first dependency for solving contention.

## Progress Summary

- Reframed the protocol roadmap from "ZK aggregation first" to "contention-first sharded aggregation first".
- Added the sharded tally cell model to the Rust contract and mirrored the layout in TypeScript codec/model code.
- Changed poll creation so `CREATE_POLL` atomically creates the poll cell and the complete ordered shard set.
- Added `CREATE_TALLY_SHARD` as the lifecycle family for shard creation, aggregation, and finalization.
- Added `MERGE_TALLY_SHARDS` for large polls that cannot close by consuming every finalized shard directly.
- Updated close logic so final results are derived from finalized shard data or a complete merge result, not from stale poll-cell vote counts.
- Preserved the governance-locked intent model from Phase B so third-party aggregation remains possible.
- Preserved refund safety for omitted pending intents and aggregated markers.
- Added CKB-VM/testtool runtime coverage for the current non-ZK protocol lifecycle.
- Hardened same-index lock/type dispatch so arbitrary unchanged type scripts cannot bypass governance lock validation.
- Updated documentation to separate what is VM-covered, what is model-only, and what remains runtime work.

## Why Groth16 Did Not Fix The Contention Problem

The previous ZK direction was useful, but it answered a different question than the one causing the live bottleneck.

Groth16 answers:

> Can a compact proof convince the contract that some computation was done correctly?

The contention problem asks:

> Can multiple aggregators update the same poll's tally at the same time without competing for the same live cell?

Those are not the same problem.

On CKB, a transaction updates state by consuming old cells and producing new cells. If a poll has one canonical mutable poll cell, then every aggregation transaction must consume that same current poll cell and produce the next version. Two aggregators cannot both consume the same live poll cell at the same time. One transaction wins, and the other becomes stale.

A Groth16 proof can make a single aggregation transition more trustworthy or possibly larger, but if that transition still updates the same poll cell, it remains serialized. The proof does not split the cell. It does not create parallel mutable state. It does not remove the UTXO conflict.

This is why Cecilia's verifier work is still valuable, but not as the immediate contention fix. It is verifier infrastructure. It can later help prove shard update correctness, prove final merge correctness, or support private/commitment-based voting. It does not, by itself, change the state layout that caused the bottleneck.

## Why The New Logic Fixes The Core Bottleneck

The new logic fixes contention by changing the state layout.

Instead of making every aggregation update the poll cell, the protocol now creates multiple tally shard cells for each poll. Each voter deterministically belongs to one shard:

```text
shard_id = blake2b256(poll_type_hash || voter_lock_hash) % shard_count
```

This means:

- voters still create independent vote intent cells
- the poll cell stores metadata and lifecycle configuration
- each shard stores only the tally data for voters assigned to that shard
- aggregators update shard cells instead of the poll cell
- two aggregators can work on different shards without touching the same mutable cell

That is the important CKB-native improvement. It reduces aggregation contention by splitting live tally state across multiple cells.

The remaining contention is now shard-local rather than poll-wide. If many aggregators try to update the same shard, they still compete for that shard cell. But aggregators working on different shards no longer compete on the poll cell.

## Known Limits

- The protocol still uses transparent vote intents, so it is not private voting.
- Post-close omitted intent refund protects deposits, not tally completeness.
- Pending intent accounting remains coordinator/indexer-dependent.
- Same-shard aggregation still has contention on that shard cell.
- Large polls require merge coordination before final close.
- Cecilia/Groth16 verifier integration has not been started.
- SubDAO, Mint Gate, xUDT-weighted governance, and private voting remain future extensions.

## Next Step

The immediate next step is to stabilize the sharded non-ZK lifecycle under realistic runtime conditions:

1. Run a controlled local devnet or testnet rehearsal for create poll, create intents, aggregate shards, finalize shards, merge large polls, close polls, and refund omitted intents.
2. Harden the frontend/indexer path so builders operate against live indexed cells with the same ordering assumptions as the contract.
3. Add randomized and adversarial testing around malformed data, same-index dispatch, shard assignment, merge coverage, capacity returns, and refund paths.
4. Only after those are stable, revisit Cecilia's `groth16-ckb` as a verifier PoC for shard update correctness or final merge verification.
