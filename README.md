# CKB Governance Protocol

[![CI](https://github.com/anihdev/ckb-voting-dapp/actions/workflows/ci.yml/badge.svg)](https://github.com/anihdev/ckb-voting-dapp/actions/workflows/ci.yml)

CKB Governance is a testnet governance voting and coordination protocol built around CKB cells. Voters submit independent vote intent cells instead of competing to mutate one poll cell. Permissionless operators aggregate timely intents into tally shards, finalize those shards, merge large shard sets, close polls, and recover deposits through contract-validated paths.

The Rust contract is authoritative:

- [entry.rs](backend/contracts-rust/contracts/governance/src/entry.rs) defines operation dispatch and validation.
- [codec.rs](backend/contracts-rust/contracts/governance/src/codec.rs) defines deployed byte layouts.
- [constants.rs](backend/contracts-rust/contracts/governance/src/constants.rs) defines opcodes and economic bounds.

This repository is testnet-only and has not received a formal security audit.

**Terminology.** A *tally lane* is the user-facing name for one deterministic tally cell. The contract codecs and opcodes retain *tally shard* (`TallyShardData`, `CREATE_TALLY_SHARD`, `shard_id`, `shard_count`). The two terms describe the same cell.

## Quick Start

```bash
# 1. Toolchains and dependencies (Ubuntu/Debian; see Local Development for other systems)
sudo apt-get update && sudo apt-get install --yes clang gcc-riscv64-unknown-elf
make setup

# 2. Environment: copy the template and fill in the deployed contract hashes
cp .env.example .env

# 3. Verify the checkout builds and passes every suite
make validate

# 4. Run the reference frontend against the configured RPC node
pnpm dev:frontend
```

`make validate` needs no keys or network writes. Only the [testnet rehearsal](#testnet-rehearsal) commands spend testnet CKB.

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
5. `CREATE_TALLY_SHARD` finalization freezes between one and eight ordered
   same-poll shards per transaction after the deadline.
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

### Counted-voter commitment

Each active tally lane stores one fixed 32-byte sparse-Merkle root instead of a
growing voter-hash list. The represented voter's `voter_lock_hash` is the tree
key; an absent voter has the zero value and a counted voter has 32 bytes of
`0x01`. During aggregation, the lane input witness carries a versioned compiled
multi-proof. The contract derives the selected keys from the consumed intents
and verifies that every key was absent under the input root and present under
the output root.

This keeps serialized lane size and occupied capacity constant as voters are
counted. It prevents the same represented-voter key from being counted again in
that lane, but it does not prove that every timely intent was selected for
aggregation. Proof construction happens off chain; the contract independently
verifies the submitted root transition and derives the affected voter keys from
the consumed intents.

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
counted_voter_lock_hashes # retained legacy poll field; empty for sharded polls
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
version                 # v2
poll_type_hash
shard_id
shard_count
vote_counts
total_voters
counted_voter_root      # fixed 32-byte sparse-Merkle commitment
finalized
```

Aggregation witness `input_type` contains:

```text
version                 # proof codec v1
compiled_proof          # bounded sparse-Merkle multi-proof
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
- fixed-size counted-voter sparse-Merkle commitments and versioned aggregation
  proofs;
- bounded one-to-eight-lane finalization with contract-validated absolute epoch
  `since` on every lane input;
- bounded merge and direct/merged close;
- creator close and permissionless force-close;
- exact capacity returns for shard, merge, and intent refund surfaces;
- immediate late-intent and post-close omitted-intent refunds;
- revocation-only delegation;
- frontend builders, indexing, lifecycle controls, and partial-tally disclosure;
- committed-state transaction tracking: broadcast actions remain confirming until CKB commitment, while timeouts remain explicitly unconfirmed;
- CKB-VM tests for lifecycle, timing, malformed data, authorization, capacity, and bypass attempts.
- integrated CKB-VM cycle coverage for 1, 10, 25, and 50-intent SMT
  aggregation, a 1,024-existing-voter lane, and eight-lane finalization;
- reproducible local and CI validation with separate contract-build and host-test Rust toolchains.

Incomplete or operationally limited:

- no protocol-funded maintenance incentive;
- lightweight RPC/indexer discovery rather than a dedicated production indexer;
- the browser proof provider reconstructs a lane from live aggregated markers;
  stale or incomplete index data fails closed, while a persistent proof/indexer
  provider remains future SDK work;
- no formal audit or mainnet support.

## Repository Layout

```text
ckb-voting-dapp/
├── README.md
├── SHARDED_AGGREGATION_EXPLAINED.md
├── Tally_lane_Sparse-merkle_ImplL.md
├── Governance_Ui_Clarity.md
├── OFFICIAL_DAO_BUILDER_SDK_GRANT_PROPOSAL.md
├── LICENSE
├── Makefile
├── .github/
│   └── workflows/ci.yml
├── backend/
│   ├── contracts-rust/
│   └── deploy/
├── frontend/
│   ├── src/
│   └── tally-smt-wasm/
├── scripts/
└── tests/
```

The tree is illustrative and omits generated output, lockfiles, and supporting
documents.

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
- GNU Make for the recommended command wrappers;
- the repository Rust `1.81.0` toolchain for reproducible contract builds;
- Rust `1.95.0` for host-side `ckb-testtool` integration tests and committed
  WASM adapter generation;
- `riscv64imac-unknown-none-elf` Rust target;
- `wasm32-unknown-unknown` on Rust `1.95.0` and `wasm-bindgen-cli 0.2.125` for
  reproducible browser/Node proof adapters;
- a RISC-V bare-metal C compiler providing `riscv64-unknown-elf-gcc`
  (`gcc-riscv64-unknown-elf` on Ubuntu/Debian);
- Clang for the C-backed sparse-Merkle verifier compiled into the contract.

Recommended setup on Ubuntu/Debian:

```bash
sudo apt-get update
sudo apt-get install --yes clang gcc-riscv64-unknown-elf
make setup
```

On other systems, install a compiler that provides `riscv64-unknown-elf-gcc` and
a Clang toolchain, then run `make setup`.

Equivalent manual setup:

```bash
corepack enable
pnpm install
rustup toolchain install 1.81.0 --profile minimal --component rustfmt --target riscv64imac-unknown-none-elf
rustup toolchain install 1.95.0 --profile minimal
rustup target add wasm32-unknown-unknown --toolchain 1.95.0
cargo +1.95.0 install wasm-bindgen-cli --version 0.2.125 --locked
sudo apt-get update
sudo apt-get install --yes clang gcc-riscv64-unknown-elf
```

### Environment

[`.env.example`](.env.example) is the authoritative list of supported variables,
including the optional non-Vite aliases and the code-cell recycling settings.
Copy it to `.env` and fill in the values. A first run needs only:

```env
VITE_GOVERNANCE_CODE_HASH=0x...
VITE_GOVERNANCE_SCRIPT_TX_HASH=0x...
VITE_CKB_RPC_URL=https://testnet.ckb.dev/
```

Deploy and rehearsal scripts additionally require `CKB_PRIVATE_KEY`. Never commit
private keys or environment files.

### Common commands

```bash
make setup      # install toolchains and dependencies
make check      # formatting, type, and whitespace checks
make test       # CKB-VM and TypeScript suites
make build      # WASM adapters, contract ELF, frontend bundle
make validate   # check, then test, then build
pnpm dev:frontend   # Vite dev server for the reference frontend
```

The Make targets group these underlying commands. `make validate` runs `check`,
`test`, and `build` in that order:

```bash
# make check
cargo +1.81.0 fmt --manifest-path backend/contracts-rust/Cargo.toml --all --check
pnpm check:contract:rust
pnpm --filter ckb-voting-deploy exec tsc -p tsconfig.json --noEmit
git diff --check

# make test
pnpm test:contract:vm
pnpm test:frontend

# make build
pnpm build:tally-smt-wasm
pnpm build:contract:rust
pnpm build:frontend
```

Continuous integration runs the same checks on every push and pull request. It
additionally rebuilds the sparse-Merkle WASM adapters and fails if the result
differs from the committed `frontend/src/lib/tally-smt-wasm-pkg` and
`backend/deploy/tally-smt-wasm-pkg` output, so regenerate and commit those
packages whenever the WASM crate or `wasm-bindgen` version changes. CI also
verifies that the release contract ELF contains no atomic instructions, which
CKB-VM does not support.

Dependency advisories are reported separately and are non-blocking:

```bash
pnpm audit --prod
```

### Testnet rehearsal

These commands broadcast transactions, create cells, and spend testnet CKB. They
require a funded `CKB_PRIVATE_KEY` and are not part of `make validate`.

```bash
pnpm --filter ckb-voting-deploy run roles        # print role addresses and balances
pnpm deploy:contract                             # build and deploy a new code cell
pnpm --filter ckb-voting-deploy run seed         # create demo polls
pnpm --filter ckb-voting-deploy run smoke        # single-actor lifecycle smoke run
pnpm --filter ckb-voting-deploy run setup:multi  # fund the multi-actor roles
pnpm --filter ckb-voting-deploy run smoke:multi  # multi-actor lifecycle smoke run
```

The `roles` command prints the configured testnet addresses and balances without
exposing their private keys. The `CKB_PRIVATE_KEY` row is the contract deployer;
fund only its `ckt1...` address for testnet deployment.

The smoke scripts cover create, intent, aggregation, and delegation/revocation.
They deliberately stop before post-deadline finalization and close.

## Deployment Status

The v2 tally-lane release was deployed as a new CKB testnet code cell on August
5, 2026. The historical code cell was not recycled.

- contract transaction: [`0x5a3ecd82...06ae9d5`](https://pudge.explorer.nervos.org/transaction/0x5a3ecd82853538347a3a6b48ef110f368062979f6cb88bbb9d4bcbb7306ae9d5);
- code-cell output index: `0`;
- committed block: `21,983,614`;
- deployed `data1` code hash: `0xb2c2ea67113fba954966700558ceb6121abb3935076c5165986d1586bcfbd954`;
- release ELF: `125,376` bytes, SHA-256 `6c1c3437e158ec075af12840d89cc2d84a9ff88a1aa86e8fd242047636f5a039`;
- production frontend: [ckb-voting-dapp.vercel.app](https://ckb-voting-dapp.vercel.app);
- Vercel deployment: `dpl_4MUiN1QZRfKQt7LcjBZ7GG2WPmnP`.

## Indexing And UI

The frontend discovers cells with scoped type-script queries:

- polls by the `CREATE_POLL` prefix;
- intents by exact `CREATE_VOTE_INTENT || poll_type_hash`;
- shards by `CREATE_TALLY_SHARD || poll_type_hash`;
- merge results by exact `MERGE_TALLY_SHARDS || poll_type_hash`;
- delegations by the `DELEGATE` prefix.

The UI distinguishes aggregated tally state, timely pending intents, late refundable intents, active revocation-based delegations, finalized shard coverage, merge progress, close readiness, and refund actions.

## Testing

The test suite executes the release RISC-V binary and covers, among other cases:

- stale caller-selected header dep regression;
- intent creation-header authentication with `Context::link_cell_with_block`;
- timely intent aggregation after the deadline;
- valid 1, 10, 25, and 50-intent sparse-Merkle root transitions, including a
  lane with 1,024 existing represented-voter keys;
- rejection of malformed proofs, wrong roots, duplicate/already-counted keys,
  and tally/marker mutations;
- valid one-lane and eight-lane batch finalization plus ordering, scope, count,
  output-shape, root, and per-input `since` failures;
- late intent rejection from aggregation and exact full-capacity refund;
- missing and wrong creation header deps;
- malformed, relative, wrong-metric, too-low, and overflowed `since`;
- valid shard finalization, creator close, and force-close `since`;
- direct rejection of retired opcode `0x03`;
- delegation creation/use with zero expiry;
- rejection of nonzero UDT configuration and disabled weighted-voting creation/aggregation paths, while preserving historical-cell recovery;
- direct and merged close, capacity returns, malformed codecs, and same-index bypass attempts.

## License

The contract, frontend, deployment tooling, and proposed SDK work are available under the [MIT License](LICENSE).

## References

- [CKB RFC 0017: transaction `since`](https://nervosnetwork.github.io/rfcs/rfcs/0017-tx-valid-since/0017-tx-valid-since.html)
- [CKB RFC 0022: transaction structure and header deps](https://nervosnetwork.github.io/rfcs/rfcs/0022-transaction-structure/0022-transaction-structure.html)
- [CKB RFC 0009: VM syscalls](https://nervosnetwork.github.io/rfcs/rfcs/0009-vm-syscalls/0009-vm-syscalls.html)
- [CKB Cell Model](https://docs.nervos.org/docs/ckb-fundamentals/cell-model)
- [Nervos sparse-merkle-tree](https://github.com/nervosnetwork/sparse-merkle-tree)
- [Pinned sparse-merkle-tree revision](https://github.com/nervosnetwork/sparse-merkle-tree/tree/725cd69d95e3e34cd302e83d86178e959fc53687)
- [Sharded aggregation explainer](SHARDED_AGGREGATION_EXPLAINED.md)
- [Tally lane sparse-Merkle implementation](Tally_lane_Sparse-merkle_ImplL.md)
- [Governance UI clarity pass](Governance_Ui_Clarity.md)
