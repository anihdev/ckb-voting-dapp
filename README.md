# CKB Governance Protocol

CKB Governance is a CKB-native voting protocol built around an intent-cell voting model. Instead of mutating a shared poll cell on each vote, participants create independent vote intent cells, and tally updates happen via explicit aggregation transactions. The protocol includes delegation cells, creator-close and permissionless force-close windows, and deposit-backed refund paths to ensure funds are returned under validated spend rules.

The repo intentionally evolves from a tutorial dApp toward a production-minded governance protocol implementation.

## Table of Contents

- [About](#about)
- [Why This Exists](#why-this-exists)
- [Protocol Model](#protocol-model)
- [Data Layout (Codec Truth)](#data-layout-codec-truth)
- [Current Implementation Status](#current-implementation-status)
- [Repository Structure](#repository-structure)
- [Tech Stack](#tech-stack)
- [Local Setup](#local-setup)
- [Environment Variables](#environment-variables)
- [Development Commands](#development-commands)
- [Deploy, Seed, and Smoke Test](#deploy-seed-and-smoke-test)
- [Frontend and Indexing Behavior](#frontend-and-indexing-behavior)
- [Testing Scope](#testing-scope)
- [Known Tradeoffs and Limitations](#known-tradeoffs-and-limitations)
- [Roadmap](#roadmap)

## About

CKB Governance Protocol is a cell-native governance system designed for Nervos CKB's UTXO model.

Instead of relying on shared mutable state for every vote, it separates governance into explicit on-chain artifacts:

- poll cells define proposal state and lifecycle windows
- vote intent cells record participant choices with refundable deposits
- delegation cells encode scoped authority between delegator and delegate

This architecture keeps economic backing on-chain, reduces voter submission contention, and makes lifecycle transitions auditable through cell consumption rules.

At a high level:

- creators open polls by locking capacity
- voters or delegates submit intent cells
- aggregators batch intents into tally updates
- close paths return deposits under validated spend conditions

The result is a protocol that demonstrates why CKB's cell model is a better fit for governance flows than account-style voting patterns.

## Why This Exists

Most voting apps map poorly to CKB if they rely on account-style shared mutable state. This protocol is designed around CKB cell lifecycle mechanics:

- creator stake is locked as poll cell capacity
- voter participation is represented as independent vote intent cells
- tally mutation is explicit and batched through aggregation
- delegation is a first-class on-chain cell
- close paths return deposits through validated spend rules

This reduces voter-vs-voter shared-cell contention in the submission path and keeps economic backing on-chain.

## Protocol Model

Contract opcodes:

1. `CREATE_POLL` (`0x01`)
2. `CREATE_VOTE_INTENT` (`0x02`)
3. `AGGREGATE_VOTES` (`0x03`)
4. `CLOSE_POLL` (`0x04`)
5. `DELEGATE` (`0x05`)
6. `REVOKE_DELEGATION` (`0x06`)
7. `CREATE_TALLY_SHARD` (`0x07`) - shard-cell family for the contention-first MVP
8. `MERGE_TALLY_SHARDS` (`0x08`) - bounded final merge/result flow

Primary lifecycle:

1. Creator creates poll, locks creator deposit in the poll cell, and atomically creates the complete tally shard set.
2. Voters (or delegates) submit vote intent cells with voter deposit and refund lock.
3. Aggregator batches pending intents for one tally shard, marks those intents aggregated, and updates that shard's tally state.
4. After deadline, each shard can be finalized by flipping its `finalized` flag without changing its tally.
5. `CLOSE_POLL` either consumes a complete finalized shard set for small polls or a final merge result for large polls, then derives final totals and returns deposits through validated outputs.
6. Delegation cells can be created and revoked independently. Delegated voting uses the live delegation cell as a read-only cell dep; the delegate signs with their own wallet auth input and does not consume the delegator's cell.

Contention-first MVP direction:

- poll cells remain the metadata and lifecycle anchor
- poll cells store canonical `shard_count`
- tally shard cells hold mutable `vote_counts`, `total_voters`, and counted voter registries
- vote intents keep governance-controlled locks and `refund_lock` ownership
- shard assignment is derived from `poll_type_hash || voter_lock_hash`; it is not stored in the intent
- shard uniqueness is anchored by atomic `CREATE_POLL` outputs; standalone post-poll shard creation is rejected
- legacy poll-cell aggregation is disabled for sharded polls; shard cells are the active aggregation state
- sharded close derives `vote_counts` and `total_voters` from finalized shard state rather than stale poll-cell fields
- direct all-shard close is capped at `MAX_DIRECT_CLOSE_SHARDS = 8`; larger polls must use a merge/result close path
- poll cells are protocol-locked with `CLOSE_POLL || poll_type_hash`, while creator authorization is proven by a separate creator auth input; this makes force-close permissionless after grace instead of blocked by the creator wallet lock
- intent creation rejects option indexes outside the poll option list and requires `voted_at_epoch` to equal the current header-dep epoch
- intent creation requires the `CREATE_VOTE_INTENT` type-script scope to match `intent.poll_type_hash`, so data and indexer scope cannot point at different polls
- signer authorization and Type ID seed inputs are selected from plain CKB cells only: no type script and empty output data
- frontend builders assert fixed input prefixes after CCC input/fee completion for transactions where the contract reads global input positions
- pending intent cells are not replaced by new pending cells; aggregation only changes a pending intent into an aggregated marker
- live intent cells omitted from close, including pending intents and aggregated markers, can be refunded after close through a standalone refund path against a closed poll cell dep. This protects deposits but does not prove the omitted vote was counted.

`CLOSE_POLL` supports two closure modes:

- creator-authorized close after deadline
- permissionless force-close after `deadline + FORCE_CLOSE_GRACE_EPOCHS`

## Data Layout

Authoritative files:

- `backend/contracts-rust/contracts/governance/src/entry.rs`
- `backend/contracts-rust/contracts/governance/src/codec.rs`

### Poll Cell (`PollData`)

- `question: Vec<u8>`
- `options: Vec<Vec<u8>>`
- `vote_counts: Vec<u64>`
- `deadline: u64`
- `creator: [u8; 32]` (lock hash)
- `creator_lock: EncodedScript` (creator wallet return/auth lock)
- `is_closed: bool`
- `total_voters: u64`
- `creator_deposit: u64`
- `pending_intent_count: u64`
- `counted_voter_lock_hashes: Vec<[u8; 32]>`
- `token_weighted: bool`
- `udt_type_hash: [u8; 32]` (reserved for future token-weighted extension)
- `shard_count: u32`

### Vote Intent Cell (`VoteIntentData`)

- `poll_type_hash: [u8; 32]`
- `voter_lock_hash: [u8; 32]`
- `option_index: u8`
- `voted_at_epoch: u64`
- `aggregated: bool`
- `refund_lock: EncodedScript`

### Delegation Cell (`DelegationData`)

- `delegator_lock_hash: [u8; 32]`
- `delegate_lock_hash: [u8; 32]`
- `poll_type_hash: [u8; 32]` (global when zero hash)
- `expires_epoch: u64` (0 = no expiry)

### Tally Shard Cell (`TallyShardData`)

- `poll_type_hash: [u8; 32]`
- `shard_id: u32`
- `shard_count: u32`
- `vote_counts: Vec<u64>`
- `total_voters: u64`
- `counted_voter_lock_hashes: Vec<[u8; 32]>`
- `finalized: bool`

Shard type args are `CREATE_TALLY_SHARD || poll_type_hash || shard_id(u32 LE)`. The same governance shard script must be used as both shard lock and type script so future third-party aggregation is protocol-authorized rather than private-lock authorized.

Canonical shard uniqueness comes from `CREATE_POLL`: output `0` is the poll, and outputs `1..=shard_count` must be shard ids `0..shard_count-1`. Standalone post-poll shard creation is rejected by the contract, including attempts authorized by an existing poll in `cell_deps`.

### Tally Merge Result Cell (`TallyMergeResultData`)

`MERGE_TALLY_SHARDS` is used for polls whose `shard_count` exceeds the direct-close cap. The result cell contains:

- `poll_type_hash: [u8; 32]`
- `coverage: [u8; 32]` bitmap for shard ids `0..255`
- `vote_counts: Vec<u64>`
- `total_voters: u64`
- `merge_level: u32`
- `version: u32`

Each merge step consumes up to `MAX_SHARDS_PER_MERGE = 8` finalized shard cells or prior merge result cells, rejects duplicate coverage, wrong-poll inputs, unfinalized shards, malformed totals, missing coverage, and overflow. Consumed shard/result capacity stays locked in the produced merge result cell; final close returns the final result cell capacity to the poll creator. Final close for large polls consumes the poll plus one complete final merge result cell rather than every shard.

## Current Implementation Status

Status reflects current repository behavior:

- Rust governance contract implements all six opcode validators.
- Rust contract now also defines the first sharded aggregation extension: canonical decoding, shard lock/type policy, atomic shard-set validation under `CREATE_POLL`, shard aggregation/finalization under `CREATE_TALLY_SHARD`, bounded `MERGE_TALLY_SHARDS`, capped direct finalized-shard close, and large-poll merge-result close under `CLOSE_POLL`.
- Frontend transaction builders exist for all six operations.
- Frontend codec mirrors `TallyShardData` and `TallyMergeResultData`, derives shard assignment, creates the shard set atomically in the create-poll builder, indexes shard/result cells, routes normal aggregation through shard updates, and requires finalized shards or a complete merge result before close.
- There is no exported standalone shard creation builder; normal flows create shards only through atomic poll creation.
- Frontend UI exposes create, vote intent, aggregate, close, force-close, delegate, revoke.
- Frontend UI also exposes shard finalization, bounded shard merge, and post-close omitted-intent refund actions where indexed state makes them available.
- Frontend delegation lists show revoke actions only for delegations where the connected wallet is the delegator; delegate-side authority records are read-only.
- Off-chain discovery uses indexer/RPC `findCells` queries for polls, intents, delegations.
- Shared frontend molecule codec mirrors contract byte layout.
- Deploy tooling is Rust-ELF based (`backend/deploy`), with optional code-cell recycling.
- Seeding and smoke scripts exist for testnet lifecycle exercises.

## Repository Structure

```text
ckb-voting-dapp/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── backend/
│   ├── contracts-rust/
│   │   └── contracts/governance/src/
│   │       ├── entry.rs
│   │       ├── codec.rs
│   │       ├── constants.rs
│   │       └── helpers.rs
│   └── deploy/
├── frontend/
│   └── src/
│       ├── lib/
│       ├── hooks/
│       └── components/
└── tests/
```

## Tech Stack

- Smart contract: Rust + `ckb-std` (`no_std`, CKB-VM target)
- Frontend: Vite + React + TypeScript
- CKB SDK: `@ckb-ccc/core` and `@ckb-ccc/connector-react`
- Package manager: `pnpm`
- Tests: Vitest (invoked through frontend workspace script)
- Hosting: Vercel (configured via `vercel.json`)

## Local Setup

Prerequisites:

- Node.js `>=20`
- `pnpm >=10`
- Rust toolchain `1.81.0`
- Rust target `riscv64imac-unknown-none-elf`
- Testnet CKB for deployment and transaction testing

Install:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm approve-builds
rustup target add riscv64imac-unknown-none-elf
```

## Environment Variables

Start from `.env.example`.

Required for frontend runtime:

```env
VITE_GOVERNANCE_CODE_HASH=0x...
VITE_GOVERNANCE_SCRIPT_TX_HASH=0x...
VITE_CKB_RPC_URL=https://testnet.ckb.dev/rpc
```

Required for deploy/seed/smoke scripts:

```env
CKB_PRIVATE_KEY=0x...
```

Optional deploy helpers:

```env
GOVERNANCE_ELF_PATH=../contracts-rust/target/riscv64imac-unknown-none-elf/release/governance-contract
PREVIOUS_CONTRACT_TX_HASH=0x...
PREVIOUS_CONTRACT_INDEX=0
PREVIOUS_CONTRACT_OUTPOINTS=0x...:0,0x...:0
```

## Development Commands

From repo root:

```bash
pnpm build                    # build rust contract + frontend
pnpm build:contract:rust      # cargo build for governance contract
cargo test --manifest-path backend/contracts-rust/Cargo.toml -p integration-tests
pnpm build:frontend           # vite build
pnpm dev:frontend             # local frontend dev server
pnpm test                     # frontend workspace test command
pnpm deploy:contract          # build + deploy script
```

## Deploy, Seed, and Smoke Test

### 1) Build and deploy contract

```bash
pnpm build:contract:rust
CKB_PRIVATE_KEY=0x... pnpm deploy:contract
```

Deployment prints:

- governance code hash (`VITE_GOVERNANCE_CODE_HASH`)
- governance script transaction hash (`VITE_GOVERNANCE_SCRIPT_TX_HASH`)

### 2) Optional: recycle previous code-cell capacity

```bash
PREVIOUS_CONTRACT_TX_HASH=0x... \
PREVIOUS_CONTRACT_INDEX=0 \
CKB_PRIVATE_KEY=0x... \
pnpm deploy:contract
```

or multiple recycled outpoints:

```bash
PREVIOUS_CONTRACT_OUTPOINTS=0x...:0,0x...:0 \
CKB_PRIVATE_KEY=0x... \
pnpm deploy:contract
```

### 3) Seed demo polls

```bash
pnpm --filter ckb-voting-deploy run seed
```

### 4) Run lifecycle smoke flow

```bash
pnpm --filter ckb-voting-deploy run smoke
```

The smoke script is testnet-facing and demonstrates poll creation, intent creation, shard aggregation, and delegation/revocation with a private-key signer. It intentionally does not send post-deadline shard finalization, `MERGE_TALLY_SHARDS`, or final close transactions yet; the large-poll merge/result close path needs a controlled local epoch smoke harness or a deliberate testnet wait window.

## Frontend and Indexing Behavior

Current off-chain discovery is lightweight and query-based:

- polls: type-script prefix search on `CREATE_POLL`
- intents: type-script exact search scoped by poll type hash
- delegations: type-script prefix search on `DELEGATE`
- tally shards: type-script prefix search on `CREATE_TALLY_SHARD || poll_type_hash`
- tally merge results: type-script exact search on `MERGE_TALLY_SHARDS || poll_type_hash`

UI states show:

- aggregated tally from summed shard `vote_counts` for sharded polls
- indexed pending intents
- authority options (self + delegated voter authorities)
- close and force-close eligibility by epoch
- post-close omitted-intent refund availability when live intent cells are still indexed
- poll registry quick actions: `Inspect`, `Copy Poll ID`, and `Delegate for this poll`
- delegation form prefill flow for per-poll scope (click from poll registry to prefill `poll_id`)

## Testing Scope

Test files in `tests/` currently focus on:

- codec round-trip invariants (`PollData`, `VoteIntentData`, `DelegationData`)
- protocol model invariants for aggregation/close/delegation behaviors
- deterministic integration-model coverage for a large sharded poll: create shards, aggregate intents, finalize shards, merge in bounded batches, and close from a complete merge result
- adversarial model coverage for fake merge outputs, wrong-poll merge close, incomplete merge close, extra tally/merge close inputs, and CCC-style fee inputs after the required close inputs
- lock-layer model coverage for protocol poll locks, creator-auth close, read-only delegation cell deps, delegation revocation, and post-close intent refunds

CKB-VM/testtool coverage has started under `backend/contracts-rust/integration-tests/` with `ckb-testtool = "1.1"`. The current VM slice executes the compiled `governance-contract` binary for:

- Type ID-backed `CREATE_POLL` with output `0`, Type ID seed input `0`, `CREATE_POLL || type_id` args, complete ordered shard creation, wrong Type ID args, and missing/misordered shard outputs
- protocol poll lock close behavior: `CLOSE_POLL || poll_type_hash`, creator-auth close, non-creator close rejection before grace, and permissionless force-close after grace using testtool header epochs
- `CREATE_VOTE_INTENT` with signer auth, open poll cell dep, intent lock/type scope, wrong poll hash, invalid option, bad `voted_at_epoch`, and wrong type args
- `CREATE_TALLY_SHARD` aggregation from pending intents into shard totals, marker output preservation, and rejection cases for wrong shard/poll, duplicate/already-counted voters, bad option, post-deadline aggregation, finalized shards, immutable mutation, and bad marker outputs
- `CREATE_TALLY_SHARD` post-deadline finalization, including pre-deadline, tally-mutation, and wrong-poll-dep rejection
- direct small-poll close from finalized shard inputs, including final tally derivation from shards, exact creator/shard/intent refund capacity, missing/duplicate/wrong/unfinalized/extra shard rejection, large direct-close rejection, and force-close after grace
- `MERGE_TALLY_SHARDS` bounded merge-result creation, including coverage bitmap, summed totals, exact merge lock/type, capacity preservation, and rejection cases for unfinalized/wrong-poll/duplicate coverage/wrong totals/wrong scripts/extra output/too many inputs
- large-poll close from a complete merge result, including incomplete/wrong-poll/wrong-total/extra-input rejection and exact merge-result capacity/lock return checks
- adversarial same-index lock/type dispatch checks: arbitrary unchanged type updates cannot satisfy governance `CLOSE_POLL`, `CREATE_VOTE_INTENT`, `CREATE_TALLY_SHARD`, or `MERGE_TALLY_SHARDS` locks, and wrong governance-op type updates are rejected for shard/merge locks
- delegated vote intent creation through a read-only delegation cell dep, targeted missing/expired/wrong-delegate/wrong-scope delegation failures, and separate delegator-authorized revocation with lock/capacity preservation
- post-close omitted-intent refunds for pending intents and aggregated markers, including wrong-poll rejection and full consumed-capacity return
- focused codec canonicality failures for trailing bytes and invalid boolean encodings that reach contract decode in CKB-VM
- legacy `AGGREGATE_VOTES` behavior: rejected for sharded polls and still accepted for non-sharded historical poll cells

## Known Tradeoffs and Limitations

- Intent submission reduces voter submission contention, and shard aggregation removes the poll cell as the live tally bottleneck. Same-shard batches still contend on that shard cell.
- The legacy `AGGREGATE_VOTES` path is explicitly retained only for non-sharded historical poll cells and rejected for sharded polls; direct sharded close is valid only for `shard_count <= 8`, with bounded merge/result cells implemented for larger shard sets.
- `MAX_TALLY_SHARDS = 256` is the upper protocol shard configuration, not a promise that 256 shards can be closed in one direct transaction.
- Standalone `CREATE_TALLY_SHARD` is rejected after poll creation; canonical shard uniqueness is enforced by atomic poll creation.
- Poll identity now uses Type ID-derived `CREATE_POLL` args. The contract validates `CREATE_POLL || type_id` with the Type ID seed at input `0` and poll output index `0`; frontend and smoke builders pin that seed input before deriving `poll_type_hash`, shard scripts, merge-result scope, close locks, and refund anchors.
- Auth-only inputs, including the Type ID seed and creator/voter/delegate signer auth cells, must be plain CKB cells. Wallets need at least one untyped, empty-data CKB cell for these flows.
- Protocol return outputs are exact where safe: creator deposit returns equal `creator_deposit`, shard and merge-result capacity returns equal the consumed input capacity, and close/post-close intent refunds equal the consumed intent cell capacity. Closed poll cell capacity remains flexible enough to satisfy occupied-capacity requirements.
- Post-close omitted-intent refund is a deposit-safety mechanism, not a vote-completeness proof. A valid submitted intent can be omitted from aggregation, refunded after close, and still not be included in the final tally.
- `pending_intent_count` is not yet strict end-to-end accounting; close currently treats it as a lower-bound invariant. Current guarantee: deposits are recoverable through validated refund paths. Current limitation: tally completeness is coordinator/indexer-dependent until the protocol adds strict on-chain pending accounting, per-shard pending registries, a canonical intent commitment with a proof/indexer model, or later ZK-assisted completeness proofs.
- Current ZK completeness research is tracked in `ZK_COMPLETENESS_DESIGN.md`; deterministic TypeScript model helpers now cover normalized intent records, live-intent normalization, per-shard/window commitment roots, commitment-set hashing, and public-input packing, but there is no Groth16 verifier integration or on-chain vote-completeness guarantee yet. The older `zk_plan.md` is retained only as historical context for pre-sharding aggregation work.
- Token-weighted mode uses CKB-capacity weight units with a cap (`MAX_WEIGHT_UNITS_PER_INTENT`); xUDT-weighted voting is not implemented yet.
- Indexing is direct RPC/indexer querying and does not yet include a dedicated aggregation coordinator or historical analytics service.
- VM tests now cover the current non-ZK sharded lifecycle at the lock/type-script level, but they are still a focused harness rather than a full devnet deployment rehearsal. Frontend builder parity, indexer behavior under live RPC conditions, broad randomized/fuzz malformed-data coverage, and operational aggregation coordination still need more validation before production readiness claims.

## Roadmap

### Phase 0: Runtime Confidence Upgrade

- started: separate `backend/contracts-rust/integration-tests/` crate using `ckb-testtool = "1.1"` and the built `target/riscv64imac-unknown-none-elf/release/governance-contract` binary
- covered in VM: Type ID-backed poll creation, vote intent creation, read-only delegation voting, revocation, shard aggregation, shard finalization, direct small-poll close, bounded merge results, large-poll merge-result close, post-close refunds, adversarial same-index lock/type bypass rejection, legacy non-sharded aggregation compatibility, and focused malformed-codec/capacity/authorization failures
- remaining runtime work: controlled local devnet rehearsal, frontend transaction-builder parity against live RPC/indexer data, broader malformed-data/property coverage, and aggregation coordinator/indexer operational tests
- do not claim production runtime confidence until VM coverage is paired with controlled local devnet or testnet rehearsal of the same lifecycle

### Phase 1: CKB-native extensions

- xUDT-weighted voting
- abandoned poll recovery improvements
- richer proposal metadata flows

### Phase 2: Fiber-incentivized aggregation (optional)

- add an optional Fiber fee path for aggregation services
- allow voters to pay tiny off-chain aggregation fees to operator nodes
- preserve full on-chain deposit refunds (no voter deposit haircut)
- create an open aggregation market to improve tally freshness and reduce close-time backlog
- keep a manual/no-Fiber path for wallets without Fiber support

### Phase 3: ZK eligibility proofs (optional, later-stage)

- use `ZK_COMPLETENESS_DESIGN.md` as the current design source for transparent vote-completeness research before any privacy work
- decide verifier composition before implementation: embedded governance/ZK verifier logic versus a separate verifier-trigger cell bound to a public-input hash
- evaluate a private-eligibility poll mode when governance controls real value
- keep tallies and governance outcomes public while hiding voter-to-choice linkage
- treat this as a mainnet-era extension, not a testnet requirement
- only proceed once cryptographic assumptions, tooling, and audit scope are mature
