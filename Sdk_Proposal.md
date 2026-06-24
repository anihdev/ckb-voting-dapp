# CKB DAO Builder SDK — Grant Proposal

## Overview

This project will turn the existing CKB Governance Protocol into a reusable DAO/SubDAO builder SDK for CKB applications.

CKB already has general developer SDKs such as CCC and Lumos, and emerging community/membership apps such as Mint Gate. What does not yet exist is a shared, reusable governance layer: a kit that gives any CKB community app the primitives it needs for proposal creation, voting, delegation, tally aggregation, finalization, and deposit-safe refunds without building those pieces from scratch every time.

The SDK will package the current protocol work into integration-ready modules: governance contracts, TypeScript transaction builders, React hooks and components, membership eligibility adapters, documentation, and a reference dashboard. The goal is an infrastructure that CKB community apps can plug governance into directly.

Mint Gate-style membership communities are the clearest first integration target, but the SDK is designed to remain useful for other CKB community surfaces: builder collectives running CKBuilder grants, fellowship communities, CKBoost platform, Spore/NFT-holder groups, and future DID/reputation-gated communities that Vellum is building toward.

## The Problem

CKB has strong primitives for cell-based ownership, capacity-backed deposits, application-specific scripts, and emerging identity infrastructure. But community apps that want governance today still face the same hard problems:

- how to represent proposals as CKB-native state
- how to prove who is eligible to vote
- how to avoid shared-cell contention during vote submission and tallying
- how to support delegation without custodial authority transfer
- how to let third parties maintain stalled governance flows
- how to recover deposits in abandoned or partially maintained proposals
- how to expose these mechanics through a frontend without forcing every user to understand opcodes and script groups

This affects real active surfaces in the CKB ecosystem today. Mint Gate communities need governance once members exist. CKBuilder grant communities need structured proposals and votes. CKBoost campaigns produce contributors who will later need decision-making mechanisms. Vellum's DID/reputation layer needs governance surfaces where identity and reputation can become eligibility inputs. None of these projects should have to implement the same cell-contention solutions and deposit-recovery paths independently.

This grant proposes a reusable builder kit so CKB apps can integrate governance as infrastructure rather than as one-off application.

## What Already Exists

The repository already implements the core non-membership governance protocol on CKB:

- **Type ID-backed proposal identity** — each proposal/poll is a uniquely identifiable on-chain object.
- **Vote intent cells** — votes are submitted as independent cells with refundable capacity, instead of mutating one shared proposal cell per vote.
- **Sharded tally aggregation** — votes are assigned to tally lanes and aggregated independently, reducing contention for larger proposals.
- **Bounded merge-close** — large proposals reduce finalized tally lanes into merge result cells before close.
- **Delegation and revocation cells** — voting authority can be delegated and revoked through explicit cells.
- **Permissionless maintenance** — aggregation, finalization, merge, force-close, and omitted-intent refund are not limited to the proposal creator.
- **Deposit-safe recovery paths** — creator and voter deposits remain CKB capacity and are returned through validated close, force-close, and post-close refund paths.
- **Frontend reference implementation** — the app already exposes create, vote, aggregate, finalize, merge, close, force-close, delegate, revoke, and refund surfaces.
- **CKB-VM/testtool coverage** — core lifecycle behavior is covered by runtime-oriented tests.

This grant does not start from zero. It funds the packaging and extension needed to make the existing protocol usable/reusable by other CKB applications.

## Design Principle: Builder Kit, Not Standalone DAO App

The project is framed as a builder kit:

```text
CKB DAO Builder SDK
  -> protocol contracts
  -> TypeScript transaction builders
  -> React hooks/components
  -> membership eligibility adapter
  -> reference dashboard
  -> integration docs
```

The current web app becomes the reference implementation. Other applications should be able to use the lower-level modules without copying the entire frontend. The SDK modules will be structured for extraction into standalone packages in a future phase once the API stabilizes.

## Adapter Model

The SDK does not hardcode one membership or identity system. It exposes adapter boundaries that applications can implement.

### Membership Adapter

First grant scope:

```text
MembershipAdapter
  community_id
  member_lock_hash
  membership_cell_or_type_hash
  status: active / archived / expired
```

The first practical implementation targets membership cells, because they fit the CKB cell model and match the direction suggested in the Mint Gate mentor review: chain-confirmed membership should be authoritative, while any database should be a cache and search layer.

### DID And Reputation Adapter

Future-compatible scope:

```text
IdentityAdapter
  did
  wallet_lock_hash
  linked_accounts

ReputationAdapter
  did
  claim_type
  issuer
  score_or_milestone
  expiry
```

Vellum's `did:ckb` reputation work and CKBoost's campaign/contribution surface are relevant here. They are not v1 dependencies, but the SDK is designed so DID and reputation claims can later plug into eligibility rules without changing the core governance lifecycle.

Example future policies:

```text
can vote if:
  member has membership cell

can create proposal if:
  member has membership cell
  AND reputation score >= threshold

can join reviewer committee if:
  did:ckb profile has a CKBoost/Vellum contribution claim
```

The first phase keeps voting equal-weight once eligible. Reputation-weighted voting is intentionally out of scope.

## Grant Scope And Deliverables

### Milestone 1 — SDK Architecture Spec

**Goal:** Establish a clear, public SDK boundary so any CKB developer can understand what the kit provides, where to integrate, and what is left to the consuming application before any integration code is written.

Deliverables:

- `DAO_BUILDER_SDK_SPEC.md`
- package/module layout
- contract/API boundary
- TypeScript builder inventory
- React hook/component inventory
- adapter interfaces for membership, DID, and reputation
- clear list of v1 versus future adapters

### Milestone 2 — Core TypeScript Governance SDK

**Goal:** Give external CKB apps a stable, well-tested TypeScript surface for building governance transactions, so they do not need to understand the raw script/cell layout to create proposals, submit votes, or close polls.

Deliverables:

- proposal creation builder
- vote intent builder
- shard/tally-lane aggregation builder
- finalization builder
- merge builder
- close and force-close builders
- delegation and revocation builders
- post-close refund builder
- shared constants and codecs
- tests for builder input validation and layout assumptions

### Milestone 3 — React Integration Layer

**Goal:** Let CKB community app frontends drop in governance UI with minimal custom code, by providing tested hooks and components that handle the full proposal and voting lifecycle.

Deliverables:

- `useGovernanceProposals`
- `useProposalActions`
- `useDelegation`
- `useMaintenanceQueue`
- `useMembershipEligibility`
- proposal list component
- proposal detail/vote component
- delegation component
- maintenance queue component
- result/archive component

The existing app consumes these modules as the reference implementation.

### Milestone 4 — Membership Eligibility Adapter

**Goal:** Enable any CKB community app to gate proposal creation and voting on chain-confirmed membership evidence, without writing custom governance contract code, while leaving the adapter interface open so DID, reputation, and future membership models can plug in later.

Deliverables:

- generic `MembershipAdapter` interface
- reference membership-cell adapter
- community identity model
- membership proof model
- direct voting with membership proof
- delegated voting with membership proof
- tests for missing membership, wrong community, inactive/archived status, and delegate authority

Mint Gate-style membership cells are the first useful integration target, but the adapter remains generic enough for other community apps.

### Milestone 5 — SubDAO Reference Dashboard

**Goal:** Demonstrate that a non-technical community member can participate in governance — propose, vote, delegate, and recover a deposit — without needing to understand the underlying cell mechanics.

Deliverables:

- community selector
- community proposal list
- eligibility status
- direct vote flow
- delegated vote flow
- maintenance queue
- final result/archive view
- omitted-intent refund surface
- protocol/debug view for opcodes, tally lanes, and lifecycle state

Normal UI copy uses governance language:

- Proposal
- Vote
- Delegate
- Tally lane
- Finalize
- Close
- Recover deposit

Protocol terms such as opcodes, shards, and script groups are visible only in the developer/debug section.

### Milestone 6 — Testnet Demo And Integration Guide

**Goal:** Give grant reviewers and potential integrators a complete, reproducible proof that the SDK works end-to-end on CKB testnet, and a written guide they can follow to integrate into their own app.

Deliverables:

- deployed CKB testnet contract
- deployed Vercel frontend
- seeded demo community
- membership-cell demo adapter
- direct vote demo
- delegated vote demo
- permissionless aggregation/finalization/merge/close demo
- force-close or recovery demo
- written integration guide for external apps
- short walkthrough video

The demo may use a self-seeded membership-cell community if Mint Gate integration is not ready. If Mint Gate is ready, it serves as the first external adapter demo.

## Out Of Scope For This Grant Phase

- ZK/Groth16 verifier integration
- private voting
- reputation-weighted voting
- automatic treasury execution
- xUDT or NFT membership as the default model
- marketplace or membership resale
- on-chain chat
- full DID/Vellum/CKBoost integration as a v1 dependency

## Relationship To Existing and Future Ecosystem works (Mint Gate, Vellum, And CKBoost)

The SDK is designed to align with current and emerging CKB ecosystem projects, but it should not depend on any single one being production-ready during this grant phase.

### Mint Gate ([reference](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/16))

Mint Gate is the strongest first integration candidate because it focuses on community creation, paid membership, gated access, and creator/member dashboards. The Mint Gate technical reviewer (@doitian) also points directly at the governance gap: once a community has members, it needs a way for those members to govern.

The SDK should be able to consume Mint Gate-style membership evidence once that evidence is chain-confirmed and recoverable from on-chain data. Mint Gate is framed as the first integration target, not the only reason the SDK exists, and the project is not blocked by Mint Gate's internal timeline.

### Vellum ([reference](https://talk.nervos.org/t/vellum-extended-from-identity-to-reputation-on-did-ckb/10406))

Vellum's `did:ckb` reputation work — extending DID profiles into chain-anchored reputation claim cells — maps directly onto future governance eligibility policies. A community could set membership-cell gates for basic voting, and reputation-score gates for proposal creation or reviewer roles. The SDK adapter model is designed to support this without a core protocol change.

### CKBoost Platform ([reference](https://ckboost.netlify.app/campaign))

CKBoost Platform and contribution activity can become a reputation signal that feeds into governance eligibility through the DID/reputation adapter. This is useful future alignment for the SDK. The SDK should be able to consume CKBoost contribution claims once they are chain-anchored and verifiable.

### Spore: CKB's Digital Object (DOB) protocol. ([reference](https://docs.spore.pro/)) 

Spore assets can function similarly to NFTs while supporting broader digital-object use cases. In future versions of the SDK, Spore ownership could serve as a community-membership or governance-eligibility signal, but Spore integration is not part of the v1 grant scope. Spore is described by its maintainers as an on-chain Digital Object protocol rather than simply an NFT standard

## Success Criteria

Reviewers should be able to confirm that:

- the work is reusable infrastructure, not only a standalone DAO app
- the existing governance protocol remains the foundation; this grant extends it, not replaces it
- other CKB apps can integrate governance without copying the full frontend
- membership eligibility is adapter-based and chain-anchored
- Mint Gate can integrate when ready, but the project is not blocked by it
- DID/reputation systems such as Vellum and CKBoost can plug in later without changing the core governance lifecycle
- vote submission and aggregation avoid the shared-cell contention pattern
- delegation is a first-class protocol feature
- deposits are recoverable through validated protocol paths
- maintenance actions are permissionless
- the reference dashboard is usable by non-technical community members

## Project Status

This grant funds the productization of an already-working CKB governance protocol into a reusable DAO/SubDAO builder kit.

The current protocol already includes proposal identity, vote intent cells, sharded tally aggregation, bounded merge close, delegation, permissionless maintenance, CKB-VM/testtool coverage, and deposit-safe recovery paths.

The next phase is to turn those pieces into a clean SDK surface, add membership eligibility adapters, and ship a reference SubDAO dashboard and testnet demo.

## Full Research And Reference Trail

The proposal above is focused on the DAO Builder SDK grant scope. The broader project lifecycle also consulted the following resources and ecosystem work.

### CKB Fundamentals And Developer Tooling

- CKB Cell Model: https://docs.nervos.org/docs/ckb-fundamentals/cell-model
- CKB transaction model: https://docs.nervos.org/docs/tech-explanation/transaction
- How CKB works: https://docs.nervos.org/docs/getting-started/how-ckb-works
- CKB script group execution: https://docs.nervos.org/docs/tech-explanation/script-group-exe
- CCC TypeScript SDK: https://docs.nervos.org/docs/sdk-and-devtool/ccc
- CKB testnet RPC: https://testnet.ckb.dev/rpc
- CKB faucet: https://faucet.nervos.org/
- Pudge testnet explorer: https://pudge.explorer.nervos.org/

### This Governance Protocol

- Repository: https://github.com/anihdev/ckb-voting-dapp
- Live frontend: https://ckb-voting-dapp.vercel.app
- Local protocol source files:
  - `backend/contracts-rust/contracts/governance/src/entry.rs`
  - `backend/contracts-rust/contracts/governance/src/codec.rs`
  - `backend/contracts-rust/contracts/governance/src/constants.rs`
  - `backend/contracts-rust/contracts/governance/src/helpers.rs`
  - `frontend/src/lib/ckb.ts`
  - `frontend/src/lib/protocolUi.ts`
  - `backend/contracts-rust/integration-tests/tests/governance_vm.rs`

### SubDAO, Membership, And Community App Context

- CKBuilder projects issue for Mint Gate: https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/16
- Mint Gate repository: https://github.com/Victor-Okenwa/mint-gate
- Mint Gate hosted app: https://mint-gate.vercel.app
- CKBoost platform: https://ckboost.netlify.app/campaign
- Spore protocol/site: https://spore.pro
- Spore docs: https://docs.spore.pro/

These projects are treated as ecosystem context and potential integration surfaces. Mint Gate is still under active development/testnet; CKBoost, Vellum, and Spore are relevant alignment points but are not v1 dependencies for this grant.

### DAO Governance Design Context

- CKBDAO v2 document repository: https://github.com/CKBDAO/ckb-dao-v2
- Nervos Talk discussion on on-chain tally limits, vote-meta cell contention, intent cells, and deposit-paired voting: https://talk.nervos.org/t/on-chain-tally-dao-v1-1-limits-and-a-deposit-paired-voting-proposal/10171/3

These resources are directly relevant to the SDK direction as governance-design context. The CKBDAO v2 repository collects Nervos Community Fund DAO v2.0 planning documents, including governance rules, delegation, treasury mechanisms, address binding, and DAO portal concepts. The Nervos Talk discussion is especially relevant because it identifies the same voting-state contention and deposit-control tradeoffs this protocol addresses through vote intent cells, governance-controlled spend paths, sharded tally aggregation, and deposit-safe recovery.

### DID, Reputation, And Future Eligibility Work

- Vellum reputation on `did:ckb`: https://talk.nervos.org/t/vellum-extended-from-identity-to-reputation-on-did-ckb/10406
- web5fans / DID ecosystem work: https://github.com/web5fans

The SDK should be compatible with future DID/reputation adapters, but the first grant phase should focus on membership eligibility and governance primitives.

### ZK And Vote-Completeness Research Consulted Earlier

- Cecilia's `groth16-ckb` verifier repository: https://github.com/CECILIA-MULANDI/groth16-ckb
- XuJiandong's CKB vote PoC: https://github.com/XuJiandong/ckb-vote-poc
- Nervos Talk: https://talk.nervos.org

These resources shaped earlier research around Groth16 verification, proof-based completeness, and DAO voting proof design. They are explicitly out of scope for this DAO Builder SDK grant phase. ZK/Groth16 remains a future track after the non-ZK governance SDK and membership adapter are stable.
