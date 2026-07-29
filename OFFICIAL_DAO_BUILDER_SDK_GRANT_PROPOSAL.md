# [DIS] CKB DAO Builder SDK — Reusable Governance Toolkit for CKB Communities

## Summary

### One-Paragraph Overview

This proposal requests a grant of **$9,000 USD equivalent in CKB** to productize the existing CKB Governance Protocol into a reusable DAO/SubDAO Builder SDK for CKB applications. The work turns a working cell-native governance protocol into integration-ready infrastructure: TypeScript transaction builders, React hooks/components, project-neutral eligibility adapters, a reference SubDAO dashboard, testnet demo flows, and integration documentation. The goal is not to build another standalone DAO app, but to give CKB community apps a governance kit they can plug into directly.

The protocol finalizes auditable tallies over the vote intents actually aggregated into finalized tally shards. It does not yet prove that every valid timely intent was aggregated before finalization. Consuming applications define quorum, pass/fail thresholds, decision policy, and how a closed result is acted upon. Automatic treasury execution is not included.

### Deliverables

- SDK architecture spec and public module boundary, including represented-principal authority, delegation funding, and eligibility-policy boundaries.
- Core TypeScript governance builders for proposal creation, strict-mode one-shot direct/delegated vote authority, clearly labeled advisory-mode behavior, vote intent submission, tally-lane aggregation, finalization, merge/close, force-close, and refund recovery.
- React hooks and reusable UI components for proposals, voting, delegation, maintenance queues, and results.
- Generic eligibility adapter interface, a CKBoost-compatible reference adapter, a reference membership-cell adapter, and one on-chain-enforced reference eligibility policy.
- Reference SubDAO dashboard using the current governance protocol as the live demo app.
- Testnet demo showing scope-aware proposal creation, direct voting, delegated voting, sharded aggregation, finalization, close, and deposit recovery.
- Integration guide for CKB apps that want to add governance without copying the full frontend.

All deliverables ship on testnet.

**Grant Amount Requested:** $9,000 USD equivalent, paid in CKB at the USD value at the time of each disbursement.

**ETA to Completion:** 12 weeks from disbursement of initial funding.

**Funding Address:** `ckb1qyqtltq6wl2dkga9nftmm4gwsk3yteu0ck7qjh7ctr`

---

## Project Introduction

### What Problem Are We Solving?

CKB has strong primitives for cell-based ownership, capacity-backed deposits, application-specific scripts, and emerging identity infrastructure. But CKB community apps that want governance still face the same hard problems:

- how to represent proposals as CKB-native state
- how to prove who is eligible to vote
- how to avoid shared-cell contention during vote submission and tallying
- how to support delegation without custodial authority transfer
- how to let third parties maintain stalled governance flows
- how to recover deposits in abandoned or partially maintained proposals
- how to expose these mechanics through a frontend without forcing every user to understand opcodes and script groups

Today, every app that wants DAO or SubDAO behavior has to solve these pieces alone. General-purpose CKB SDKs such as [CCC](https://docs.nervos.org/docs/sdk-and-devtool/ccc) help developers build transactions, but they are not governance kits. [CKBoost](https://ckboost.netlify.app/) provides a live-tested campaign, contributor, verification, points, and achievement surface. [Mint Gate](https://github.com/Victor-Okenwa/mint-gate) is developing membership and gated-community flows. [Vellum](https://talk.nervos.org/t/dis-vellum-reputation-extension-on-did-ckb/10419) provides `did:ckb` tooling and has proposed a portable reputation extension. These projects expose different forms of governance eligibility, but none should need to independently rebuild proposal lifecycle, delegation, sharded tallying, close, and refund recovery.

This proposal funds the missing middle layer: a reusable DAO Builder SDK for CKB community apps.

### What This Addresses

The SDK packages the existing CKB Governance Protocol into reusable modules:

```text
CKB DAO Builder SDK
  -> protocol contracts
  -> TypeScript transaction builders
  -> React hooks/components
  -> eligibility adapter boundary
  -> reference dashboard
  -> integration docs
```

I will keep the current app as the reference implementation while making the lower-level SDK pieces usable by other CKB apps without requiring them to copy the entire frontend.

The SDK does not hardcode one community or identity system. A consuming app supplies eligibility evidence through a generic adapter, and its governance policy decides whether that evidence permits proposal creation or voting.

CKBoost is the primary reference integration candidate because it is an active, live-tested CKB community platform with campaign, contributor, verification, points, and achievement state that can serve as governance eligibility evidence. The grant will ship a CKBoost-compatible eligibility adapter and reference flow without depending on changes to CKBoost, requiring CKBoost adoption, or implying a confirmed partnership.

Vellum and `did:ckb` reputation claims remain a future-compatible eligibility source. Mint Gate-style membership cells remain another concrete adapter model. A self-seeded eligibility fixture guarantees that the grant can demonstrate the adapter boundary even if an external project's interface, schedule, or participation changes.

This grant upgrades external eligibility from an application-level integration into a versioned protocol boundary. The existing governance contract already enforces proposal, voting, delegation, timing, tally, and refund rules; this grant adds contract validation for community-specific eligibility evidence. Milestone 1 will define how each poll commits to an eligibility policy and how evidence cells bind the governance scope and represented voter. Milestone 2 will implement and CKB-VM-test one on-chain-enforced reference policy, including manually constructed attempts to bypass the frontend. The SDK will support both advisory integrations and contract-enforced policies and will identify the applicable security level explicitly. CKBoost-compatible evidence is a primary reference integration possibility; it can use the enforced path once the selected CKBoost evidence has a stable CKB-verifiable representation. Delivery of the enforced reference policy will remain independent of changes to CKBoost itself.

### Why Now?

Three things have lined up:

1. **The governance protocol foundation already exists.** The repository already includes Type ID-backed proposal identity, vote intent cells, sharded tally aggregation, bounded merge-close, delegation/revocation cells, permissionless maintenance actions, deposit-safe recovery paths, and CKB-VM/testtool coverage.

2. **CKB community apps are already live and more are emerging.** CKBoost provides the strongest current reference possibility because it has been exercised in real campaign usage. Mint Gate, Vellum, Spore, and CKBuilder-related projects show additional membership, identity, reputation, and holder-based eligibility models that the same SDK boundary can support later.

3. **Existing DAO discussions have already identified the bottlenecks.** CKB governance discussions around on-chain tallying, vote-meta cell contention, intent cells, and deposit-paired voting point to the same design constraints this protocol addresses: cell contention, deposit control, and indexer-assisted coordination.

The right next step is to turn the working protocol into a reusable SDK surface and reference dashboard.

---

## Team & Roles

**Name / Handle:** Anih Soma / AnihDev

**Role:** Solo developer covering protocol design, Rust contract work, TypeScript transaction builders, frontend, documentation, testing, and grant reporting.

**Relevant Background:**

- Designed and maintained the CKB Governance Protocol, evolving it from poll-cell aggregation into governance-locked vote intents, sharded tally aggregation, delegation, bounded merge-close, permissionless recovery, and deposit-safe refunds.
- Built the corresponding TypeScript transaction lifecycle, protocol-aware React interface, and CKB-VM/testtool integration coverage for the governance contract.
- Built [Fiber DevKit](https://github.com/anihdev/Fiber_Devkit), a Rust CLI for multi-node Fiber Network development, deterministic scenario testing, route diagnostics, and CI-oriented reports, and [CKB DeFi Guardian](https://github.com/anihdev/CKB_DEFI_GUARDIAN), a CKB testnet risk-monitoring agent backed by RISC-V contracts and Fiber settlement.
- Contributed [merged pull requests across open-source blockchain projects](https://github.com/search?q=is%3Apr+author%3Aanihdev+is%3Amerged&type=pullrequests), covering protocol features, access control, integration tests, contract architecture, and edge-case handling.
- Built [Bitget Risk Watch](https://github.com/anihdev/Bitget_Risk_Watch) for the Bitget AgentHub Skills Challenge and contributed smart-contract security research through invariant analysis, reproducible proofs of concept, and structured audit reporting.

**Why CKB:**

CKB's cell model is a strong fit for governance because proposals, votes, delegation records, deposits, tally lanes, and refunds can all be represented as explicit cells with auditable lifecycle transitions. Capacity-backed deposits are native to the model, and CKB-VM lets protocol scripts enforce application-specific rules without waiting for chain-level feature changes.

**Links:**

- [GitHub profile](https://github.com/anihdev)
- [CKB Governance Protocol repository](https://github.com/anihdev/ckb-voting-dapp)
- [Live reference frontend](https://ckb-voting-dapp.vercel.app)
- [Sharded aggregation explainer](https://github.com/anihdev/ckb-voting-dapp/blob/main/SHARDED_AGGREGATION_EXPLAINED.md)

---

## Current Status

This grant funds the productization of an already-working protocol, not a project starting from zero.

Deployed the release contract to CKB testnet in [transaction `0xe701cc3f...6ed571c`](https://pudge.explorer.nervos.org/transaction/0xe701cc3ff439eda89b4ffb4b86db11f308b1ba89ef32a00f0aab7b6bd6ed571c), output `0`, with `data1` code hash `0x126d92bd112caec39e1e3b4d453dab32374c4019879779c2898d552721f564e1`. Rebuilt the [live reference frontend](https://ckb-voting-dapp.vercel.app) against that deployment and verified its served configuration. This is deployment/configuration evidence.

Already implemented:

- Type ID-backed proposal identity.
- Governance-locked vote intent cells.
- Sharded tally aggregation using `CREATE_TALLY_SHARD`.
- Bounded merge/result close using `MERGE_TALLY_SHARDS`.
- Creator close and permissionless force-close paths.
- Delegation and revocation cells.
- Post-close omitted-intent refund path.
- Frontend reference app with create, vote, aggregate, finalize, merge, close, force-close, delegate, revoke, and refund surfaces.
- A reproducible `make validate` workflow and GitHub Actions validation path.
- Verified Vercel deployment of the reference frontend configured for the current testnet.

Still missing:

- SDK package/module boundary.
- Stable exported TypeScript governance builder layer.
- Reusable React hooks/components.
- Generic eligibility adapter boundary.
- CKBoost-compatible reference eligibility adapter and self-seeded fallback fixture.
- Reference membership-cell adapter.
- On-chain eligibility policy commitment and reference contract validator.
- SubDAO dashboard polish.
- Integration guide for external apps.
- Testnet demo specifically showing SDK-style integration.

### Protocol Guarantees And Timing Boundary

The Rust contract and codec remain authoritative for protocol behavior. Active script families are `CREATE_POLL`, `CREATE_VOTE_INTENT`, `CREATE_TALLY_SHARD`, `MERGE_TALLY_SHARDS`, `CLOSE_POLL`, and `DELEGATE`. Delegation revocation is the validated destruction transition of a `DELEGATE` cell; retired opcodes `0x03` and `0x06` are permanently rejected.

- Intent cutoff is authenticated from the block epoch that created each consumed intent cell, not from caller-selected metadata or a claimed current header.
- Aggregation includes the corresponding creation headers and validates them through the consumed inputs.
- Shard finalization, creator close, and force-close require validated absolute epoch `since` values on protocol input 0.
- Timely intents may aggregate after the deadline until their shard is finalized. Late intents cannot count and have an exact-capacity refund path.
- Version 1 delegation is revocation-based; the retained expiry field must be zero.
- Poll creators cannot submit vote intents directly, delegate their own vote, or submit as another voter's delegate. This is enforced by lock hash and is not a personhood claim.
- `VoteIntentData.voted_at_epoch` is retained as non-consensus codec metadata.
- New polls are equal-weight only and require a zero `udt_type_hash`; weighted historical cells are recovery-only under the current deployment.

Deposits are recoverable through validated close and refund paths. Final tallies are correct over intents actually aggregated into finalized shards, but the protocol does not prove that every valid timely intent was included. Sharding reduces contention across tally lanes, although updates to the same lane still serialize. Permissionless maintenance authorizes any valid operator transaction; it does not create a built-in operator reward.

Current v1 enforces one validated intent output per creation transaction and one counted vote per represented voter, but it does not yet enforce only one confirmable intent across separate transactions, resolving this limitation is an explicit grant deliverable: Milestone 1 will finalize the canonical-principal and singleton-authority design, and Milestone 2 will implement and CKB-VM-test the reviewed strict reference path before the public SDK voting API is frozen.

---

## Application Design

### 6.1 Functional Overview

A consuming CKB app's flow through the SDK:

1. **Define a governance scope.** The app supplies a community, campaign, holder group, or other app-specific scope identifier.

2. **Resolve eligibility.** The app implements or uses an `EligibilityAdapter` to evaluate evidence associated with a wallet. The evidence may come from CKBoost contribution state, a membership cell, a DID/reputation claim, a holder rule, or another explicit source. The returned decision states whether it is advisory or backed by an on-chain policy validator.

3. **Create a proposal.** The SDK builds the proposal transaction using the governance protocol's `CREATE_POLL` flow. The proposal creates a poll cell and its tally-lane set.

4. **Submit votes.** Eligible participants will use one poll-scoped. Milestone 2 will implement a poll-scoped, one-shot authority for each canonical represented principal. The principal may exercise it directly or assign it exclusively to a delegate; both paths consume the same authority, ensuring that only one valid intent can be created. For protocol-enforced eligibility policies, the poll will commit to the policy and the governance contract will validate the corresponding eligibility evidence on chain.

5. **Maintain the proposal.** Any party can aggregate pending intents into tally lanes, finalize after deadline, merge larger results, close the proposal, or recover omitted deposits.

6. **Display results.** The SDK's hooks/components expose proposal state, tally frontier, lifecycle actions, final results, and refund surfaces.

The consuming app owns its governance scope, eligibility policy, evidence source, metadata, and user experience. The SDK owns the adapter boundary plus the governance transaction and lifecycle machinery.

### 6.2 Architecture And Design

New SDK components:

The package names below are illustrative until namespace ownership is verified.

- `@ckb-governance/core` style module, initially monorepo-local:
  - protocol constants
  - codecs
  - script helpers
  - transaction builders
  - input-order assertions
  - protocol validation helpers

- `@ckb-governance/react` style module, initially monorepo-local:
  - `useGovernanceProposals`
  - `useProposalActions`
  - `useDelegation`
  - `useMaintenanceQueue`
  - `useEligibility`

- `@ckb-governance/ui` style module, initially monorepo-local:
  - proposal list
  - proposal detail and vote panel
  - delegation panel
  - maintenance queue
  - result/archive view

- Adapter boundary:
  - `EligibilityAdapter`
  - `VoteAuthorityPolicy`
  - `DelegationPolicy`
  - `FundingPolicy`

For every package deliverable, I will provide:

- an explicit `exports` map and documented public API
- generated TypeScript declarations
- a reproducible clean build
- a package tarball produced by `pnpm pack`, or publication under a verified namespace
- a semantic version, repository tag, and changelog entry
- API, codec, builder-layout, and compatibility tests
- a minimal external consumer example that imports only public package exports

The reference frontend will consume these public workspace boundaries rather than private implementation paths.

Core eligibility boundary:

```text
EligibilityAdapter
  resolve(scope_id, subject_lock_hash) -> EligibilityDecision

EligibilityDecision
  eligible
  enforcement: advisory / on_chain
  policy_hash
  evidence_source
  evidence_reference
  status
  attributes
```

The grant does not fund an unspecified eligibility integration. In Milestone 1, I will lock one exact versioned reference policy before beginning its contract implementation.

The poll policy commitment will define:

- `policy_version`
- `governance_scope_id`
- trusted eligibility Type Script hash
- required evidence status
- action flags for proposal-creation and vote-intent gates
- expiry mode
- a policy hash over the complete canonical encoding

The trusted evidence cell will identify the same governance scope, the represented principal lock hash, the committed policy version/hash, evidence status, and expiry field.

Reference policy v1 will enforce these rules:

- proposal creation and vote-intent creation are both gated
- the Rust contract validates the exact trusted eligibility Type Script hash
- evidence status must be active
- expiry is disabled in v1 and the encoded expiry must be zero
- proposal creation checks the creator principal
- direct voting checks the voter principal
- delegated voting checks the represented delegator, not the delegate signer
- each poll commits its scope and policy hash to prevent cross-scope or cross-policy replay
- frontend-only and indexer-only decisions are labeled advisory
- an adapter is labeled on-chain enforced only when the Rust contract validates its exact evidence cell

This policy changes poll and intent codec semantics. It therefore requires an explicit codec version and migration document, deterministic fixtures, compatibility tests, and a new testnet contract deployment. It will not be silently appended to an existing deployed byte layout.

Reference implementations:

```text
CKBoostEligibilityAdapter
  campaign/user scope
  verification state
  contribution/quest evidence
  points or achievement evidence

MembershipCellAdapter
  community scope
  member lock hash
  membership cell or type hash
  active / archived / expired status
```

Future-compatible implementations:

```text
VellumReputationAdapter
  did
  wallet_lock_hash
  claim_type
  issuer
  score_or_milestone
  expiry

HolderEligibilityAdapter
  asset_type_hash
  minimum_balance_or_ownership_rule
```

The first grant phase keeps voting equal-weight once a participant is eligible. Reputation-weighted voting is out of scope.

### 6.3 Design Rationale

**Builder kit, not standalone DAO app.** I am building reusable infrastructure so CKBoost, Mint Gate, Spore communities, DID/reputation tools, and future CKB apps can add governance where they already have users.

**Eligibility adapter, not hardcoded platform integration.** I will keep the adapter boundary project-neutral. CKBoost is the strongest current reference possibility, but delivery will not depend on CKBoost or any other project's internal timeline, adoption decision, API, or final cell layout. Mint Gate membership cells and future Vellum reputation claims demonstrate why that boundary needs to remain generic.

**Explicit on-chain enforcement.** Adapter output used only by an app or indexer is advisory. I will describe a policy as protocol-enforced only when the poll commits to it and the Rust contract validates the required evidence during vote-intent creation. I will make that distinction visible in the SDK and UI instead of presenting every eligibility result as equally trustless.

**Vote intent cells, not direct shared-state voting.** I will preserve independent vote intent cells so voters do not compete to update one mutable proposal cell.

**Sharded tally lanes.** I will preserve the split tally state so aggregators can update different lanes in parallel instead of repeatedly consuming one poll cell.

**Permissionless maintenance.** I will keep aggregation, finalization, merge, force-close, and refund recovery independent of one creator or service remaining online.

**Deposits as CKB capacity.** I will keep creator and voter deposits inside cells and preserve their recovery through validated protocol paths.

**Testnet-first.** I am not requesting mainnet promotion or formal audit funding in this grant. I will ship and demonstrate the public reference integration on Pudge testnet.

### 6.4 Fee Model And Sustainability

The SDK will not introduce a protocol fee or token.

Sustainability model:

- open-source governance infrastructure
- grant-funded SDK packaging and reference implementation
- normal CKB transaction fees paid by users/operators of governance actions
- future optional paid services can exist outside the protocol, such as hosted dashboards, analytics, or managed indexers, but they are not part of this grant

The core SDK remains open infrastructure.

---

## Key Benefits For CKB

- **Reusable governance infrastructure.** CKB apps get governance primitives without rebuilding proposal, voting, delegation, aggregation, close, and refund logic.
- **CKB-native architecture.** The design uses cells, capacity-backed deposits, Type Scripts, and indexer-assisted coordination rather than importing account-based DAO assumptions.
- **Reduced voting contention.** Vote intent cells and sharded tally lanes avoid the old single mutable poll-cell bottleneck.
- **Better SubDAO support.** Community apps can add participant-governed proposals and delegation without becoming governance-protocol experts.
- **Evidence-neutral eligibility.** CKBoost-compatible contribution evidence is the leading reference possibility, membership cells provide a second implementation, and DID/reputation or holder-based evidence can plug in later.
- **Developer tooling.** TypeScript builders, React hooks, UI components, and integration docs reduce the effort required for other builders to adopt governance.
- **Public testnet evidence.** The grant produces a public reference dashboard and recorded demo flow on CKB testnet.

---

## Detailed Deliverables & Milestones

### Initial Funding

**ETA:** Week 0

**Budget:** $900 USD (10%)

Deliverables:

- Proposal accepted.
- Public roadmap and GitHub project board live.
- Final SDK scope locked.
- Reviewer names/designations confirmed during discussion.

Acceptance:

- The roadmap and locked scope are linked publicly.
- Package names are marked verified or remain explicitly illustrative.
- Primary and alternate reviewer roles are recorded in the proposal thread.

### Milestone 1: SDK Architecture Spec

**ETA:** Weeks 1-3

**Budget:** $2,250 USD (25%)

Deliverables:

- `DAO_BUILDER_SDK_SPEC.md`.
- Package/module layout for core, React, UI, and adapters.
- Inventory of existing builders and hooks to extract.
- Adapter interface definitions for eligibility, membership, DID, and reputation.
- CKBoost evidence mapping review covering public campaign, participant, verification, points, and achievement surfaces without assuming CKBoost-side changes.
- On-chain eligibility design covering poll policy commitment, eligibility evidence-cell transaction composition, replay and scope binding, advisory versus enforced status, and contract/frontend failure behavior.
- Versioned represented-principal authority design proving at most one strict poll authority per eligible principal, with direct and delegated voting consuming the same one-shot authority.
- Principal-owned funding/refund design in which a delegate selects and submits the vote but cannot supply voting weight, redirect the deposit, or receive the principal's refund.
- Contention analysis proving that unrelated voters do not consume a shared poll-wide, community-wide, issuer-wide, or global mutable cell.
- Explicit deferral of reusable global funded delegation until a bounded allowance and concurrency model is separately reviewed.
- Clear v1 versus future-scope list.
- Public design review update posted to the proposal thread.

Acceptance:

- Every package lists its public exports and excluded private internals.
- The eligibility specification defines every field, validation rule, scope/replay rule, represented principal, status rule, and expiry rule.
- The authority specification defines singleton issuance, direct/delegated exclusivity, assignment/revocation, exact capacity preservation, fee-input isolation, refund ownership, and migration/version boundaries.
- The selected authority topology introduces no mandatory shared mutable input between unrelated voters; any serialization is bounded to one represented principal or one tally lane.
- Codec fixtures and deterministic policy-hash vectors are checked into the repository.
- A clean specification-validation command passes.
- Public review notes identify resolved and still-open decisions.

### Milestone 2: Core Protocol And TypeScript Governance SDK

**ETA:** Weeks 4-6

**Budget:** $2,700 USD (30%)

Deliverables:

- Core TypeScript builder layer extracted from current frontend code.
- Builders for:
  - proposal creation
  - vote intent creation
  - strict poll authority issuance and recovery
  - poll-scoped delegation assignment/revocation and direct/delegated permit exercise
  - tally-lane aggregation
  - finalization
  - merge
  - close and force-close
  - post-close omitted-intent refund
- Shared constants and codecs moved into the SDK boundary.
- Rust contract and codec extension for the reviewed strict vote-authority path and one on-chain-enforced reference eligibility policy selected in Milestone 1.
- CKB-VM tests for valid evidence, missing evidence, wrong subject, wrong governance scope, policy mismatch, expired/inactive evidence, replay attempts, conflicting direct/delegated intents, duplicate authority issuance, deposit/refund ownership, and frontend-bypass transactions.
- Tests for builder input validation, protocol layout assumptions, and fixed input ordering.
- Current reference app updated to consume the SDK layer.

Acceptance:

- A clean package build emits JavaScript and TypeScript declarations.
- `pnpm pack` produces an inspectable tarball, or a verified namespace publication is linked.
- No external consumer import reaches into `frontend/src` or another package's private path.
- API, codec-vector, fixed-input-order, authenticated-origin-header, and compatibility tests pass.
- CKB-VM tests cover valid evidence, missing evidence, wrong principal, wrong scope, policy mismatch, inactive status, nonzero expiry, replay mismatch, delegated principal handling, and manual frontend bypass.
- Direct and delegated voting for one represented principal cannot both confirm for the same poll, while unrelated voters retain independent mutable inputs.
- Permit/intent capacity is preserved exactly for the represented principal and wallet-added fee/change inputs cannot increase voting weight or redirect refunds.
- A semantic version, repository tag, and changelog entry are present.

### Milestone 3: React Integration Layer And Eligibility Adapters

**ETA:** Weeks 7-9

**Budget:** $2,250 USD (25%)

Deliverables:

- React hooks for proposal discovery, proposal actions, delegation, maintenance queues, and eligibility.
- Reusable UI components for proposal list, vote panel, delegation panel, maintenance queue, and result/archive view.
- Generic `EligibilityAdapter` interface and normalized `EligibilityDecision` model.
- CKBoost-compatible reference adapter and flow using documented public/testnet evidence or a versioned compatibility fixture when direct coordination is unavailable. I will report its enforcement level explicitly and accurately.
- Reference membership-cell adapter connected to the on-chain-enforced testnet policy.
- Direct and delegated voting with policy-approved eligibility evidence, including manual transaction bypass tests at the contract layer.
- Tests for missing evidence, wrong scope, inactive or expired evidence, malformed adapter results, and invalid delegate authority.

Acceptance:

- React, UI, and adapter packages produce declarations and inspectable tarballs.
- An external example renders and runs using only public exports.
- UI states distinguish timely pending intents, late refundable intents, aggregated tallies, shard coverage, and the vote-completeness limitation.
- Adapter tests cover malformed output, wrong scope/principal, inactive status, and advisory/enforced labeling.
- Delegated eligibility evaluates the represented delegator.
- No adapter is described as a partnership or enforced dependency without evidence.

### Milestone 4: Testnet Demo And Integration Guide

**ETA:** Weeks 10-12

**Budget:** $900 USD (10%)

Deliverables:

- Deployed CKB testnet contract and reference frontend.
- Seeded demo governance scope.
- CKBoost-compatible eligibility demo that does not require CKBoost-side changes.
- Membership-cell eligibility demo.
- Direct vote demo.
- Delegated vote demo.
- Permissionless aggregation, finalization, merge, close, and refund recovery demo.
- Written integration guide for external CKB apps.
- Short walkthrough video.
- Final status update and validation report.

Acceptance:

- Recorded hashes cover deployment, proposal creation, direct/delegated voting, authenticated aggregation, post-deadline finalization, direct or merged close as applicable, and late/omitted-intent refunds.
- Small direct-close and large bounded-merge behavior are covered by runtime tests or recorded rehearsal evidence.
- Frontend configuration matches the recorded contract hash.
- The external consumer example is reproducible from a clean install.
- Package, CKB-VM, frontend, deploy TypeScript, and CI checks pass.
- Remaining advisories and protocol limitations are reported.
- A milestone status update and designated reviewer confirmation are posted before disbursement.

---

## Budget Breakdown

The $9,000 USD equivalent funds 12 weeks of solo development to productize the existing CKB Governance Protocol into a reusable DAO/SubDAO Builder SDK and ship a testnet reference demo.

### Development Costs: $7,600

- Core protocol, represented-principal authority, and TypeScript SDK extraction/tests: ~$2,200.
- React hooks/components and dashboard refactor: ~$1,500.
- Eligibility adapter boundary, CKBoost-compatible reference, membership-cell reference, on-chain policy extension, and policy tests: ~$2,200.
- Runtime validation, Pudge testnet rehearsal, demo flows, and integration cleanup: ~$1,700.

### Documentation And Community Reporting: $900

- SDK architecture spec.
- Integration guide.
- Milestone reports.
- Demo walkthrough script.
- Proposal-thread updates.

### Infrastructure / Hosting / Testnet Operations: $500

- Hosted reference frontend.
- Testnet deployments and demo data.
- Light operational costs for demo support.

### Security Audit: $0

No formal third-party audit is included in this proposal. The SDK and reference dashboard ship on testnet. The current governance contract already has CKB-VM/testtool coverage, and this grant adds public-testnet validation. I will treat a formal mainnet audit as a separate prerequisite before production use.

### Project Management

Absorbed in development. Solo developer; project management overhead is minimal.

**Total:** $9,000 USD equivalent in CKB.

---

## Open-Source License

The SDK packages, contract changes, reference frontend, examples, and grant documentation will remain available under the repository's [MIT License](https://github.com/anihdev/ckb-voting-dapp/blob/main/LICENSE).

---

## Out Of Scope / Future Funding Needs

The following are deliberately out of scope for this grant:

- Formal security audit and mainnet production promotion.
- ZK vote-completeness circuit work or `groth16-ckb` verifier integration/composition.
- Private voting.
- Reputation-weighted voting.
- Token- or capacity-weighted voting; the first SDK policy remains equal-weight.
- Reusable global funded delegation or an unbounded cross-poll delegation allowance.
- Proof of personhood or a claim that one canonical credential necessarily equals one human.
- Automatic treasury execution.
- xUDT or NFT membership as the default eligibility model.
- Marketplace or membership resale.
- On-chain chat.
- Changes to CKBoost, Mint Gate, Vellum, or their internal protocols.
- Guaranteed adoption by, or a hard dependency on, CKBoost, Mint Gate, Vellum, or any other external project.
- Hosted indexer-as-a-service or long-term managed operations.

Future funding could cover mainnet audit, production deployment, hosted indexing, production integrations with CKBoost, Mint Gate, or Vellum, additional DID/reputation adapters, or ZK vote-completeness work after the SDK foundation is stable.

---

## Risks And How I Will Address Them

### Vote Completeness Risk

A finalized shard can omit a valid timely intent that was never aggregated.

**Mitigation:** I will state this limitation explicitly, expose indexed timely-pending and refund queues, and test the exact tally semantics. I will not represent the result as complete over unaggregated intents. My longer-term research direction is to define omission-resistant canonical intent commitments and a completeness circuit, then verify its proof on CKB using infrastructure such as [Cecilia Mulandi's `groth16-ckb`](https://github.com/CECILIA-MULANDI/groth16-ckb). The verifier alone does not prove vote completeness: the protocol must first define the complete committed intent set, and the circuit must prove that every eligible committed intent was processed exactly once. That ZK work is intentionally outside this grant and is not a dependency for the SDK deliverables.

### Operator Incentive Risk

Permissionless maintenance does not include a built-in payment for aggregation, finalization, merge, close, or refund operators.

**Mitigation:** I will fund the controlled testnet operator roles used in the demo and document future bounty, Fiber reimbursement, or managed-operator models without presenting them as grant deliverables.

### SDK Extraction Risk

The current transaction builders and hooks live inside the frontend. Extracting them into a clean SDK boundary may reveal assumptions that were safe in the app but not reusable enough for external integrators.

**Mitigation:** I will keep the first SDK version monorepo-local, add tests around builder inputs and fixed ordering assumptions, and publish standalone packages only after the public API stabilizes.

### Integration Adoption Risk

Other apps may not integrate immediately. References to external projects are possible integration surfaces, not claims of confirmed partnerships or delivery dependencies.

**Mitigation:** I will use CKBoost as the leading reference possibility rather than a required integration partner. I will ship versioned CKBoost-compatible fixtures, a self-seeded eligibility demo, and a membership-cell adapter so every acceptance criterion can be completed without external code changes, private API access, or adoption commitments.

### Eligibility Model Risk

Different apps represent eligibility differently: contribution history, campaign participation, verification status, membership cells, DID claims, token holdings, or app-specific policies.

**Mitigation:** I will define a generic `EligibilityAdapter` and normalized decision model, then implement CKBoost-compatible contribution evidence and membership-cell evidence as separate references. This keeps later DID/reputation, Spore-holder, or xUDT policies outside the core governance lifecycle.

### Eligibility Enforcement Risk

An SDK or UI decision can be bypassed if the Rust contract does not verify the same eligibility rule.

**Mitigation:** I will require every decision to declare `advisory` or `on_chain` enforcement. I will commit the reference policy to poll state, validate its evidence during vote-intent creation, and cover manually constructed frontend-bypass attempts in CKB-VM tests. I will describe an external adapter as protocol-enforced only after its exact evidence rule is implemented and tested on chain.

### Voting Authority And Delegation Funding Risk

Current testnet v1 prevents double counting during aggregation but does not prevent conflicting live intents at creation, and its delegated path separates the capacity payer from the refund owner.

**Mitigation:** I will not freeze those v1 semantics as the public SDK policy. For the enforced reference policy, I will specify and implement one versioned, poll-scoped authority per canonical represented principal so direct and delegated submission consume the same authority, committed capacity and refunds remain principal-owned, fee inputs cannot alter weight, and unrelated voters do not share a mutable authority cell. Any advisory wallet-only mode will disclose that it cannot prove singleton authority.

### Runtime / Indexer Risk

Governance flows depend on discovering live cells, consumed cells, shard/result state, and refund surfaces through RPC/indexer queries.

**Mitigation:** I will rehearse the complete acceptance flow on Pudge testnet and record the deployed hashes, lifecycle transactions, and observed RPC/indexer behavior. A hosted production indexer service remains outside this grant.

### Solo Developer Execution Risk

The project is developed by a solo maintainer.

**Mitigation:** I am starting from an implemented and tested governance protocol rather than a blank-slate design. I have divided the productization work into narrow milestones with objective acceptance criteria and public status updates.

### CKB Price Volatility

The grant is requested as USD equivalent.

**Mitigation:** I request that the CKB amount for each disbursement be calculated at the time of payment using the then-current USD price, following the pattern used by prior DAO proposals.

---

## Maintenance Commitment

I will maintain the SDK and reference dashboard on testnet for at least 6 months after final milestone completion and provide best-effort compatibility fixes for major `@ckb-ccc/core` updates.

I will treat mainnet support, a formal audit, and long-term hosted operations as separate future scope if the SDK receives adoption.

---

## Closing / Call To Action

The CKB Governance Protocol already demonstrates a CKB-native governance lifecycle: intent-cell voting, sharded tally aggregation, delegation, permissionless maintenance, and deposit-safe recovery.

This proposal funds the next step: turning that working protocol into a reusable DAO Builder SDK that CKB community apps can integrate.

CKBoost provides the strongest current reference possibility because it already has live-tested campaign and contributor flows. Mint Gate remains a concrete membership-cell use case, while Vellum, Spore, and future DID/reputation surfaces provide additional eligibility models. None is a required dependency: the SDK remains independent infrastructure that can serve any CKB app that needs governance.

Feedback, reviewer suggestions, and integration interest from CKB community projects are welcome in the discussion below.

---

## Supporting Links

### This Project

- [CKB Governance Protocol repository](https://github.com/anihdev/ckb-voting-dapp)
- [Live reference frontend](https://ckb-voting-dapp.vercel.app)

### Proposal Process

- [CKB Community Fund DAO rules and process](https://talk.nervos.org/t/ckb-community-fund-dao-rules-and-process/6874)
- [CKBoost proposal](https://talk.nervos.org/t/dis-ckboost-gamified-community-engagement-platform-proposal/8832)

### Potential Integration Surfaces

- [CKBoost repository](https://github.com/Alive24/CKBoost)
- [CKBoost campaign surface](https://ckboost.netlify.app/campaign)
- [Mint Gate CKBuilder issue](https://github.com/Nervos-Community-Catalyst/CKBuilder-projects/issues/16)
- [Mint Gate repository](https://github.com/Victor-Okenwa/mint-gate)
- [Mint Gate hosted version](https://mint-gate.vercel.app)
- [Vellum reputation context](https://talk.nervos.org/t/vellum-extended-from-identity-to-reputation-on-did-ckb/10406)
- [web5fans DID work](https://github.com/web5fans)
- [Spore Protocol](https://spore.pro)
- [Spore documentation](https://docs.spore.pro/)

### Governance And Protocol Research Consulted

- [CKBDAO v2 documents](https://github.com/CKBDAO/ckb-dao-v2)
- [On-chain tally and deposit-paired voting discussion](https://talk.nervos.org/t/on-chain-tally-dao-v1-1-limits-and-a-deposit-paired-voting-proposal/10171/3)
- [XuJiandong CKB voting PoC](https://github.com/XuJiandong/ckb-vote-poc)
- [Cecilia's groth16-ckb repository](https://github.com/CECILIA-MULANDI/groth16-ckb)

### CKB Developer References

- [CCC TypeScript SDK](https://docs.nervos.org/docs/sdk-and-devtool/ccc)
- [CKB Cell Model](https://docs.nervos.org/docs/ckb-fundamentals/cell-model)
- [RFC 0017: transaction since](https://nervosnetwork.github.io/rfcs/rfcs/0017-tx-valid-since/0017-tx-valid-since.html)
- [RFC 0022: transaction header deps](https://nervosnetwork.github.io/rfcs/rfcs/0022-transaction-structure/0022-transaction-structure.html)
- [RFC 0009: VM syscalls](https://nervosnetwork.github.io/rfcs/rfcs/0009-vm-syscalls/0009-vm-syscalls.html)
