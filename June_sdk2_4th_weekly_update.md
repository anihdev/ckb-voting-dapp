# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 22nd June, 2026 - 28th June, 2026

## Focus of the Week

This update covers a lighter governance-protocol week focused on proposal formalization, ecosystem positioning, and transition planning before the upcoming hackathon period.

The previous report established the project direction as a reusable DAO/SubDAO Builder SDK rather than a standalone DAO application. This week continued that direction by turning the SDK framing into a more official grant proposal structure and clarifying how the project should be presented to the CKB community.

There was limited new protocol implementation this week. The main reason is that I also spent time ideating for an upcoming hackathon and deciding what would be most useful to build during that event. The governance SDK work will pause during the event period so attention can stay focused there, then resume afterward with a clearer SDK implementation plan.

## Progress Summary

- Reviewed the previous DAO Builder SDK proposal direction and compared it against the CKB Community Fund DAO proposal process.
- Reviewed the structure of comparable ecosystem proposals, especially Vellum's reputation extension and CKBoost's community engagement proposal.
- Refined the grant direction around a reusable SDK rather than a standalone governance app.


## Known Limits

- The DAO Builder SDK is still a proposal and architecture direction, not an extracted package yet.
- The official grant proposal draft still needs personal details before it is ready for Nervos Talk.
- The current reference app is live, but the SDK packaging work has not started.
- Testnet demo planning exists in the proposal, but the dedicated SDK-style testnet demo has not been built yet.
- ZK/Groth16, private voting, reputation-weighted voting, and full DID/Vellum/CKBoost integrations remain out of scope for this grant phase.

## Hackathon Transition

The governance protocol work will go on break during the upcoming hackathon event period.

This is a temporary pause, not a change in direction. The goal is to avoid splitting focus between the DAO Builder SDK proposal and the hackathon build. After the event, the next governance step should be to convert the official proposal and SDK direction into a concrete implementation spec.

## Next Step After The Hackathon

Resume with:

1. Finalize the official grant proposal.
2. Create `DAO_BUILDER_SDK_SPEC.md`.
3. Define the SDK module boundary:
   - core protocol builders
   - shared codecs/constants
   - React hooks
   - reusable UI components
   - membership eligibility adapters
4. Decide what remains monorepo-local first and what can later become publishable packages.
5. Implement the first membership-cell adapter demo.
6. Return to runtime hardening after the SDK boundary is stable.
