# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)
**Duration:** 24th August, 2026 - 30th August, 2026

## Focus Of The Week

This week focused on completing the contract-to-frontend parity and validation
work for the finalization hardening started in the previous report.

The main goal was not to add another governance feature. It was to make every
layer tell the same truth about what the current protocol can prove: tally
transitions are validated on chain, active lane coverage is complete at close,
but inclusion of every valid timely intent is still unproven.

I also completed a private evidence record connecting the public community
review, the implementation decisions, the current grant proposal, and the
remaining protocol work. Phroi's feedback remains the primary
public review source. A locally retained response that was removed from the
forum was treated only as secondary technical input, not as public endorsement
or an implementation-ready specification.

## Progress Summary

### Pending-Intent Counter Truth Pass

- Traced `pending_intent_count` back to the April v3 poll codec, where it was
  described as the number of intents created but not yet aggregated.
- Confirmed that independent intent creation deliberately did not consume the
  poll cell, so no valid creation transition ever incremented that field.
- Confirmed that the old aggregation path could only subtract from the encoded
  value with a zero floor, while later close logic treated it as a lower bound.
  For current producible polls, that lower-bound check was therefore vacuous.
- Removed the false Rust and TypeScript close-time lower-bound interpretation.
- Kept the field byte-compatible in the existing poll codec and made zero its
  only canonical current-protocol value at creation, close input, and close
  output.
- Kept visible pending counts separate: the frontend discovers timely, late,
  unresolved, and refundable intents through RPC/indexer scans. Those values
  support warnings, action copy, and refund selection, but are advisory rather
  than consensus evidence.

I did not replace the field with a shared live counter. Updating one poll-wide
counter during every intent creation would restore the same write contention
that independent vote-intent cells were introduced to avoid.

### Frontend And Builder Parity

- Mirrored the Rust active-lane cap of 16 while retaining the 256-lane codec
  decoding bound for historical data.
- Replaced the old normal partial/batch finalization path with one atomic
  complete-set finalization action over ordered lane IDs `0..shard_count-1`.
- Aligned creator-close and finalization readiness with the enforced
  `deadline + 2` threshold, while preserving force-close at `deadline + 11`.
- Preserved direct close for polls with up to eight lanes and bounded
  merge-close for current-code polls with 9 to 16 lanes.
- Removed obsolete finalize aliases and transaction-batch presentation state.
- Added fail-closed maintenance classification for missing, duplicate,
  wrong-poll, mixed, malformed, or incomplete lane and merge-frontier data.
- Bound result-assurance claims to the configured governance code hash and hash
  type, so unsupported or historical script provenance does not receive a
  current assurance object.

### Result Assurance

The frontend now keeps independent evidence dimensions instead of presenting a
single `finalized = complete` claim:

```text
tallyIntegrity: on_chain_verified
laneCoverage: partial | complete
intentInclusion: unproven
authorityUniqueness: counted_once
eligibility: open
```

Lifecycle state remains separate from this assurance object. A closed poll is
an immutable result accepted by the current contract; it is not a proof that
every valid timely intent was counted.

### Merge And Maintenance Corrections

- Tightened merge progress so a merge must consume at least two disjoint tally
  frontier components. Singleton shard wrappers and singleton result rewraps
  are rejected in both Rust and the TypeScript builder.
- Preserved the narrow many-input-to-one-output merge lock deferral needed for
  CKB's separate lock and type script groups.
- Kept valid shard-to-result, result-plus-shard, two-partial-result, and final
  result close paths green.
- Added classifier evidence that a current-code nine-lane poll with a missing
  live lane cannot finalize, merge, creator-close, or force-close from an
  incomplete indexed frontier.

### Documentation Alignment

- Synchronized the README, protocol explanation, UI decision record and private implementation records with the current code.


## Known Limits

- Exact complete-lane finalization removes targeted subset sealing, but an
  actor may still finalize the whole lane set after grace while timely intents
  remain unaggregated.
- The one-epoch grace is an aggregation opportunity, not a completeness proof.
- Intent creation still does not enforce one confirmable live intent per
  represented voter across separate transactions. Aggregation prevents double
  counting, but the first valid conflicting intent aggregated determines the
  counted choice.
- Current delegated intent capacity is supplied by the delegate and refunded
  to the represented delegator. The planned principal-funded permit design is
  not implemented.
- There is no built-in maintenance reward, formal security audit, automatic
  treasury execution, or production-grade dedicated indexer.

## Next Step

1. Complete the final implementation
2. Deploy the approved binary as a new testnet code cell without recycling the
   historical code cell.
3. Run and record a connected-wallet, multi-actor, real-node lifecycle covering
   create, direct/delegated vote, third-party aggregation, full-set
   finalization, merge, creator close, force-close, revoke, late refund, and
   post-close omitted-intent refund.
4. Finish the canonical represented-principal, singleton vote-authority, and
   principal-funded delegation design before freezing the SDK v1 voting API.
5. Keep vote-completeness architecture as a separate reviewed decision.
