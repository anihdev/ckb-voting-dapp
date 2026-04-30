# CKB Governance Protocol

Deposit-backed, UTXO-native governance on Nervos CKB built around vote intent cells, aggregation, delegation, and close-time refunds.

This repository is the protocol implementation, not a tutorial demo. The contract is the source of truth and the frontend mirrors that contract model.

## Table of Contents

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

Primary lifecycle:

1. Creator creates poll and locks creator deposit in the poll cell.
2. Voters (or delegates) submit vote intent cells with voter deposit and refund lock.
3. Aggregator batches pending intents, marks them aggregated, and updates poll tally state.
4. After deadline, poll closes and deposits are returned through validated outputs.
5. Delegation cells can be created and revoked independently.

`CLOSE_POLL` supports two closure modes:

- creator-authorized close after deadline
- permissionless force-close after `deadline + FORCE_CLOSE_GRACE_EPOCHS`

## Data Layout (Codec Truth)

Authoritative files:

- `backend/contracts-rust/contracts/governance/src/entry.rs`
- `backend/contracts-rust/contracts/governance/src/codec.rs`

### Poll Cell (`PollData`)

- `question: Vec<u8>`
- `options: Vec<Vec<u8>>`
- `vote_counts: Vec<u64>`
- `deadline: u64`
- `creator: [u8; 32]` (lock hash)
- `is_closed: bool`
- `total_voters: u64`
- `creator_deposit: u64`
- `pending_intent_count: u64`
- `counted_voter_lock_hashes: Vec<[u8; 32]>`
- `token_weighted: bool`
- `udt_type_hash: [u8; 32]` (reserved for future token-weighted extension)

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

## Current Implementation Status

Status reflects current repository behavior (April 2026 contract branch state):

- Rust governance contract implements all six opcode validators.
- Frontend transaction builders exist for all six operations.
- Frontend UI exposes create, vote intent, aggregate, close, force-close, delegate, revoke.
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
pnpm check:contract:rust      # cargo check for governance contract
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

The smoke script is testnet-facing and demonstrates the protocol flow with a private-key signer.

## Frontend and Indexing Behavior

Current off-chain discovery is lightweight and query-based:

- polls: type-script prefix search on `CREATE_POLL`
- intents: type-script exact search scoped by poll type hash
- delegations: type-script prefix search on `DELEGATE`

UI states show:

- aggregated tally (`vote_counts`)
- indexed pending intents
- authority options (self + delegated voter authorities)
- close and force-close eligibility by epoch

## Testing Scope

Test files in `tests/` currently focus on:

- codec round-trip invariants (`PollData`, `VoteIntentData`, `DelegationData`)
- protocol model invariants for aggregation/close/delegation behaviors

Current tests are not yet a full CKB-VM syscall harness for contract execution. They are useful for data/layout and model checks, but not sufficient alone for production-grade assurances.

## Known Tradeoffs and Limitations

- Intent submission reduces voter submission contention, but aggregation and close are still shared-state transitions that need coordination.
- `pending_intent_count` is not yet strict end-to-end accounting; close currently treats it as a lower-bound invariant.
- Token-weighted mode uses CKB-capacity weight units with a cap (`MAX_WEIGHT_UNITS_PER_INTENT`); xUDT-weighted voting is not implemented yet.
- Indexing is direct RPC/indexer querying and does not yet include a dedicated aggregation coordinator or historical analytics service.
- Tests do not yet provide exhaustive contract-level failure-path coverage for every opcode in a VM harness.

## Roadmap

### Phase 1: Repository honesty

- keep docs synchronized with real implementation status
- keep contract/frontend/test constants aligned

### Phase 2: Protocol parity hardening

- tighten pending intent accounting invariants
- expand end-to-end tests across all six operations
- keep frontend builders aligned with contract evolution

### Phase 3: Production-grade polish

- stronger indexing and UX state surfaces
- improved deployment and observability workflows
- clearer error reporting and transaction diagnostics

### Phase 4: CKB-native extensions

- xUDT-weighted voting
- abandoned poll recovery improvements
- richer proposal metadata flows
