# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 18th May, 2026 - 25th May, 2026

## Focus of the Week

This update covers **Phase B**. The focus of the week was to make vote aggregation permissionless under CKB cell-model constraints, while preserving refund safety, poll lifecycle rules, and other invariants. This was achieved by introducing a new governance-controlled intent lock policy and aligning the frontend builders to emit intent cells under that new policy, while keeping refund ownership bound to the existing `refund_lock` in intent data.


## Progress Summary

- I updated the Rust governance contract to remove the old assumption that a vote intent output lock must equal `refund_lock`.
- I introduced the Phase B intent lock policy so intent cells are governance-locked for transition control, while refund ownership stays bound to `refund_lock` in intent data.
- I preserved refund safety by keeping `refund_lock` immutable across transitions and by keeping close/force-close refunds script-bound to that stored refund destination.
- I hardened intent lifecycle validation so an intent input cannot disappear without a valid aggregate or close context proving that the spend is safe.
- I aligned the frontend transaction builders to emit the new Phase B intent lock and to stop assuming voter lock signatures are required for aggregation.
- I upgraded the multi-actor smoke flow so third-party aggregation without voter lock signatures is now the expected happy path.
- I redeployed the updated contract and verified the behavior on CKB testnet.

## Phase B Contract Alignment

- `CREATE_VOTE_INTENT` now accepts the new governance-controlled intent lock policy instead of requiring `output_lock == refund_lock`.
- `AGGREGATE_VOTES` now supports third-party aggregation without voter lock signatures while preserving:
  - poll binding
  - voter identity binding
  - option immutability
  - epoch immutability
  - refund lock immutability
  - capacity preservation
- `CLOSE_POLL` and force-close logic still refund to `refund_lock`.
- The frontend builder now emits intent cells with the new governance lock and keeps `refund_lock` only as refund ownership data.

## Verified Outcomes

- Contract build passed locally in release mode.
- Frontend tests passed: `28/28`.
- Frontend production build passed.
- Testnet deployment succeeded with:
  - `GOVERNANCE_SCRIPT_TX_HASH=0x1af123e290e7e843a0314ccf18d06b28d87aaaf2772fd88edd210c4b8568bca6`
  - `GOVERNANCE_CODE_HASH=0x25965bddb0c73961296fbbeb538cf854eed55fa8d3c12efff6eaa3f1e3d56856`
- Multi-actor smoke verified:
  - `third_party_aggregate_without_voter_auth` => pass
  - `aggregate_with_all_voter_auth` => pass
  - `force_close_before_grace_by_non_creator` => fail, as expected
  - `force_close_after_grace_by_non_creator` => skip, because testnet tip had not yet reached the required after-grace epoch

## Future Work

- After the first redeploy, aggregation still failed on-chain because governance-lock validation for consumed intent inputs was too strict. I will fixed that by allowing governance-locked intent consumption in a proven aggregate context while still blocking unsafe standalone consumption.
- The after-grace force-close success path is still epoch-dependent, so that scenario could only be reported as an allowed skip in this cycle. I will re-run that path once the testnet tip reaches the required epoch to verify it as an on-chain pass.
- Re-run the after-grace force-close path once the testnet tip reaches the required epoch, so that scenario is verified as an on-chain pass instead of a skip.
- Sync the final governance deployment hashes to any hosted environment that may still reference an older deployment.
- Add README documentation for the updated contract behavior.
- Add more explicit adversarial smoke coverage for paths such as cross-poll intent injection and refund-mutation attempts, even though the underlying contract invariants were preserved in this phase.
- Keep future work separate from this phase, especially:
  - aggregate serialization bottleneck reduction
  - larger batch/indexing improvements
  - broader protocol extensions outside Phase B
