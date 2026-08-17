# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 10th August, 2026 - 16th August, 2026

## Focus Of The Week

This week focused on moving the governance protocol beyond self-testing. I
published the project journey and live testnet flow on Nervos Talk, asked the
community to participate as voters, creators, aggregators, and closers, and
requested adversarial review of the protocol assumptions.

The public request produced a detailed technical review from Phroi. I reviewed
each finding against the Rust contract, CKB-VM tests, frontend builders, and
current documentation. That review confirmed that the core governance-lock and
tally-lane direction is sound, while also exposing a selective-finalization
problem and a stale `pending_intent_count` invariant.

## Progress Summary

### Community Testing And Review Request

- Published the idea behind project on Nervos Talk explaining how the
  work moved from a single-signer practice project into a multi-actor CKB
  protocol problem.
- Linked the live Pudge testnet app, faucet, repository, deployed contract, and
  role-specific participation steps.
- Asked community members to create polls, vote, aggregate another person's
  intents, finalize lanes, close polls, and report both UX and protocol issues.
- Received one detailed public technical review from Phroi and Tianji

### What The Review Confirmed

- The governance lock can control intent transitions while the immutable refund
  lock in cell data continues to identify who receives the capacity back.
- Deterministic tally lanes address the original globally shared poll-tally
  cell by allowing different lanes to be aggregated independently.
- Same-lane updates still serialize, so the protocol partitions contention
  rather than claiming to eliminate it.
- A poll-scoped one-shot authority can address conflicting actions from one
  issued voting right, but it cannot by itself define who is entitled to receive
  that right. The canonical authority or eligibility source remains a separate
  design decision.
- iCKB may be relevant to a future asset-weighted design when voting assets are
  locked or consumed rather than read as a reusable balance. Weighted voting
  remains deferred and is not part of the active equal-weight deployment.

### Findings Verified Against The Repository

- The current finalization validator accepts any ordered subset of one to eight
  same-poll tally lanes. It checks increasing lane IDs, but not adjacency or
  complete poll coverage.
- Because lane assignment is deterministic and public, selective finalization
  can target the lane containing a timely intent before that intent is
  aggregated. The voter can recover capacity after close, but the vote can be
  permanently omitted making the protocol less fair.
- Finalization currently opens strictly after the poll deadline and has no
  separate aggregation grace interval. The force-close grace does not protect
  aggregation from early lane finalization.
- `pending_intent_count` is required to be zero at poll creation and close and
  is never incremented. Its close-time lower-bound comparison is therefore
  vacuous for polls produced by the current contract.
- Direct close already requires every lane for small polls, and large close
  requires a complete merge-result coverage bitmap. The missing guarantee is
  intent inclusion inside those covered lanes, not lane coverage at close.
- The current contract proves tally correctness over the timely intents
  actually consumed by aggregation. It does not prove that every valid timely
  intent was included.

### Recent Protocol Work Carried Into This Review

- Replaced each tally lane's growing counted-voter list with one fixed
  sparse-Merkle root.
- Added versioned compiled proof verification to aggregation so the contract
  verifies absent-to-present represented-voter key transitions.
- Added matching browser and Node proof providers pinned to the same Nervos
  sparse-Merkle-tree revision and CKB Blake2b rules.
- Added bounded finalization of up to eight ordered lanes in one transaction,
  reducing the default eight-lane wallet flow from eight approvals to one.
- Added cycle, transaction-size, mature-tree, malformed-proof, canonical codec,
  and deterministic WASM artifact coverage.
- Kept the fixed-root change separate from vote completeness: a root proves the
  counted-key transition presented to the contract, not that every live timely
  intent was selected.

### UI And Lifecycle Clarity Work

The recent UI pass was reviewed again in the context of real testnet use:

- Poll cards start collapsed so a list of proposals remains scannable.
- Eligible non-creator voters can enter the existing vote flow through a
  compact `Vote now` action without bypassing option review, confirmation, or
  wallet approval.
- Open polls hide per-option counts and percentages while showing the connected
  represented voter's recorded choice.
- Transaction progress appears beside the action that produced it, while a
  global in-flight lock prevents conflicting wallet actions from spending the
  same inputs concurrently.
- Aggregation wording distinguishes the first `Aggregate` action from later
  `Aggregate Next Batch` work while preserving one-lane, at-most-50-intent
  contract behavior.
- Finalization performs a fresh exact-scope indexer preflight and warns about
  timely pending or unresolved intents. The warning remains advisory and does
  not claim completeness.
- Poll, creation, and delegation panels support outside-click collapse without
  discarding the current in-memory form draft.
- Responsive review covered desktop, split-screen, and mobile layouts, including
  duration controls, long metadata, horizontal overflow, and action wrapping.
- RPC/indexer fetch failures now explain that indexed data may be stale and
  provide a retry path instead of presenting the warning as a contract error.


## Next Step

The next pass will implement the findings from community feedback in a staged,
contract-led way:

1. Define a consensus finalization policy that prevents arbitrary targeted lane
   sealing and remains coherent for both default eight-lane and larger polls.
2. Decide and encode an aggregation grace rule using CKB absolute-epoch `since`
   semantics rather than an indexer or UI clock.
3. Retire the `pending_intent_count` guarantee without restoring one
   poll-wide mutable counter during intent creation.
4. Expose result assurance as independent dimensions: tally integrity, lane
   coverage, intent inclusion, authority uniqueness, and eligibility
   enforcement.
5. Keep full vote-completeness work separate from this pass.
