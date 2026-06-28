# Builder Track Weekly Status Update

**Name:** Anih Soma (AnihDev)  
**Duration:** 1st June, 2026 - 7th June, 2026

## Focus of the Week

This update covers the ZK direction review after publishing the current ZK plan for the CKB governance protocol. The main focus was to evaluate whether the external resources shared by the community are relevant to this work, especially Cecilia's Groth16 verifier work and XuJiandong's CKB voting zkVM PoC.

The conclusion is that the governance protocol should keep its current CKB-native intent-cell architecture and treat ZK as an aggregation-verification extension, not as a replacement for the operation contract model. Cecilia's Groth16 verifier is directly relevant as possible verifier infrastructure, while the zkVM voting PoC is useful mainly as design reference for proof binding, permissionless settlement, and future stake-weighted voting.

## Progress Summary

- Reviewed the local ZK plan and clarified the intended path:
  - use ZK for assisted aggregation correctness first
  - keep vote intent cells as the base voting primitive
  - keep the poll cell update atomic with the consumed intent inputs
  - treat private eligibility as a later-stage extension, not the first ZK milestone
- Reviewed the community pointer to Cecilia's work:
  - Cecilia's Spectre project is a CKB key recovery protocol, not a voting protocol
  - the reusable part for this project is her standalone `groth16-ckb` verifier
  - the verifier targets BN254 Groth16 on CKB-VM using arkworks
  - the verifier is pre-audit infrastructure and should not be treated as mainnet-ready yet
- Reviewed the referenced `ckb-vote-poc` design:
  - it uses a zkVM/SP1 style model that proves facts over block ranges
  - it explores DAO-weighted voting, vote replacement, and permissionless settlement
  - it is not a drop-in replacement for this repository because this project already uses live intent cells, refundable deposits, delegation, aggregation, and close/force-close paths
- Identified the main implementation implication:
  - the current ZK plan's verifier-cycle target is too optimistic if using the available Groth16 verifier numbers
  - public inputs must be kept compact because each additional public input increases verification cost


## Known Limits

- Groth16 requires a trusted setup per circuit, so circuit changes need careful versioning.
- The verifier infrastructure is pre-audit, so this should remain testnet/PoC work.
- ZK aggregation does not remove poll-cell aggregation serialization by itself; it proves batch correctness but still updates one poll state cell.
- The current intent-cell model already supports permissionless aggregation, so the ZK work must justify itself through stronger correctness proofs, privacy extensions, or scalable future vote-weight rules.
- Private eligibility and voter-choice privacy require a separate design and should not be bundled into the first aggregation PoC.

## MVP Risk Controls

- Transparent intent cells remain public, so the MVP must be described as ZK-assisted aggregation correctness rather than private voting.
- Poll-cell serialization remains in the MVP. The mitigation is larger proven batches first, with sharded tally cells or commitment registries left for post-MVP work.
- Groth16 circuit changes require explicit circuit versioning and verifying key hash tracking.
- Cecilia's verifier should be integrated as pre-audit testnet infrastructure only, with the non-ZK aggregation path left in place.
- Proof public inputs must bind to the exact poll, previous poll data, output poll data, consumed intent batch, tally deltas, voter delta, and circuit version.

## Next Step

The immediate next step is to implement Phase Z1 from `zk_plan.md`: define the public input encoding, intent batch digest, poll state digest, circuit version constants, and verifier key tracking before any contract changes are made.

After that, the best external action is to contact Cecilia with the concrete integration ask above and request feedback on whether `groth16-ckb` is suitable for this aggregation proof shape.
