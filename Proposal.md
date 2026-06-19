# CKB SubDAO Governance Layer — Grant Proposal

## Overview

This project is a CKB-native governance protocol for community proposals, voting, delegation, and deposit-safe fund recovery. It is built around CKB's cell model rather than adapted from account-based DAO tooling, and it is designed to be used by any CKB community or SubDAO that needs on-chain governance — independent of how that community defines or manages membership.

## The Problem

CKB's community ecosystem is growing: token-gated groups, builder collectives, project communities, and membership platforms are emerging across the network. None of them currently have a shared, reusable governance layer. Each one that wants to add voting today either builds bespoke off-chain tooling or implements simplified on-chain state that reintroduces cell contention as soon as more than a handful of members try to vote at once.

This protocol is built to solve that problem once, as shared infrastructure, rather than as a one-off feature of any single app.

## What Already Exists

The protocol already implements the core non-membership governance lifecycle on CKB:

- **Type ID–backed poll identity** — every proposal is a uniquely identifiable, tamper-evident on-chain object.
- **Vote intent cells** — each vote is its own cell, with its own refundable deposit, rather than a write to one shared proposal cell. This keeps voting parallelizable and indexer-friendly.
- **Sharded tally aggregation** — votes are assigned to tally shards and aggregated independently, so high-participation proposals don't serialize through a single contended cell.
- **Bounded merge-close** — large polls reduce shard results through a merge step before close, so close transactions stay bounded regardless of vote count.
- **Delegation and revocation cells** — members can delegate voting authority to a representative without giving up custody of their own cells, and can revoke at any time.
- **Permissionless maintenance** — aggregation, finalization, merging, force-close after grace period, and post-close refund of omitted intents can all be performed by any party, not just the proposal creator. Governance does not stall if one operator goes offline.
- **Deposit-safe economics** — creator and voter deposits are CKB capacity locked into the relevant cells, with validated refund paths on close, force-close, and post-close recovery.

Core lifecycle behavior is already tested against CKB-VM via testtool coverage.

## Design Principle: Membership-Agnostic by Default

The protocol intentionally does not assume any single source of community membership. The target design is to prove eligibility to create or vote on a proposal through a pluggable **membership proof** interface, not through any one external platform's database or cell layout.

```text
MembershipProof
  community_id
  member_lock_hash
  membership_cell_or_type_hash
  status (active / archived / expired)
```

Any CKB community application that can produce a verifiable, chain-anchored membership artifact in roughly this shape should be able to supply it to the protocol as a cell dep when a member creates a vote intent. This keeps the governance layer decoupled from the roadmap, schema, or release timeline of any one community platform.

Mint Gate — a community/membership platform currently in development on CKB — is one illustrative example of the kind of app this adapter is designed for. It is not the only candidate, and the protocol's design does not depend on Mint Gate specifically shipping a membership cell on any particular timeline. Other candidate community surfaces include token-gated groups, NFT/Spore-holder communities, builder collectives, and self-issued membership cells for communities with no existing platform at all.

## Grant Scope and Deliverables 

### Milestone 1 — SubDAO Governance Spec
Define, in writing, what a community/SubDAO means in this protocol, how community identity is represented, how membership eligibility is proven, and how community-scoped proposals and delegated voting work. Output: `SUBDAO_GOVERNANCE_SPEC.md`.

### Milestone 2 — Community Identity & Membership Proof Adapter
Define and implement the generic adapter boundary described above. Produce frontend types, an indexer query plan, and a reference implementation against at least one concrete membership-cell layout. Tests cover wrong-community, expired, and missing-membership cases.

### Milestone 3 — Community-Scoped Proposals
Extend proposal creation, listing, and detail views to carry community context. Enforce community scope at vote-intent creation. Tests cover cross-community vote attempts.

### Milestone 4 — Membership-Gated Voting (Direct & Delegated)
Wire the membership proof into both direct voting and the existing delegation flow, so delegates can vote on behalf of a member without consuming the member's membership cell.

### Milestone 5 — SubDAO Dashboard
A community-facing UI: community overview, proposal status, member eligibility, delegation status, a maintenance queue for permissionless aggregation/finalization/close actions, and archived results. Protocol-level terms (shards, opcodes) stay in a debug view; the main UI uses plain governance language (Proposal, Vote, Delegate, Finalize, Close, Recover deposit).

### Milestone 6 — Testnet Demo & Grant Proof
A complete, reproducible demo: seeded community, multiple member wallets, direct vote, delegated vote, sharded aggregation, finalization, merge (if applicable), close, and deposit recovery — deployed on CKB testnet with a public frontend, a written walkthrough, and a short video. The demo community may be self-seeded, or drawn from an external platform's membership cells if one is ready in time.

## Out of Scope (This Grant Phase)

- ZK / Groth16 verifier integration
- Private voting
- Automatic treasury execution on proposal results
- xUDT or NFT membership as the default eligibility model
- Marketplace or resale features
- On-chain chat
- Claims of full decentralization beyond what the cell-model design actually guarantees

## Success Criteria

Reviewers should come away able to confirm that:

- The governance layer is reusable across more than one community application, not built around a single partner.
- Membership eligibility is anchored to verifiable on-chain evidence, not solely an off-chain database.
- Voting avoids the contention problems of single-cell proposal designs.
- Delegation is a first-class, protocol-level feature.
- Maintenance (aggregation, finalization, close, refund) does not depend on any one operator staying online.
- Deposits are recoverable through validated close, force-close, and post-close refund paths, including abandoned proposal recovery.
- Final results are auditable from chain state and indexer data.
- A non-technical community member could use the dashboard without needing to understand the underlying cell mechanics.

## Project Status

This grant funds the next phase of an already-working protocol, not a project starting from zero. The poll lifecycle, vote intent cells, sharded aggregation, merge-close, delegation, permissionless maintenance, and deposit-safe refunds are implemented and covered by current test suites today. This phase adds the community/membership layer that turns the existing protocol into infrastructure other CKB applications can build on.
