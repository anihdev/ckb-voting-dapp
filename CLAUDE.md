# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

Testnet CKB governance voting protocol: a Rust on-chain contract (CKB-VM/RISC-V), a React reference frontend, and TypeScript deploy/smoke tooling. Voters submit independent vote-intent cells rather than contending on one poll cell; permissionless operators aggregate intents into deterministic tally shards ("lanes"), finalize them, merge large shard sets, close polls, and recover deposits through contract-validated paths.

Testnet only, no formal audit, no automatic treasury execution. The near-term direction is extracting the working protocol into a reusable DAO/SubDAO builder SDK, so prefer small protocol-aligned changes over speculative abstractions. ZK/private voting, reputation weighting, and treasury execution are out of scope.

## Commands

Setup and full validation go through the Makefile:

```bash
make setup      # toolchains + pnpm install --frozen-lockfile
make check      # rustfmt, cargo check, deploy tsc --noEmit, git diff --check
make test       # CKB-VM integration tests + frontend/Vitest suite
make build      # SMT WASM adapters, release contract ELF, frontend bundle
make validate   # check + test + build; run before declaring work done
```

Narrower loops:

```bash
pnpm dev:frontend                # Vite dev server
pnpm test:frontend               # all Vitest tests (root-scoped)
pnpm test:contract:vm            # rebuilds contract, then ckb-testtool tests
pnpm check:contract:rust         # fast cargo check of the contract
pnpm build:tally-smt-wasm        # regenerate both WASM proof adapters
```

Single tests:

```bash
# One Vitest file or test name (Vitest root is the repo root)
pnpm --filter ckb-voting-frontend exec vitest run --root ../.. tests/molecule.test.ts
pnpm --filter ckb-voting-frontend exec vitest run --root ../.. -t "tally frontier"

# One CKB-VM test
cargo +1.95.0 test --locked --manifest-path backend/contracts-rust/Cargo.toml \
  -p integration-tests create_poll_type_id_and_complete_shards_pass
```

Deploy tooling (needs `.env` with `CKB_PRIVATE_KEY`, never commit it):

```bash
pnpm --filter ckb-voting-deploy run deploy       # deploy contract code cell
pnpm --filter ckb-voting-deploy run seed         # seed testnet polls
pnpm --filter ckb-voting-deploy run smoke        # single-actor smoke run
pnpm --filter ckb-voting-deploy run smoke:multi  # multi-actor smoke run
```

## Toolchain constraints

Two Rust toolchains are deliberate. `1.81.0` builds the contract for `riscv64imac-unknown-none-elf` so the deployed ELF stays reproducible; `1.95.0` runs host-side `ckb-testtool` tests and builds the `wasm32-unknown-unknown` proof adapters. Do not collapse them. `clang` is required for the C-backed sparse-Merkle verifier compiled into the contract, `riscv64-unknown-elf-gcc` for the contract link, and `wasm-bindgen-cli` must be exactly `0.2.125` — CI rebuilds the WASM packages and fails on any diff against the committed output.

pnpm workspaces only (`frontend/src`, `backend/deploy`). Stack is `@ckb-ccc/core` / `@ckb-ccc/connector-react`, Vite, React 18, Vitest, `ckb-testtool`. Do not introduce Lumos, Jest, or another package manager.

## Architecture

The Rust contract is the protocol authority. Everything else mirrors it:

- [entry.rs](backend/contracts-rust/contracts/governance/src/entry.rs) — opcode dispatch and all validation
- [codec.rs](backend/contracts-rust/contracts/governance/src/codec.rs) — deployed byte layouts
- [constants.rs](backend/contracts-rust/contracts/governance/src/constants.rs) — opcodes and economic bounds
- [helpers.rs](backend/contracts-rust/contracts/governance/src/helpers.rs) — timing, script, capacity, hashing

TypeScript mirrors live in [constants.ts](frontend/src/lib/constants.ts) (opcodes, deposits, shard/merge limits) and [molecule.ts](frontend/src/lib/molecule.ts) (cell codecs). When these disagree with Rust, Rust wins.

Frontend layering:

- [ckb.ts](frontend/src/lib/ckb.ts) — every CCC transaction builder (`buildCreatePollTx`, `buildCreateVoteIntentTx`, `buildAggregateTallyShardTx`, `buildFinalizeTallyShardsTx`, `buildMergeTallyShardsTx`, `buildClosePollTx`, `buildForceCloseTx`, refund and delegation builders) plus script/lock derivation and `since` encoding
- [protocolUi.ts](frontend/src/lib/protocolUi.ts) — pure lifecycle/presentation logic: lifecycle filters, tally-frontier selection, refund selection, duration conversion, outcome derivation
- [usePolls.ts](frontend/src/hooks/usePolls.ts) — indexer discovery and action orchestration
- [tallySmt.ts](frontend/src/lib/tallySmt.ts) — browser proof provider over the generated WASM package
- [txLifecycle.ts](frontend/src/lib/txLifecycle.ts) — confirmation state machine

Opcode namespace: `0x01` CREATE_POLL, `0x02` CREATE_VOTE_INTENT, `0x04` CLOSE_POLL, `0x05` DELEGATE, `0x07` CREATE_TALLY_SHARD (create/aggregate/finalize), `0x08` MERGE_TALLY_SHARDS. `0x03` and `0x06` are permanent tombstones that must be rejected and never reused.

## Protocol rules that constrain edits

Timing. CKB scripts cannot read the inclusion block's time. Intent timeliness is authenticated from the consumed intent cell's creation header via `Source::Input` — never from caller-selected `header_deps[0]`. Finalize, creator-close, and force-close pin the protocol input at global index 0 and require an absolute-epoch `since` lower bound; force-close only after `deadline + FORCE_CLOSE_GRACE_EPOCHS`.

Tally lanes. Each v2 shard stores a fixed 32-byte `counted_voter_root` (sparse Merkle), not a growing voter list. Aggregation carries one versioned compiled multi-proof in the lane input's `input_type` witness; the contract derives voter keys from intent inputs and proves absent→present transitions. The browser provider reconstructs the tree from live aggregated markers and must fail closed when its root differs from the indexed lane root. Preserve the pinned upstream SMT revision, CKB Blake2b personalization, direct voter-hash keys, zero absence, fixed present value, and codec/proof versions.

Shard assignment is `blake2b_256(poll_type_hash || voter_lock_hash)[0..8] as LE u64 % shard_count` — mirrored in `deriveTallyShardId`.

Invariants that must not drift: opcodes, economic constants, field order and encoding, shard/merge limits, assignment hash, `since` rules, input/output ordering, and capacity/refund arithmetic (always `bigint`/`u64` shannons, never floating point). Exact refund and protocol-return outputs must precede wallet-added fee/change outputs, and protocol inputs must be re-pinned after fee completion.

New polls are equal-weight only (`token_weighted` false, zero `udt_type_hash`); weighted paths exist for historical-cell recovery only.

Known limitations to keep disclosed rather than paper over: no proof of vote completeness, no proof that a represented voter has only one live intent, delegate-funded delegated intents refunding to the delegator, no maintenance incentive, no treasury execution, no audit, testnet only.

## Contract-led change discipline

A protocol change touches all of these in one pass: Rust entry/codec/constants/helpers, TypeScript constants and Molecule codec, frontend builders, deploy and smoke builders, browser and Node SMT adapters, UI lifecycle and role gates, CKB-VM plus focused TypeScript tests, and README/protocol docs.

## Testing ownership

Use the narrowest authoritative layer. CKB-VM tests ([governance_vm.rs](backend/contracts-rust/integration-tests/tests/governance_vm.rs)) own contract authorization, lifecycle, malformed transactions, capacity, lock/type interaction, and timing. [tests/molecule.test.ts](tests/molecule.test.ts) owns codec round trips and canonical byte layout. [ckb-builders.test.ts](frontend/src/lib/ckb-builders.test.ts) owns input pinning, header deps, `since`, and fee completion against real CCC builders. [tests/protocol-ui.test.ts](tests/protocol-ui.test.ts) and component tests own lifecycle filters, frontier/refund selection, and presentation state. Do not reimplement the Rust validator as a TypeScript model in order to test the model — extend a VM test instead.

`ckb-testtool` does not run the node's full `CapacityVerifier` or `SinceVerifier`, so VM success is not a transaction-admission claim; host occupied-capacity tests and real-node rehearsal still matter.

Current baseline: 72 governance CKB-VM tests, 167 focused TypeScript/React/deploy tests.

## Repo notes

Private maintainer Markdown belongs under the ignored `docs/private/` directory; the root `AGENTS.md` entry is ignored separately. Public Markdown elsewhere remains trackable normally. Weekly-update files are dated snapshots and never override current code. The worktree is often dirty with in-progress changes — inspect it before editing and do not revert unrelated work. Keep comments brief and explain only non-obvious protocol reasons. Prefer structured codecs and CKB/CCC APIs over ad hoc byte manipulation.
