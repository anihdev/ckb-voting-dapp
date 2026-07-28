# CKB Governance Protocol

CKB Governance is a testnet governance voting and coordination protocol built around CKB cells. Voters submit independent vote intent cells instead of competing to mutate one poll cell. Permissionless operators aggregate timely intents into tally shards, finalize those shards, merge large shard sets, close polls, and recover deposits through contract-validated paths.

The Rust contract is authoritative:

- [entry.rs](backend/contracts-rust/contracts/governance/src/entry.rs) defines operation dispatch and validation.
- [codec.rs](backend/contracts-rust/contracts/governance/src/codec.rs) defines deployed byte layouts.
- [constants.rs](backend/contracts-rust/contracts/governance/src/constants.rs) defines opcodes and economic bounds.

This repository is testnet-only and has not received a formal security audit. It does not implement automatic treasury execution.

## Why CKB Cells

The protocol uses the cell model directly:

- poll identity and lifecycle are represented by a Type ID-backed poll cell;
- creator and voter deposits remain in cell capacity, measured in shannons with integer arithmetic;
- vote submissions are independent intent cells;
- mutable tally state is split across deterministic shard cells;
- delegation is a scoped authority cell;
- close and refund transactions make capacity returns explicit and auditable;
- RPC/indexer queries provide discovery without turning an off-chain service into the contract's authority.

Independent intent creation removes the direct voter-vs-voter shared-input bottleneck. Sharding reduces aggregation contention, but updates to the same shard still serialize.

## Executable Protocol

| Opcode | Operation | Status |
| --- | --- | --- |
| `0x01` | `CREATE_POLL` | Active |
| `0x02` | `CREATE_VOTE_INTENT` | Active |
| `0x03` | `RETIRED_AGGREGATE_VOTES` | Permanently reserved and rejected |
| `0x04` | `CLOSE_POLL` | Active |
| `0x05` | `DELEGATE` | Active |
| `0x06` | `RETIRED_REVOKE_DELEGATION` | Permanently reserved and rejected |
| `0x07` | `CREATE_TALLY_SHARD` | Active shard create/aggregate/finalize family |
| `0x08` | `MERGE_TALLY_SHARDS` | Active |

`AGGREGATE_VOTES` and non-sharded poll-cell aggregation are not executable in the new deployment. Opcodes `0x03` and `0x06` are tombstones and must never be reused. Delegation revocation remains active as the input-without-output destruction transition of an `0x05 DELEGATE` cell; it does not use a separate script family. Old testnet transactions remain historical records under the original `data1` code hash; the new frontend and newly hashed contract do not operate those cells.

### Lifecycle

1. `CREATE_POLL` creates the poll and its complete ordered tally-shard set atomically.
2. `CREATE_VOTE_INTENT` creates an independent governance-locked intent cell. The poll creator cannot submit an intent directly, delegate their own vote, or submit on behalf of another voter.
3. `CREATE_TALLY_SHARD` consumes timely pending intents for one shard, updates that shard, and creates aggregated intent markers.
4. Timely intents may be aggregated after the deadline until their shard is finalized.
5. `CREATE_TALLY_SHARD` finalization freezes each shard after the deadline.
6. Polls with at most eight shards close directly from the complete finalized shard set.
7. Larger polls use bounded `MERGE_TALLY_SHARDS` transactions and close from one complete merge result.
8. Delegation/revocation and intent refunds are independent side flows.

Shard assignment is deterministic:

```text
shard_id = blake2b_256(poll_type_hash || voter_lock_hash)[0..8] as LE u64
           % shard_count
```

## Timing Model

CKB scripts cannot read the epoch or timestamp of the block that will eventually include the transaction. A transaction also chooses its own `header_deps`, so header dep 0 is not authenticated current time.

The protocol therefore uses two different consensus-backed mechanisms.

### Intent cutoff

The canonical submission epoch is the block epoch that created the intent cell. When aggregation or immediate late refund consumes the intent:

- the builder includes that exact creation block in `header_deps`;
- the contract loads the header with `Source::Input`;
- aggregation accepts the intent only when its authenticated creation epoch is at or before the poll deadline;
- a late intent receives an exact full-capacity refund to its encoded `refund_lock`.

A transaction may be signed before the deadline and committed afterward. It is late because inclusion, not signing time, creates the cell.

`VoteIntentData.voted_at_epoch` remains in the codec to avoid a silent byte-layout change. It is caller-selected, non-consensus metadata and is not used for cutoff validation. New frontend builders write zero.

### Finalization and close

The exact protocol input at global input index 0 must carry a valid absolute epoch `since` lower bound:

- shard finalization: strictly after `deadline`;
- creator close: strictly after `deadline`;
- force-close: strictly after `deadline + FORCE_CLOSE_GRACE_EPOCHS`.

The contract parses the raw `since` flags and epoch fraction and rejects missing/zero, relative, wrong-metric, reserved-flag, malformed-fraction, too-low, and overflowed values. CKB consensus enforces maturity as a lower bound. `ckb-testtool` script verification does not run the node's complete `SinceVerifier`, so a controlled testnet rehearsal remains required for actual maturity behavior.

Poll `deadline` is an explicit absolute epoch. The contract validates that the value leaves room for finalization and force-close `since` bounds. The 1-1000 epoch duration range is builder/UI policy based on an observed tip, not an on-chain proof of the output transaction's future inclusion time. The creation form accepts hours, days, or epochs, rounds upward to a whole epoch, and uses CKB's four-hour target for approximate wall-clock copy; epoch values remain authoritative. The dashboard also reports the configured RPC node's tip and peer-derived sync target when available. That status describes the remote RPC node, not wallet synchronization.

### Delegation

Version 1 delegation is revocation-based. The existing `expires_epoch` codec field is retained, but the contract requires `expires_epoch == 0`. A delegate uses the live delegation cell as a cell dep; the delegator ends authority by consuming the `0x05 DELEGATE` cell without recreating it. The active frontend creates poll-scoped delegations; historical zero-scope testnet delegations remain visible and revocable. The UI calls this action "Revoke delegation," but retired opcode `0x06` is not emitted.

In the current testnet v1 flow, the delegate funds the delegated intent capacity while an eventual close or refund returns that exact capacity to the delegator. This is disclosed in the confirmation UI and is not the final real-funds SDK policy. The planned authority/permit design keeps voting authority, committed capacity, and refund ownership with the represented principal while the delegate supplies only transaction fees and the vote choice.

The creator exclusion compares CKB lock hashes. It establishes a strict proposer-versus-voter role boundary for the poll, but it is not proof of personhood and cannot prevent the same person from controlling another wallet.

## What The Tally Means

The finalized result is correct over the intents actually aggregated into the finalized shards. The protocol does not prove that every valid timely intent was aggregated before finalization.

Consequences:

- deposits remain recoverable through close, post-close omitted-intent refund, or immediate late-intent refund;
- a valid timely intent can be omitted, refunded, and absent from the final tally;
- vote completeness remains coordinator/indexer-dependent;
- consuming applications define quorum, pass/fail thresholds, and decision policy;
- no treasury action is automatically executed from a poll result.

Permissionless maintenance means any valid transaction author is authorized. It does not guarantee an operator has an economic incentive to pay fees. The current testnet demo funds operator roles. Creator-funded bounties, Fiber reimbursement, or managed operators are future work.

## Cell Data

### `PollData`

```text
question
options
vote_counts
deadline
creator
creator_lock
is_closed
total_voters
creator_deposit
pending_intent_count
counted_voter_lock_hashes
token_weighted
udt_type_hash
shard_count
```

### `VoteIntentData`

```text
poll_type_hash
voter_lock_hash
option_index
voted_at_epoch       # retained non-consensus metadata
aggregated
refund_lock
```

### `DelegationData`

```text
delegator_lock_hash
delegate_lock_hash
poll_type_hash
expires_epoch        # must be zero in v1
```

### `TallyShardData`

```text
poll_type_hash
shard_id
shard_count
vote_counts
total_voters
counted_voter_lock_hashes
finalized
```

### `TallyMergeResultData`

```text
poll_type_hash
coverage             # 256-bit shard bitmap
vote_counts
total_voters
merge_level
version
```

Each bounded merge consumes at most eight finalized shards or prior disjoint merge results. Direct close is capped at eight shards.

## Current Repository Status

Implemented:

- Type ID-backed poll creation with an atomic complete shard set;
- governance-locked direct and delegated vote intents;
- authenticated intent-origin cutoff checks;
- post-deadline aggregation of timely intents;
- shard finalization with contract-validated absolute epoch `since`;
- bounded merge and direct/merged close;
- creator close and permissionless force-close;
- exact capacity returns for shard, merge, and intent refund surfaces;
- immediate late-intent and post-close omitted-intent refunds;
- revocation-only delegation;
- frontend builders, indexing, lifecycle controls, and partial-tally disclosure;
- committed-state transaction tracking: broadcast actions remain confirming until CKB commitment, while timeouts remain explicitly unconfirmed;
- CKB-VM tests for lifecycle, timing, malformed data, authorization, capacity, and bypass attempts.

Incomplete or operationally limited:

- no proof of vote completeness;
- no protocol-funded maintenance incentive;
- lightweight RPC/indexer discovery rather than a dedicated production indexer;
- smoke scripts do not yet rehearse the full post-deadline finalize/merge/close path;
- the current contract and frontend are deployed on testnet only;
- no formal audit or mainnet support.

## Repository Layout

```text
ckb-voting-dapp/
├── README.md
├── SHARDED_AGGREGATION_EXPLAINED.md
├── OFFICIAL_DAO_BUILDER_SDK_GRANT_PROPOSAL.md
├── LICENSE
├── backend/
│   ├── contracts-rust/
│   └── deploy/
├── frontend/
│   └── src/
└── tests/
```

## Stack

- Rust, `ckb-std`, and the `riscv64imac-unknown-none-elf` target;
- `@ckb-ccc/core` and `@ckb-ccc/connector-react`;
- Vite, React, and TypeScript;
- pnpm workspaces;
- Vitest and `ckb-testtool`.

## Local Development

Prerequisites:

- Node.js 20.19 or newer;
- pnpm 10 or newer;
- the repository Rust toolchain;
- `riscv64imac-unknown-none-elf` Rust target.

```bash
corepack enable
pnpm install
rustup target add riscv64imac-unknown-none-elf
```

Frontend environment:

```env
VITE_GOVERNANCE_CODE_HASH=0x...
VITE_GOVERNANCE_SCRIPT_TX_HASH=0x...
VITE_CKB_RPC_URL=https://testnet.ckb.dev/
```

Deploy scripts also require `CKB_PRIVATE_KEY`. Never commit private keys or environment files.

To print the configured testnet role addresses and balances without exposing their private keys, run:

```bash
pnpm --filter ckb-voting-deploy exec ts-node -P tsconfig.json role-balances.ts
```

The `CKB_PRIVATE_KEY` row is the contract deployer. Fund only its `ckt1...` address for testnet deployment.

Useful commands:

```bash
cargo fmt --manifest-path backend/contracts-rust/Cargo.toml --all --check
pnpm check:contract:rust
pnpm build:contract:rust
cargo test --manifest-path backend/contracts-rust/Cargo.toml -p integration-tests
pnpm test:frontend
pnpm build:frontend
pnpm --filter ckb-voting-deploy exec tsc -p tsconfig.json --noEmit
pnpm audit --prod
```

## Deployment Status

The release was deployed to CKB testnet in transaction `0xe701cc3f...6ed571c` and the reference frontend was rebuilt against that deployment. The following are the relevant details:

- contract transaction: [`0xe701cc3f...6ed571c`](https://pudge.explorer.nervos.org/transaction/0xe701cc3ff439eda89b4ffb4b86db11f308b1ba89ef32a00f0aab7b6bd6ed571c);
- code-cell output index: `0`;
- deployed `data1` code hash: `0x126d92bd112caec39e1e3b4d453dab32374c4019879779c2898d552721f564e1`;
- production frontend: [ckb-voting-dapp.vercel.app](https://ckb-voting-dapp.vercel.app);

A controlled testnet lifecycle rehearsal still must:

1. create a poll and its complete shard set;
2. submit direct and delegated intents;
3. aggregate using authenticated intent creation headers;
4. wait for and exercise post-deadline shard finalization;
5. exercise direct close and the bounded merge-close path;
6. exercise creator close, permissionless force-close, and late/omitted-intent refunds;
7. publish the transaction hashes, epochs, capacity checks, and observed results.

The immediate smoke scripts cover create, intent, aggregation, and delegation/revocation only. They deliberately stop before post-deadline finalization and close.

## Indexing And UI

The frontend discovers cells with scoped type-script queries:

- polls by the `CREATE_POLL` prefix;
- intents by exact `CREATE_VOTE_INTENT || poll_type_hash`;
- shards by `CREATE_TALLY_SHARD || poll_type_hash`;
- merge results by exact `MERGE_TALLY_SHARDS || poll_type_hash`;
- delegations by the `DELEGATE` prefix.

The UI distinguishes aggregated tally state, timely pending intents, late refundable intents, active revocation-based delegations, finalized shard coverage, merge progress, close readiness, and refund actions. A complete indexed shard frontier is not described as vote-complete.

## Testing

The VM suite executes the release RISC-V binary and covers, among other cases:

- stale caller-selected header dep regression;
- intent creation-header authentication with `Context::link_cell_with_block`;
- timely intent aggregation after the deadline;
- late intent rejection from aggregation and exact full-capacity refund;
- missing and wrong creation header deps;
- malformed, relative, wrong-metric, too-low, and overflowed `since`;
- valid shard finalization, creator close, and force-close `since`;
- direct rejection of retired opcode `0x03`;
- delegation creation/use with zero expiry;
- direct and merged close, capacity returns, malformed codecs, and same-index bypass attempts.


## License

The contract, frontend, deployment tooling, and proposed SDK work are available under the [MIT License](LICENSE).

## References

- [CKB RFC 0017: transaction `since`](https://nervosnetwork.github.io/rfcs/rfcs/0017-tx-valid-since/0017-tx-valid-since.html)
- [CKB RFC 0022: transaction structure and header deps](https://nervosnetwork.github.io/rfcs/rfcs/0022-transaction-structure/0022-transaction-structure.html)
- [CKB RFC 0009: VM syscalls](https://nervosnetwork.github.io/rfcs/rfcs/0009-vm-syscalls/0009-vm-syscalls.html)
- [CKB Cell Model](https://docs.nervos.org/docs/ckb-fundamentals/cell-model)
- [Sharded aggregation explainer](SHARDED_AGGREGATION_EXPLAINED.md)
