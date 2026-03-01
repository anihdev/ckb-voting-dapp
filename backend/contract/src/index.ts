// /**
//  * CKB Voting dApp - Main Contract Script
//  * =======================================
//  * This TypeScript script runs on CKB-VM via ckb-js-vm.
//  * It validates all voting-related transactions.
//  *
//  * Entrypoint: main()
//  * Three operations: CREATE_POLL | CAST_VOTE | CLOSE_POLL
//  *
//  * File: backend/contract/src/index.ts
//  * Run:  npx ts-node src/index.ts (local sim), or build + deploy to CKB
//  */

// import {
//   CellInput,
//   CellOutput,
//   Script,
//   Transaction,
// } from "./types";
// import {
//   decodePollData,
//   decodeVoteData,
//   encodePollData,
//   encodeVoteData,
//   PollData,
//   VoteData,
// } from "./molecule";
// import {
//   assert,
//   bytesToHex,
//   compareBytes,
//   currentEpoch,
//   hexToBytes,
//   loadInputCell,
//   loadOutputCell,
//   loadScriptArgs,
//   loadWitnessArgs,
//   log,
//   panic,
// } from "./utils";

// // ─── Operation codes stored in the first byte of script args ─────────────────
// const OP_CREATE_POLL = 0x01;
// const OP_CAST_VOTE   = 0x02;
// const OP_CLOSE_POLL  = 0x03;

// // ─── Limits ───────────────────────────────────────────────────────────────────
// const MAX_OPTIONS        = 10;
// const MAX_QUESTION_LEN   = 256;
// const MAX_OPTION_LEN     = 64;
// const MIN_DURATION_EPOCHS = 1n;
// const MAX_DURATION_EPOCHS = 1000n;

// // ─── Entry Point ──────────────────────────────────────────────────────────────

// /**
//  * main() is called by ckb-js-vm.
//  * Returns 0 on success, panics (throws) on failure.
//  */
// export function main(): number {
//   log("=== CKB Voting Script Loaded ===");

//   const args = loadScriptArgs();
//   if (args.length === 0) {
//     panic("Script args are empty — cannot determine operation");
//   }

//   const opCode = args[0];
//   log(`Operation code: 0x${opCode.toString(16)}`);

//   switch (opCode) {
//     case OP_CREATE_POLL:
//       validateCreatePoll(args.slice(1));
//       break;
//     case OP_CAST_VOTE:
//       validateCastVote(args.slice(1));
//       break;
//     case OP_CLOSE_POLL:
//       validateClosePoll(args.slice(1));
//       break;
//     default:
//       panic(`Unknown operation code: 0x${opCode.toString(16)}`);
//   }

//   log("=== Script validation passed ===");
//   return 0;
// }

// // ─── Operation: CREATE_POLL ───────────────────────────────────────────────────

// /**
//  * Validates a Create Poll transaction.
//  *
//  * Expected layout:
//  *   Inputs:  [creator_cell, ...]       — any cell owned by creator
//  *   Outputs: [poll_cell, change_cell?] — poll_cell must be index 0
//  *
//  * Poll cell output data (Molecule-encoded PollData):
//  *   - question:     string (≤256 bytes)
//  *   - options:      string[] (2–10 options, each ≤64 bytes)
//  *   - vote_counts:  uint64[] (all zeros at creation)
//  *   - deadline:     uint64 (epoch number)
//  *   - creator:      bytes32 (lock script hash of creator)
//  *   - is_closed:    bool (must be false)
//  *   - total_voters: uint64 (must be 0)
//  */
// function validateCreatePoll(extraArgs: Uint8Array): void {
//   log("--- validateCreatePoll ---");

//   const output = loadOutputCell(0);
//   assert(output !== null, "Output cell at index 0 is missing");

//   const pollData = decodePollData(output.data);

//   // Question must be non-empty and within length limit
//   assert(
//     pollData.question.length > 0,
//     "Poll question cannot be empty"
//   );
//   assert(
//     pollData.question.length <= MAX_QUESTION_LEN,
//     `Poll question exceeds max length of ${MAX_QUESTION_LEN} bytes`
//   );

//   // Options: 2 minimum, 10 maximum
//   assert(
//     pollData.options.length >= 2,
//     "Poll must have at least 2 options"
//   );
//   assert(
//     pollData.options.length <= MAX_OPTIONS,
//     `Poll cannot have more than ${MAX_OPTIONS} options`
//   );

//   // Each option must be non-empty and within length limit
//   for (let i = 0; i < pollData.options.length; i++) {
//     const opt = pollData.options[i];
//     assert(opt.length > 0, `Option ${i} is empty`);
//     assert(
//       opt.length <= MAX_OPTION_LEN,
//       `Option ${i} exceeds max length of ${MAX_OPTION_LEN} bytes`
//     );
//   }

//   // vote_counts must match number of options and all be zero
//   assert(
//     pollData.vote_counts.length === pollData.options.length,
//     "vote_counts length must match options length"
//   );
//   for (let i = 0; i < pollData.vote_counts.length; i++) {
//     assert(
//       pollData.vote_counts[i] === 0n,
//       `vote_counts[${i}] must be 0 at creation`
//     );
//   }

//   // Deadline: must be a reasonable future epoch
//   const epoch = currentEpoch();
//   const deadline = pollData.deadline;
//   assert(
//     deadline > epoch,
//     `Deadline epoch ${deadline} must be in the future (current: ${epoch})`
//   );
//   const duration = deadline - epoch;
//   assert(
//     duration >= MIN_DURATION_EPOCHS,
//     `Poll duration too short: ${duration} epochs`
//   );
//   assert(
//     duration <= MAX_DURATION_EPOCHS,
//     `Poll duration too long: ${duration} epochs`
//   );

//   // Poll must not be closed at creation
//   assert(!pollData.is_closed, "Poll cannot be closed at creation");

//   // total_voters must be 0
//   assert(
//     pollData.total_voters === 0n,
//     "total_voters must be 0 at creation"
//   );

//   // Capacity: must be enough for data + overhead (61 bytes base + data)
//   const minCapacity = calculateMinCapacity(output.data.length, output.lock);
//   assert(
//     output.capacity >= minCapacity,
//     `Capacity ${output.capacity} is less than minimum required ${minCapacity}`
//   );

//   log(`Poll created: "${pollData.question}" with ${pollData.options.length} options`);
// }

// // ─── Operation: CAST_VOTE ─────────────────────────────────────────────────────

// /**
//  * Validates a Cast Vote transaction.
//  *
//  * Expected layout:
//  *   Inputs:  [poll_cell (index 0), voter_cell (index 1), ...]
//  *   Outputs: [updated_poll_cell (index 0), vote_receipt_cell (index 1), change_cell?]
//  *
//  * Rules:
//  *   1. Poll must not be closed
//  *   2. Poll must not be past deadline
//  *   3. option_index must be valid
//  *   4. Updated poll must increment correct vote_count by exactly 1
//  *   5. Updated poll must increment total_voters by exactly 1
//  *   6. Vote receipt cell must record voter lock hash + option index
//  *   7. All other poll fields must remain unchanged
//  */
// function validateCastVote(extraArgs: Uint8Array): void {
//   log("--- validateCastVote ---");

//   // Load input poll cell (index 0)
//   const inputPoll = loadInputCell(0);
//   assert(inputPoll !== null, "Input poll cell at index 0 is missing");
//   const prevPoll = decodePollData(inputPoll.data);

//   // Load output poll cell (index 0)
//   const outputPoll = loadOutputCell(0);
//   assert(outputPoll !== null, "Output poll cell at index 0 is missing");
//   const nextPoll = decodePollData(outputPoll.data);

//   // Poll must not already be closed
//   assert(!prevPoll.is_closed, "Cannot vote on a closed poll");

//   // Poll must not be past deadline
//   const epoch = currentEpoch();
//   assert(
//     epoch <= prevPoll.deadline,
//     `Poll has expired. Current epoch: ${epoch}, deadline: ${prevPoll.deadline}`
//   );

//   // Option index comes from witness args (first byte of input_type witness)
//   const witnessArgs = loadWitnessArgs(1); // voter witness at index 1
//   assert(witnessArgs !== null, "Voter witness args are missing");
//   assert(witnessArgs.input_type.length > 0, "option_index byte missing in witness");

//   const optionIndex = witnessArgs.input_type[0];
//   assert(
//     optionIndex < prevPoll.options.length,
//     `Invalid option index: ${optionIndex} (max: ${prevPoll.options.length - 1})`
//   );

//   // Load vote receipt output (index 1)
//   const receiptOutput = loadOutputCell(1);
//   assert(receiptOutput !== null, "Vote receipt cell at output index 1 is missing");
//   const voteData = decodeVoteData(receiptOutput.data);

//   // Vote receipt must record correct option_index
//   assert(
//     voteData.option_index === optionIndex,
//     `Receipt option_index ${voteData.option_index} doesn't match witness ${optionIndex}`
//   );

//   // Validate poll state transition: only vote_counts[optionIndex] and total_voters change
//   assert(
//     nextPoll.question === prevPoll.question,
//     "Poll question must not change"
//   );
//   assert(
//     nextPoll.options.length === prevPoll.options.length,
//     "Poll options count must not change"
//   );
//   assert(
//     nextPoll.deadline === prevPoll.deadline,
//     "Poll deadline must not change"
//   );
//   assert(
//     nextPoll.is_closed === prevPoll.is_closed,
//     "Poll is_closed must not change during voting"
//   );
//   assert(
//     compareBytes(nextPoll.creator, prevPoll.creator),
//     "Poll creator must not change"
//   );

//   // vote_counts: only index `optionIndex` increments by 1
//   for (let i = 0; i < prevPoll.vote_counts.length; i++) {
//     if (i === optionIndex) {
//       assert(
//         nextPoll.vote_counts[i] === prevPoll.vote_counts[i] + 1n,
//         `vote_counts[${i}] must increment by 1`
//       );
//     } else {
//       assert(
//         nextPoll.vote_counts[i] === prevPoll.vote_counts[i],
//         `vote_counts[${i}] must not change`
//       );
//     }
//   }

//   // total_voters increments by 1
//   assert(
//     nextPoll.total_voters === prevPoll.total_voters + 1n,
//     "total_voters must increment by 1"
//   );

//   log(`Vote cast: option[${optionIndex}] = "${prevPoll.options[optionIndex]}"`);
// }

// // ─── Operation: CLOSE_POLL ────────────────────────────────────────────────────

// /**
//  * Validates a Close Poll transaction.
//  *
//  * Expected layout:
//  *   Inputs:  [poll_cell (index 0), creator_auth_cell (index 1)]
//  *   Outputs: [closed_poll_cell (index 0), creator_change?]
//  *
//  * Rules:
//  *   1. Only the creator can close the poll (lock hash must match)
//  *   2. Poll must not already be closed
//  *   3. is_closed must flip to true in output
//  *   4. All other fields must remain unchanged
//  *   5. Creator can close early OR after deadline
//  */
// function validateClosePoll(extraArgs: Uint8Array): void {
//   log("--- validateClosePoll ---");

//   const inputPoll = loadInputCell(0);
//   assert(inputPoll !== null, "Input poll cell at index 0 is missing");
//   const prevPoll = decodePollData(inputPoll.data);

//   assert(!prevPoll.is_closed, "Poll is already closed");

//   // Creator authentication: input at index 1 must have lock hash == poll.creator
//   const creatorInput = loadInputCell(1);
//   assert(creatorInput !== null, "Creator auth cell at input index 1 is missing");
//   assert(
//     compareBytes(creatorInput.lock_hash, prevPoll.creator),
//     "Only the poll creator can close this poll"
//   );

//   const outputPoll = loadOutputCell(0);
//   assert(outputPoll !== null, "Output poll cell at index 0 is missing");
//   const nextPoll = decodePollData(outputPoll.data);

//   // Only is_closed changes
//   assert(nextPoll.is_closed, "Output poll must be marked as closed");
//   assert(nextPoll.question === prevPoll.question, "Question must not change");
//   assert(nextPoll.deadline === prevPoll.deadline, "Deadline must not change");
//   assert(
//     compareBytes(nextPoll.creator, prevPoll.creator),
//     "Creator must not change"
//   );
//   assert(nextPoll.total_voters === prevPoll.total_voters, "total_voters must not change");

//   for (let i = 0; i < prevPoll.vote_counts.length; i++) {
//     assert(
//       nextPoll.vote_counts[i] === prevPoll.vote_counts[i],
//       `vote_counts[${i}] must not change during close`
//     );
//   }

//   log(`Poll closed: "${prevPoll.question}" — ${prevPoll.total_voters} voters`);
// }

// // ─── Helpers ──────────────────────────────────────────────────────────────────

// /**
//  * Calculate minimum cell capacity in shannons.
//  * CKB formula: (lock_script_bytes + type_script_bytes + data_bytes + 8) * 100_000_000
//  */
// function calculateMinCapacity(dataLen: number, lock: Script): bigint {
//   const lockBytes =
//     32 + // code_hash
//     1 +  // hash_type
//     hexToBytes(lock.args).length; // args
//   const overhead = 8; // capacity field itself
//   const total = lockBytes + dataLen + overhead;
//   return BigInt(total) * 100_000_000n; // 1 CKByte = 100,000,000 shannons
// }

// // ─── Bootstrap (non-VM environment guard) ─────────────────────────────────────
// // In ckb-js-vm, `main` is called automatically.
// // For local ts-node testing, we call it here.
// if (typeof ckb === "undefined") {
//   // Running outside VM — mock environment for dev
//   console.log("Running in Node.js dev mode (not CKB-VM)");
// }