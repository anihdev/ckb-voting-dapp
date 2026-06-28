# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 15th June, 2026 - 21st June, 2026

## Focus of the Week

This update covers the shift from a protocol-only governance implementation toward a reusable DAO/SubDAO Builder SDK direction.

The previous report closed with a stable non-ZK sharded governance lifecycle and a clear understanding that Groth16/ZK is not the immediate path for solving CKB cell contention. The open question after that work was how to position the project so the CKB community can understand why the protocol matters beyond a standalone voting app.

The conclusion this week is that the project should not be framed as just another DAO app. It should be framed as reusable governance infrastructure:

```text
CKB DAO Builder SDK
  -> governance contracts
  -> TypeScript transaction builders
  -> React hooks/components
  -> membership eligibility adapters
  -> reference dashboard
  -> integration documentation
```

This keeps the current governance protocol as the foundation, while making the work easier for other CKB apps to integrate. Mint Gate is the clearest first integration target, but the SDK should not depend on Mint Gate being production-ready before this project can progress.

## Progress Summary

- Reviewed Neon's recommendation that a standalone DAO governance app may need stronger context to gain community support.
- Reframed the project from "SubDAO governance app" to "DAO/SubDAO Builder SDK".
- Created a focused SubDAO collaboration plan to capture the Mint Gate integration path.
- Created an authoritative grant-scope note that keeps ownership under the CKB Governance Protocol while treating Mint Gate as a first integration target.
- Added the missing CKBDAO v2 and Nervos Talk on-chain tally discussion references to the proposal.
- Clarified that Mint Gate is still under active development/testnet and is not a hard dependency for the SDK.
- Added `SHARDED_AGGREGATION_EXPLAINED.md` as a plain-language design note explaining why the protocol moved away from poll-cell aggregation and what a "shard" means in this project.
- Fixed a small mobile UI issue where long protocol operation labels such as `CREATE_VOTE_INTENT`, `CREATE_TALLY_SHARD`, and `REVOKE_DELEGATION` could overlap in the Protocol Timeline block.

## What Was Not Covered From Phase D

The previous report listed several runtime stabilization items as next steps. Those are still important, but they were not the main work this week.

Still open from Phase D:

- controlled local devnet or testnet rehearsal for the full sharded lifecycle
- frontend/indexer parity testing against live indexed cells
- broader randomized malformed-data coverage
- operational aggregation/indexer testing
- production-style testing around stale indexer states and maintenance flows

Those remain protocol-hardening work. This week instead focused on the grant narrative and SDK direction so the project can be positioned correctly before the next implementation phase.


## Ecosystem Context Reviewed

I reviewed and incorporated the following ecosystem context into the proposal direction:

- **Mint Gate**: token-gating and membership platform under active development/testnet. Useful first integration target, but not a dependency.
- **CKBuilder projects**: community builder/grant context where Mint Gate and similar projects are being reviewed.
- **Vellum / did:ckb reputation**: future identity and reputation adapter surface for proposal rights, reviewer roles, or voting eligibility.
- **CKBoost**: campaign/contribution surface that can later produce reputation signals.
- **Spore**: future holder/membership eligibility surface, not a default v1 dependency.
- **CKBDAO v2**: governance-design context around DAO rules, delegation, treasury, address binding, and portal concepts.
- **Nervos Talk on-chain tally discussion**: directly relevant to vote-meta cell contention, intent cells, and deposit-paired voting.
- **Cecilia's `groth16-ckb` and `ckb-vote-poc`**: retained as earlier ZK/vote-completeness research, but explicitly out of scope for the DAO Builder SDK grant phase.

## Current Proposal Direction

The grant proposal now focuses on:

1. SDK architecture spec
2. Core TypeScript governance SDK
3. React integration layer
4. Membership eligibility adapter
5. SubDAO reference dashboard
6. Testnet demo and integration guide

The first membership adapter should target membership cells because they are CKB-native and match the Mint Gate review direction: chain-confirmed membership should be authoritative, while any database should be treated as a cache/search layer.

The proposal explicitly keeps these out of scope for the first grant phase:

- ZK/Groth16 verifier integration
- private voting
- reputation-weighted voting
- automatic treasury execution
- xUDT or NFT membership as the default model
- marketplace or membership resale
- on-chain chat
- full DID/Vellum/CKBoost integration as a v1 dependency

## Frontend Polish

One small UI issue was fixed before continuing the grant planning work.

The Protocol Timeline block used long operation names. On mobile layouts, labels such as `CREATE_VOTE_INTENT`, `CREATE_TALLY_SHARD`, and `REVOKE_DELEGATION` could overlap inside the timeline grid.

The fix moved the operation label styling into a dedicated `.protocol-op` class and added wrapping rules so long labels can break inside their grid cell.

Verified commands:

- `pnpm test:frontend`
- `pnpm build:frontend`
- `git diff --check -- frontend/src/App.tsx frontend/src/governance.css`

## Known Limits

- The SDK proposal is now drafted, but the SDK package/module split has not been implemented yet.
- The membership adapter interface is still a design target, not a shipped module.
- Mint Gate integration has not started.
- DID/reputation integration has not started.
- CKBoost and Spore are future alignment points only.
- ZK/Groth16 remains deferred.
- The full local devnet/testnet rehearsal from Phase D remains open.
- Some proposal markdown files are newly unignored and still need to be added to git before links to GitHub will work.
- `Proposal.md` contains unrelated hackathon text from a separate thread and should be cleaned or separated before sharing broadly.

## Next Step

The immediate next step is to convert the SDK proposal into an implementation spec:

1. Create `DAO_BUILDER_SDK_SPEC.md`.
2. Define the module/package boundary for:
   - core protocol builders
   - shared codecs/constants
   - React hooks
   - reusable UI components
   - membership eligibility adapters
3. Decide what remains monorepo-local versus what should later become publishable packages.
4. Define the first `MembershipAdapter` interface and a self-seeded membership-cell demo adapter.
5. Keep Mint Gate as the preferred first external integration target, but do not block on it.
6. Resume runtime hardening from Phase D after the SDK boundary is clear.
