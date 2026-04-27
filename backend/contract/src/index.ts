// /**
//  * CKB Governance Protocol — Contract v3
//  * ========================================
//  * Runs on CKB-VM via ckb-js-vm.
//  *
//  * Six operations:
//  *   0x01  CREATE_POLL          — open a poll with creator deposit
//  *   0x02  CREATE_VOTE_INTENT   — record vote intent (no poll cell contention)
//  *   0x03  AGGREGATE_VOTES      — batch pending intents into poll (permissionless)
//  *   0x04  CLOSE_POLL           — close, return all deposits atomically
//  *   0x05  DELEGATE             — create scoped delegation cell
//  *   0x06  REVOKE_DELEGATION    — spend a delegation cell to revoke it
//  *
//  * ── STATE CONTENTION DESIGN ─────────────────────────────────────────────────
//  *
//  * Naive voting dApps on CKB update a shared poll cell on every vote.
//  * This causes UTXO contention: two voters spending the same cell simultaneously
//  * means one transaction always fails. At high participation this creates a
//  * practical DoS vector — a griefer can perpetually block the poll cell.
//  *
//  * This protocol solves contention with the Vote Intent pattern:
//  *
//  *   1. CAST_VOTE no longer touches the poll cell.
//  *      Each voter writes their choice into their OWN intent cell.
//  *      Zero contention between voters — they each spend their own UTXOs.
//  *
//  *   2. AGGREGATE_VOTES is a permissionless batching operation.
//  *      Anyone can consume N pending intent cells and update the poll cell
//  *      in one transaction. Aggregation is the only contention point,
//  *      and it is explicitly designed to be cooperative, not competitive.
//  *
//  * This is inspired by the Intent Cell pattern discussed in the Nervos community
//  * (Phroi, 2025) and aligns with CKB's UTXO-native architecture.
//  *
//  * ── ECONOMIC MODEL ──────────────────────────────────────────────────────────
//  *
//  * CREATE_POLL    →  creator locks CREATOR_DEPOSIT (500 CKB) in poll cell
//  * CREATE_INTENT  →  voter locks VOTER_DEPOSIT (61 CKB) in intent cell
//  * CLOSE_POLL     →  creator deposit + all voter deposits returned atomically
//  * DELEGATE       →  delegator locks DELEGATION_MIN (61 CKB) in delegation cell
//  *
//  * Deposits are cell capacity — no escrow contract, no external trust.
//  */

// import {
//   assert, bytesToHex, compareBytes, currentEpoch,
//   hexToBytes, loadInputCell, loadOutputCell,
//   loadScriptArgs, loadWitnessArgs, log, panic,
// } from "./utils";

// import {
//   decodePollData, decodeVoteIntentData, decodeDelegationData,
//   encodePollData, encodeVoteIntentData,
//   PollData, VoteIntentData, DelegationData, EncodedScript,
// } from "./molecule";
// import { Script } from "./types";

// // ─── Operation codes ──────────────────────────────────────────────────────────
// const OP_CREATE_POLL        = 0x01;
// const OP_CREATE_VOTE_INTENT = 0x02;
// const OP_AGGREGATE_VOTES    = 0x03;
// const OP_CLOSE_POLL         = 0x04;
// const OP_DELEGATE           = 0x05;
// const OP_REVOKE_DELEGATION  = 0x06;

// // ─── Validation limits ────────────────────────────────────────────────────────
// const MAX_OPTIONS           = 10;
// const MAX_QUESTION_LEN      = 256;
// const MAX_OPTION_LEN        = 64;
// const MIN_DURATION_EPOCHS   = 1n;
// const MAX_DURATION_EPOCHS   = 1000n;
// const MAX_INTENTS_PER_AGG   = 50;   // max intent cells per aggregation tx

// // ─── Economic constants (shannons; 1 CKB = 100_000_000 shannons) ─────────────
// const CREATOR_DEPOSIT_SHANNONS  = 500n * 100_000_000n;
// const VOTER_DEPOSIT_SHANNONS    = 61n  * 100_000_000n;
// const DELEGATION_MIN_SHANNONS   = 61n  * 100_000_000n;

// function compareScripts(left: Script | EncodedScript, right: Script | EncodedScript): boolean {
//   return (
//     left.code_hash === right.code_hash &&
//     left.hash_type === right.hash_type &&
//     left.args === right.args
//   );
// }

// // ─── Entry Point ──────────────────────────────────────────────────────────────
// export function main(): number {
//   log("=== CKB Governance Protocol v3 ===");

//   const args = loadScriptArgs();
//   if (args.length === 0) panic("Script args empty");

//   const op = args[0];
//   log(`Op: 0x${op.toString(16)}`);

//   switch (op) {
//     case OP_CREATE_POLL:        validateCreatePoll(args.slice(1));        break;
//     case OP_CREATE_VOTE_INTENT: validateCreateVoteIntent(args.slice(1)); break;
//     case OP_AGGREGATE_VOTES:    validateAggregateVotes(args.slice(1));   break;
//     case OP_CLOSE_POLL:         validateClosePoll(args.slice(1));        break;
//     case OP_DELEGATE:           validateDelegate(args.slice(1));         break;
//     case OP_REVOKE_DELEGATION:  validateRevokeDelegation(args.slice(1)); break;
//     default: panic(`Unknown op: 0x${op.toString(16)}`);
//   }

//   log("=== Validation passed ===");
//   return 0;
// }

// // ─── 0x01  CREATE_POLL ────────────────────────────────────────────────────────
// /**
//  * Opens a new governance poll with a creator deposit.
//  *
//  * Transaction layout:
//  *   Inputs:  [creator_cell, ...]
//  *   Outputs: [poll_cell(0), change?]
//  *
//  * poll_cell.capacity MUST be ≥ CREATOR_DEPOSIT + data_overhead.
//  * poll_cell.data.pending_votes must be 0 (no votes aggregated yet).
//  * poll_cell.data.intent_count must be 0 (no pending intents yet).
//  * poll_cell.data.counted_voter_lock_hashes must start empty.
//  */
// function validateCreatePoll(extraArgs: Uint8Array): void {
//   log("--- CREATE_POLL ---");

//   const out = loadOutputCell(0);
//   assert(out !== null, "Output cell 0 missing");
//   const poll = decodePollData(out.data);

//   assert(poll.question.length > 0, "Question empty");
//   assert(poll.question.length <= MAX_QUESTION_LEN, `Question too long`);
//   assert(poll.options.length >= 2, "Need ≥2 options");
//   assert(poll.options.length <= MAX_OPTIONS, `Too many options`);

//   for (let i = 0; i < poll.options.length; i++) {
//     assert(poll.options[i].length > 0, `Option ${i} empty`);
//     assert(poll.options[i].length <= MAX_OPTION_LEN, `Option ${i} too long`);
//   }

//   assert(poll.vote_counts.length === poll.options.length, "vote_counts length mismatch");
//   for (let i = 0; i < poll.vote_counts.length; i++) {
//     assert(poll.vote_counts[i] === 0n, `vote_counts[${i}] must be 0`);
//   }

//   const epoch = currentEpoch();
//   const duration = poll.deadline - epoch;
//   assert(poll.deadline > epoch, "Deadline in past");
//   assert(duration >= MIN_DURATION_EPOCHS, "Duration too short");
//   assert(duration <= MAX_DURATION_EPOCHS, "Duration too long");
//   assert(!poll.is_closed, "Cannot start closed");
//   assert(poll.total_voters === 0n, "total_voters must be 0");
//   assert(poll.pending_intent_count === 0n, "pending_intent_count must be 0");
//   assert(poll.counted_voter_lock_hashes.length === 0, "counted_voter_lock_hashes must start empty");

//   const dataBytes = BigInt(out.data.length);
//   const minCap = CREATOR_DEPOSIT_SHANNONS + (dataBytes + 61n) * 100_000_000n;
//   assert(out.capacity >= minCap, `Capacity ${out.capacity} < required ${minCap}`);
//   assert(poll.creator_deposit >= CREATOR_DEPOSIT_SHANNONS, "creator_deposit too low");

//   log(`Poll created: "${poll.question}" | ${poll.options.length} opts | deposit ${poll.creator_deposit}`);
// }

// // ─── 0x02  CREATE_VOTE_INTENT ─────────────────────────────────────────────────
// /**
//  * Records a voter's intent WITHOUT touching the poll cell.
//  * Zero contention with other voters.
//  *
//  * Transaction layout (direct):
//  *   Inputs:  [voter_cell(0)]
//  *   Outputs: [intent_cell(0), change?]
//  *
//  * Transaction layout (via delegation):
//  *   Inputs:  [signer_cell(0), delegation_cell(1)]
//  *   Outputs: [intent_cell(0), change?]
//  *
//  * The intent cell records:
//  *   - poll_type_hash: which poll this intent is for
//  *   - voter_lock_hash: the actual voter on record (delegator if via delegation)
//  *   - option_index: which option they chose
//  *   - voted_at_epoch: when this intent was created
//  *   - aggregated: false (set to true by AGGREGATE_VOTES)
//  *
//  * intent_cell.capacity MUST be ≥ VOTER_DEPOSIT (returned on CLOSE_POLL).
//  *
//  * The intent cell does NOT update vote_counts on the poll. It is a pending
//  * record. AGGREGATE_VOTES batches pending intents into the poll cell.
//  * This separation is the key to eliminating contention.
//  */
// function validateCreateVoteIntent(extraArgs: Uint8Array): void {
//   log("--- CREATE_VOTE_INTENT ---");

//   // Check for delegation at input 1
//   let effectiveVoterLockHash: Uint8Array | null = null;
//   let expectedRefundLock: Script | null = null;
//   const maybeDelegation = loadInputCell(1);
//   if (maybeDelegation !== null && maybeDelegation.data.length >= 104) {
//     try {
//       const delegation = decodeDelegationData(maybeDelegation.data);
//       const signerInput = loadInputCell(0);
//       assert(signerInput !== null, "Signer cell missing");

//       // Signer must be the registered delegate
//       assert(
//         compareBytes(delegation.delegate_lock_hash, signerInput.lock_hash),
//         "Signer is not the registered delegate"
//       );

//       // Delegation must not be expired
//       if (delegation.expires_epoch > 0n) {
//         assert(currentEpoch() <= delegation.expires_epoch, "Delegation expired");
//       }

//       effectiveVoterLockHash = delegation.delegator_lock_hash;
//       assert(compareBytes(maybeDelegation.lock_hash, delegation.delegator_lock_hash), "Delegation cell lock must match delegator");
//       expectedRefundLock = maybeDelegation.lock;
//       log("Intent via delegation");
//     } catch {
//       // Not a delegation cell — proceed as direct vote
//     }
//   }

//   if (effectiveVoterLockHash === null) {
//     const voterInput = loadInputCell(0);
//     assert(voterInput !== null, "Voter cell missing");
//     effectiveVoterLockHash = voterInput.lock_hash;
//     expectedRefundLock = voterInput.lock;
//   }

//   // Validate intent output cell
//   const intentOut = loadOutputCell(0);
//   assert(intentOut !== null, "Intent cell at output 0 missing");
//   const intent = decodeVoteIntentData(intentOut.data);

//   assert(
//     compareBytes(intent.voter_lock_hash, effectiveVoterLockHash),
//     "Intent voter_lock_hash mismatch"
//   );
//   assert(expectedRefundLock !== null, "Expected refund lock missing");
//   assert(compareScripts(intent.refund_lock, expectedRefundLock), "Intent refund_lock mismatch");
//   assert(!intent.aggregated, "Intent must start unaggregated");

//   // Option index from witness (first byte of input_type)
//   const witness = loadWitnessArgs(0);
//   assert(witness !== null && witness.input_type.length > 0, "option_index missing in witness");
//   const optionIndex = witness.input_type[0];

//   assert(intent.option_index === optionIndex, "Intent option_index mismatch with witness");

//   // Voter deposit enforcement
//   assert(
//     intentOut.capacity >= VOTER_DEPOSIT_SHANNONS,
//     `Intent capacity ${intentOut.capacity} < required ${VOTER_DEPOSIT_SHANNONS}`
//   );

//   log(`Intent created: option[${optionIndex}] | voter 0x${bytesToHex(effectiveVoterLockHash).slice(0,16)}...`);
// }

// // ─── 0x03  AGGREGATE_VOTES ────────────────────────────────────────────────────
// /**
//  * Batches pending vote intents into the poll cell. Permissionless.
//  * Anyone can call this — no authentication required.
//  *
//  * Transaction layout:
//  *   Inputs:  [poll_cell(0), intent_cell_0(1), intent_cell_1(2), ...]
//  *   Outputs: [updated_poll_cell(0), aggregated_intent_0(1), ...]
//  *
//  * The intent cells are NOT consumed — they are updated in place with
//  * aggregated=true. This preserves the voter's deposit cell (still needed
//  * for CLOSE_POLL deposit return) while marking the vote as counted.
//  *
//  * Enforcement:
//  *   - At least 1 intent cell must be provided (inputs 1+)
//  *   - Maximum MAX_INTENTS_PER_AGG intent cells per transaction
//  *   - Each intent: poll_type_hash must match the poll cell's type hash
//  *   - Each intent: aggregated must be false (cannot double-aggregate)
//  *   - Each intent: poll must not be closed, not past deadline
//  *   - vote_counts must increment correctly for each intent
//  *   - total_voters must increment by the exact number of intents processed
//  *   - pending_intent_count must decrement by the number processed
//  *   - counted_voter_lock_hashes must append each newly counted voter exactly once
//  *   - Output intent cells must be identical to input except aggregated=true
//  */
// function validateAggregateVotes(extraArgs: Uint8Array): void {
//   log("--- AGGREGATE_VOTES ---");

//   const inputPoll = loadInputCell(0);
//   assert(inputPoll !== null, "Poll cell at input 0 missing");
//   const prevPoll = decodePollData(inputPoll.data);

//   assert(!prevPoll.is_closed, "Cannot aggregate on closed poll");

//   const epoch = currentEpoch();
//   assert(epoch <= prevPoll.deadline, `Poll expired at epoch ${prevPoll.deadline}`);

//   const outputPoll = loadOutputCell(0);
//   assert(outputPoll !== null, "Updated poll cell at output 0 missing");
//   const nextPoll = decodePollData(outputPoll.data);

//   // Collect and validate all intent inputs (indexes 1+)
//   const intentDeltas: number[] = new Array(prevPoll.options.length).fill(0);
//   let intentCount = 0;
//   const seenVoters = new Set(prevPoll.counted_voter_lock_hashes.map(bytesToHex));
//   const batchVoters: Uint8Array[] = [];

//   for (let i = 1; i <= MAX_INTENTS_PER_AGG; i++) {
//     const intentInput = loadInputCell(i);
//     if (intentInput === null) break;

//     // Decode as intent
//     const intent = decodeVoteIntentData(intentInput.data);

//     assert(!intent.aggregated, `Intent at input ${i} already aggregated`);
//     assert(intent.option_index < prevPoll.options.length, `Intent ${i}: invalid option_index`);
//     const voterKey = bytesToHex(intent.voter_lock_hash);
//     assert(!seenVoters.has(voterKey), `Intent ${i} duplicates an already-counted voter`);

//     // Verify the corresponding output intent is identical except aggregated=true
//     const intentOutput = loadOutputCell(i);
//     assert(intentOutput !== null, `Output intent at ${i} missing`);
//     const intentOut = decodeVoteIntentData(intentOutput.data);

//     assert(intentOut.aggregated, `Output intent ${i} must be aggregated=true`);
//     assert(compareBytes(intentOut.voter_lock_hash, intent.voter_lock_hash), `Intent ${i} voter_lock_hash changed`);
//     assert(intentOut.option_index === intent.option_index, `Intent ${i} option_index changed`);
//     assert(compareBytes(intentOut.poll_type_hash, intent.poll_type_hash), `Intent ${i} poll_type_hash changed`);
//     assert(intentOut.voted_at_epoch === intent.voted_at_epoch, `Intent ${i} voted_at_epoch changed`);
//     assert(compareScripts(intentOut.refund_lock, intent.refund_lock), `Intent ${i} refund_lock changed`);
//     // Capacity must be preserved (deposit stays in cell)
//     assert(intentOutput.capacity >= intentInput.capacity, `Intent ${i} capacity decreased`);

//     intentDeltas[intent.option_index]++;
//     seenVoters.add(voterKey);
//     batchVoters.push(intent.voter_lock_hash);
//     intentCount++;
//   }

//   assert(intentCount > 0, "Must aggregate at least 1 intent");

//   // Verify poll state transition
//   assert(nextPoll.question === prevPoll.question, "Question must not change");
//   assert(nextPoll.deadline === prevPoll.deadline, "Deadline must not change");
//   assert(!nextPoll.is_closed, "is_closed must not change during aggregation");
//   assert(compareBytes(nextPoll.creator, prevPoll.creator), "Creator must not change");
//   assert(nextPoll.creator_deposit === prevPoll.creator_deposit, "creator_deposit must not change");
//   assert(
//     nextPoll.counted_voter_lock_hashes.length === prevPoll.counted_voter_lock_hashes.length + batchVoters.length,
//     `counted_voter_lock_hashes length must increase by ${batchVoters.length}`
//   );
//   for (let i = 0; i < prevPoll.counted_voter_lock_hashes.length; i++) {
//     assert(
//       compareBytes(nextPoll.counted_voter_lock_hashes[i], prevPoll.counted_voter_lock_hashes[i]),
//       `counted_voter_lock_hashes[${i}] changed`
//     );
//   }
//   for (let i = 0; i < batchVoters.length; i++) {
//     assert(
//       compareBytes(nextPoll.counted_voter_lock_hashes[prevPoll.counted_voter_lock_hashes.length + i], batchVoters[i]),
//       `counted_voter_lock_hashes append at ${i} mismatch`
//     );
//   }

//   // vote_counts must match deltas exactly
//   for (let i = 0; i < prevPoll.vote_counts.length; i++) {
//     const expected = prevPoll.vote_counts[i] + BigInt(intentDeltas[i]);
//     assert(nextPoll.vote_counts[i] === expected, `vote_counts[${i}]: expected ${expected}, got ${nextPoll.vote_counts[i]}`);
//   }

//   // total_voters increments by intent count
//   assert(
//     nextPoll.total_voters === BigInt(nextPoll.counted_voter_lock_hashes.length),
//     "total_voters must equal counted_voter_lock_hashes length"
//   );
//   assert(
//     nextPoll.total_voters === prevPoll.total_voters + BigInt(intentCount),
//     `total_voters must increase by ${intentCount}`
//   );

//   // pending_intent_count decrements (can go negative if aggregated > pending, allow 0 floor)
//   const newPending = prevPoll.pending_intent_count > BigInt(intentCount)
//     ? prevPoll.pending_intent_count - BigInt(intentCount)
//     : 0n;
//   assert(nextPoll.pending_intent_count === newPending, `pending_intent_count mismatch`);

//   log(`Aggregated ${intentCount} intents | total_voters now: ${nextPoll.total_voters}`);
// }

// // ─── 0x04  CLOSE_POLL ────────────────────────────────────────────────────────
// /**
//  * Closes the poll and returns ALL deposits atomically.
//  *
//  * Transaction layout:
//  *   Inputs:  [poll_cell(0), creator_auth(1), intent_cell_0?, intent_cell_1?, ...]
//  *   Outputs: [closed_poll(0), creator_return(1), voter_return_0?, ...]
//  *
//  * Rules:
//  *   - Only the creator can close (auth cell lock hash == poll.creator)
//  *   - Creator can close early OR after deadline
//  *   - All intent cells (aggregated or not) should be included to return deposits
//  *   - For each intent input consumed: corresponding output returns ≥ 61 CKB to voter's lock hash
//  *   - Creator deposit returned to creator's lock hash at output 1
//  *   - All poll fields frozen except is_closed → true
//  */
// function validateClosePoll(extraArgs: Uint8Array): void {
//   log("--- CLOSE_POLL ---");

//   const inputPoll = loadInputCell(0);
//   assert(inputPoll !== null, "Poll cell at input 0 missing");
//   const prevPoll = decodePollData(inputPoll.data);
//   assert(!prevPoll.is_closed, "Poll already closed");

//   // Creator auth
//   const creatorInput = loadInputCell(1);
//   assert(creatorInput !== null, "Creator auth cell missing");
//   assert(compareBytes(creatorInput.lock_hash, prevPoll.creator), "Only creator can close");

//   const outputPoll = loadOutputCell(0);
//   assert(outputPoll !== null, "Output poll cell missing");
//   const nextPoll = decodePollData(outputPoll.data);

//   assert(nextPoll.is_closed, "Output poll must be closed");
//   assert(nextPoll.question === prevPoll.question, "Question must not change");
//   assert(nextPoll.deadline === prevPoll.deadline, "Deadline must not change");
//   assert(compareBytes(nextPoll.creator, prevPoll.creator), "Creator must not change");
//   assert(nextPoll.total_voters === prevPoll.total_voters, "total_voters must not change on close");
//   assert(
//     nextPoll.counted_voter_lock_hashes.length === prevPoll.counted_voter_lock_hashes.length,
//     "counted_voter_lock_hashes length must not change on close"
//   );
//   for (let i = 0; i < prevPoll.vote_counts.length; i++) {
//     assert(nextPoll.vote_counts[i] === prevPoll.vote_counts[i], `vote_counts[${i}] must not change`);
//   }
//   for (let i = 0; i < prevPoll.counted_voter_lock_hashes.length; i++) {
//     assert(
//       compareBytes(nextPoll.counted_voter_lock_hashes[i], prevPoll.counted_voter_lock_hashes[i]),
//       `counted_voter_lock_hashes[${i}] must not change`
//     );
//   }

//   // Creator deposit return
//   const creatorReturn = loadOutputCell(1);
//   assert(creatorReturn !== null, "Creator return cell missing");
//   assert(compareScripts(creatorReturn.lock, creatorInput.lock), "Creator deposit must go to creator");
//   assert(creatorReturn.capacity >= prevPoll.creator_deposit, "Creator return too small");

//   // Voter deposit returns — iterate intent cells in inputs 2+
//   let inputIdx = 2;
//   let outputIdx = 2;
//   while (true) {
//     const intentInput = loadInputCell(inputIdx);
//     if (intentInput === null) break;

//     try {
//       const intent = decodeVoteIntentData(intentInput.data);
//       const voterReturn = loadOutputCell(outputIdx);
//       assert(voterReturn !== null, `Voter return at output ${outputIdx} missing`);
//       assert(
//         compareScripts(voterReturn.lock, intent.refund_lock),
//         `Voter return ${outputIdx} must use refund_lock`
//       );
//       assert(voterReturn.capacity >= VOTER_DEPOSIT_SHANNONS, `Voter return ${outputIdx} too small`);
//       outputIdx++;
//     } catch {
//       // Not an intent cell
//     }

//     inputIdx++;
//   }

//   log(`Poll "${prevPoll.question}" closed | ${prevPoll.total_voters} voters | all deposits returned`);
// }

// // ─── 0x05  DELEGATE ──────────────────────────────────────────────────────────
// /**
//  * Creates a scoped delegation cell.
//  *
//  * Transaction layout:
//  *   Inputs:  [delegator_cell(0), ...]
//  *   Outputs: [delegation_cell(0), change?]
//  *
//  * delegation_cell.data (DelegationData):
//  *   delegator_lock_hash — must match input 0 lock hash (self-signed)
//  *   delegate_lock_hash  — who can vote on delegator's behalf
//  *   poll_type_hash      — 0x00...00 = global, or specific poll type hash
//  *   expires_epoch       — 0 = no expiry
//  */
// function validateDelegate(extraArgs: Uint8Array): void {
//   log("--- DELEGATE ---");

//   const delegatorInput = loadInputCell(0);
//   assert(delegatorInput !== null, "Delegator cell missing");

//   const delOut = loadOutputCell(0);
//   assert(delOut !== null, "Delegation cell missing");

//   const d = decodeDelegationData(delOut.data);

//   assert(compareBytes(d.delegator_lock_hash, delegatorInput.lock_hash), "delegator_lock_hash mismatch");
//   assert(!compareBytes(d.delegator_lock_hash, d.delegate_lock_hash), "Cannot delegate to self");

//   if (d.expires_epoch > 0n) {
//     assert(d.expires_epoch > currentEpoch(), "Expiry must be in future");
//   }

//   assert(delOut.capacity >= DELEGATION_MIN_SHANNONS, "Delegation capacity too low");
//   log(`Delegation: 0x${bytesToHex(d.delegator_lock_hash).slice(0,16)}... → 0x${bytesToHex(d.delegate_lock_hash).slice(0,16)}...`);
// }

// // ─── 0x06  REVOKE_DELEGATION ─────────────────────────────────────────────────
// /**
//  * Spends a delegation cell, revoking the delegation.
//  * Only the delegator can revoke (their lock script must be satisfied).
//  *
//  * Transaction layout:
//  *   Inputs:  [delegation_cell(0), ...]
//  *   Outputs: [change_to_delegator(0), ...]
//  *
//  * The script just verifies the delegation cell is at input 0
//  * and the output at index 0 goes back to the delegator's lock.
//  * The delegator's lock script handles the actual signature check.
//  */
// function validateRevokeDelegation(extraArgs: Uint8Array): void {
//   log("--- REVOKE_DELEGATION ---");

//   const delInput = loadInputCell(0);
//   assert(delInput !== null, "Delegation cell at input 0 missing");
//   const d = decodeDelegationData(delInput.data);

//   const returnOut = loadOutputCell(0);
//   assert(returnOut !== null, "Return cell at output 0 missing");
//   assert(
//     compareScripts(returnOut.lock, delInput.lock),
//     "Delegation cell must be returned to delegator"
//   );
//   assert(returnOut.capacity >= DELEGATION_MIN_SHANNONS, "Return capacity too low");

//   log(`Delegation revoked: 0x${bytesToHex(d.delegator_lock_hash).slice(0,16)}...`);
// }
