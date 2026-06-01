ZK Plan — Implementation Roadmap

Purpose
This document defines a single, decisive PoC path for adding ZK‑assisted aggregation to the governance protocol and provides an execution roadmap.


Decision
Proceed immediately with a PoC that proves correctness over consumed intent inputs and updates the poll cell atomically in the same transaction. This approach is the fastest and lowest‑risk way to measure the real benefits of ZK for our protocol.

Overview
- An off‑chain aggregator gathers N pending intent cells, computes per‑option tally deltas, and generates a SNARK proof that those specific inputs produce the claimed deltas.
- The aggregator submits a transaction that consumes the poll cell and exactly those N intent inputs, includes the SNARK proof and public inputs, and outputs the updated poll cell with the new tally.

Why this approach
- Minimal protocol changes required: we can keep the existing intent submission flow and simply require that aggregators consume the intent cells they prove over.
- Canonical safety: by consuming inputs in the transaction we preserve on‑chain finality and remove replay ambiguity.
- Rapid, measurable feedback: we can quickly collect prover time, proof size, and verifier cost to decide on broader changes.

Transaction layout (example)
- Inputs: poll cell (current), intent[0..N-1] inputs
- Cell deps: governance code cell, verifier key cell
- Outputs: updated poll cell, aggregated intent marker outputs or change/fee outputs
- Witness / outputsData: SNARK proof π and public inputs (poll id, claimed tally deltas, optional consumed-outpoints digest)

Circuit responsibilities
- Verify that the private inputs correspond to the consumed intent inputs included in the transaction.
- Compute weight units and per-option deltas.
- Public outputs: per-option deltas and total voters delta bound to the transaction via public inputs.

Security and operational controls
- Binding: require proofs to include a digest of consumed outpoints or explicit binding to the transaction inputs so proofs cannot be replayed against different inputs.
- Optional challenge window: enable a short dispute period if the operational model requires an additional safety net.
- Rate limiting / stake: consider an aggregator deposit or rate limits to mitigate DoS risks from verification.

Bench plan & acceptance metrics
- Test sizes: K = 64, 256, 1024 intents per proof.
- Metrics: prover time, proof size, verifier time (native), estimated CKB‑VM cycles, tx size and fee.
- Targets: prover time < few minutes for K=1024 (PoC target), proof size < ~8KB, estimated verifier cycles < 10M.

Fallback contingency (if TX size becomes limiting)
- If transaction size or verifier cost makes consuming large N inputs impractical, we will iterate to a commitment‑first approach: add an on‑chain intent registry (Merkle root) and accept proofs that operate over that registry rather than consuming every intent input.
- For the PoC we use Groth16 to minimize verifier cost and proof size; for production we will evaluate PLONK/Halo2 for universal setups.
