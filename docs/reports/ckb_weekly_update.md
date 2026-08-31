# Builder Track Weekly Status Update


**Name:** Anih Soma (AnihDev)
**Duration:** 8th May, 2026 - 17th May, 2026


## Focus of the Week

This update is structured to address response from the developer assigned to the this project, and to clarify the focus and progress of the work done in this period.

So I split the reviewers' remarks into two phases to for Easy tracking of what has been done and what is still pending. The focus of the week is to complete the Phase A work, which is largely about hardening the current CKB-native multi-actor governance flow and validating reviewer concerns. The progress summary highlights the key achievements in implementing the multi-actor smoke test, adding deploy-time role setup and funding utilities.

## Progress Summary

- Implemented and stabilized a full multi-actor smoke runner:
  - creator creates poll
  - multiple voters submit vote intents
  - third-party aggregator without voter auth fails (expected)
  - aggregate with all required voter auth passes (expected)
  - non-creator force-close before grace fails (expected)
  - non-creator force-close after grace is now modeled as pass-or-skip:
    - pass when chain tip has reached `deadline + grace + 1`
    - skip when testnet tip has not reached the required epoch yet


### Contract-Alignment Fixes

- Fixed intent transition lock validation to use group output context during aggregation, matching CKB script-group semantics.
- Relaxed aggregate scanning logic to skip non-intent fee/change cells instead of hard-failing decode, preserving CKB transaction composition flexibility.


## Reviewer Feedback Addressed in Phase A

- Concern: project only proved single-signer path.
  - Addressed by a role-separated smoke flow and explicit expected-fail scenarios.
- Concern: aggregation assumptions were unclear under voter-owned locks.
  - Addressed by proving third-party aggregate fail and all-voter-auth aggregate pass.
- Concern: close/force-close timing needed concrete evidence.
  - Addressed by before-grace fail checks and after-grace pass-or-skip scenario gating.

## Known Limits

- Current architecture is still constrained by voter-owned intent locks.
- Aggregation remains serialized through poll cell transitions.
- Large pending intent sets still require sequential aggregate batches.
- These are CKB-UTXO tradeoffs that require explicit design changes for full permissionless aggregation.

## Next Step (Phase B)

The next action is to draft a **concrete CKB-native Option B migration spec** first, then review it before implementation.

The spec draft will include:

- State layout proposal:
  - poll state cells
  - intent representation and spend authority model
  - refund ownership invariants
- Spend-rule proposal:
  - how non-voter aggregators can consume intents safely
  - what signatures/proofs are required and where
  - anti-replay, anti-forgery, and refund guarantees
- Transition test matrix:
  - pass/fail cases for create intent, aggregate, close, force-close
  - adversarial scenarios and expected script failures

