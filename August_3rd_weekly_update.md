# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)
**Duration:** 17th August, 2026 - 23rd August, 2026

## Focus Of The Week

This week focused on turning the finalization problems identified during the
community review into a measured, contract-led hardening.

The earlier review established that close already required complete tally-lane
or merge-result coverage, but a separate flaw remained: an actor could finalize
only a selected subset of lanes immediately after the deadline. Because voter
assignment to lanes is deterministic, that behavior could permanently exclude
timely intents waiting in a targeted lane. The encoded
`pending_intent_count` also remained fixed at zero and could not support the
close-time guarantee previously attached to it.

I reproduced those findings against the CKB-VM binary, compared the
available finalization designs, selected a bounded active topology, implemented
the Rust hardening, and expanded the adversarial evidence around finalization
and merge composition. 

## Progress Summary

### Baseline And Community-Finding Reproduction

- Re-ran the complete repository baseline before changing protocol behavior.
- Reproduced selective lane finalization with authoritative CKB-VM execution.
- Confirmed independently that direct close already requires every declared
  lane and merged close already requires complete merge coverage.
- Audited `pending_intent_count` from contract creation through close, builders,
  codecs, hooks, and tests. Current producible polls always encode zero, so its
  close-time lower-bound comparison is not a live-intent invariant.
- Kept the distinction explicit: tally correctness over consumed intents is not
  proof that every valid timely intent was included.

### Finalization Topology Decision

I selected and documented the following active policy for the hardened code
hash:

- new polls support a maximum of 16 tally lanes;
- finalization consumes the complete ordered lane set in one transaction;
- a fixed one-epoch aggregation grace applies after the poll deadline;
- earliest finalization and creator-close are `deadline + 2` under the current
  strictly-after epoch helper convention;
- polls with up to eight lanes close directly;
- polls with 9 to 16 lanes use the bounded merge path;
- polls above 16 remain historical old-code-hash concerns and are not silently
  reinterpreted by the new contract.

The 16-lane maximum was chosen after isolated transaction-size and cycle
measurements. A 16-lane poll also reserves at least 976 CKB of refundable lane
capacity before the poll cell and fee, so the higher lane range must eventually
be presented clearly to creators.

### Rust Protocol Hardening

- Added a separate `MAX_ACTIVE_TALLY_SHARDS = 16` while preserving the
  256-lane codec range needed to decode historical formats.
- Raised the atomic finalization limit from 8 to 16 lanes.
- Added `FINALIZATION_GRACE_EPOCHS = 1` and aligned creator-close with the same
  post-grace boundary.
- Changed finalization from an ordered subset rule to exact contiguous
  `0..shard_count-1` coverage.
- Preserved the existing direct-close and bounded merge-close split.
- Kept the sparse-Merkle tally-root rules, exact capacities, refund paths,
  equal-weight active policy, and retired opcode boundaries unchanged.

### Merge Composition Correction

The hardening review exposed a separate liveness issue in merge-result
composition.

CKB lock groups contain input indices, while type groups contain both input and
output indices. Because merge-result cells use the governance script as both
lock and type, generic same-index lock deferral could not handle multiple merge
inputs producing one canonical output. It also failed for the frontend-shaped
ordering where a shard input preceded a merge-result input.

I added a narrow merge-specific deferral rule:

- canonical output 0 must use the current merge script as both lock and type;
- every input using that merge lock must use the exact matching merge type;
- the merge type validator remains responsible for coverage, totals, capacity,
  fan-in, merge level, and single-output validation;
- poll, vote-intent, and tally-lane same-index rules remain unchanged;
- consuming a complete result during close still falls through to the existing
  close validator.

This now supports shard-first continuation, result-first continuation, and two
partial merge results composing into one complete result.

### Adversarial Tests And Measurements

The CKB-VM suite now covers:

- 16-lane creation success and 17-lane creation rejection;
- one-lane, incomplete, skipped, duplicate, out-of-range, out-of-order, and
  wrong-poll finalization rejection;
- finalization timing boundaries and malformed absolute-epoch `since` values;
- vote-count value and shape, total-voter count, sparse-Merkle root, capacity,
  lock, type, and extra-output mutation rejection;
- exact eight-lane direct close and hardened 17-lane merged-close rejection;
- shard-first and result-first merge continuation;
- two valid partial results composing successfully when disjoint;
- overlapping partial-result coverage rejection;
- missing or incorrect type scripts on merge-locked inputs;
- preservation of close, force-close, late refund, post-close refund,
  aggregation, delegation, and historical weighted-cell recovery paths.

The final measured 16-lane atomic finalization transaction is:

- transaction size: 6,391 bytes;
- CKB-VM cycles: 26,572,288;
- project ceiling: 50,000,000 cycles.

## Known Limits

- Complete-set finalization removes targeted lane selection, but an actor can
  still finalize all lanes after grace while timely intents remain pending.
- The one-epoch grace is an aggregation opportunity, not a vote-completeness
  proof.
- `intent_inclusion` therefore remains unproven.
- `pending_intent_count` still exist.

## Next Step

- Complete next Stage by retaining `pending_intent_count` as a canonical
   reserved-zero codec field, removing its unreachable close-time guarantee,
   and keeping indexed pending counts explicitly advisory.
- Complete Stage 5 parity across TypeScript constants, CCC builders, deploy
   tools, hooks, UI action gates, timing copy, and focused tests.
- Define and expose result assurance without presenting indexed absence as
   consensus proof of vote inclusion.
- Synchronize the README, grant proposal, protocol explanation.
- Run the final full validation, responsive UI review, and controlled
   real-node/testnet rehearsal before deploying the new contract code hash.
- Return to the represented-principal vote-authority and delegated-funding
   design before freezing the public SDK voting API.
