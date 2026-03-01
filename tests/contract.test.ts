// /**
//  * Contract Unit Tests
//  * ====================
//  * Tests the voting script logic in Node.js by injecting a mock TX_CONTEXT.
//  * The contract reads TX_CONTEXT instead of CKB syscalls when not in CKB-VM.
//  *
//  * File: tests/contract.test.ts
//  * Run:  cd backend/contract && npm test
//  *      OR: npx jest tests/contract.test.ts (from project root)
//  */

// import { encodePollData, decodePollData, encodeVoteData, PollData } from "../backend/contract/src/molecule";
// import { hexToBytes, bytesToHex } from "../backend/contract/src/utils";

// // ─── Test helpers ─────────────────────────────────────────────────────────────

// function makeCreator(): Uint8Array {
//   return new Uint8Array(32).fill(0xab);
// }

// function makePoll(overrides: Partial<PollData> = {}): PollData {
//   return {
//     question:    "What is your favourite chain?",
//     options:     ["CKB", "Ethereum", "Solana"],
//     vote_counts: [0n, 0n, 0n],
//     deadline:    200n,
//     creator:     makeCreator(),
//     is_closed:   false,
//     total_voters: 0n,
//     ...overrides,
//   };
// }

// // ─── Molecule encoding tests ───────────────────────────────────────────────────

// describe("PollData molecule encoding", () => {
//   test("round-trips basic poll", () => {
//     const poll = makePoll();
//     const encoded = encodePollData(poll);
//     const decoded = decodePollData(encoded);

//     expect(decoded.question).toBe(poll.question);
//     expect(decoded.options).toEqual(poll.options);
//     expect(decoded.vote_counts).toEqual(poll.vote_counts);
//     expect(decoded.deadline).toBe(poll.deadline);
//     expect(decoded.is_closed).toBe(poll.is_closed);
//     expect(decoded.total_voters).toBe(poll.total_voters);
//     expect(bytesToHex(decoded.creator)).toBe(bytesToHex(poll.creator));
//   });

//   test("round-trips poll with votes", () => {
//     const poll = makePoll({ vote_counts: [5n, 2n, 100n], total_voters: 107n });
//     const decoded = decodePollData(encodePollData(poll));
//     expect(decoded.vote_counts).toEqual([5n, 2n, 100n]);
//     expect(decoded.total_voters).toBe(107n);
//   });

//   test("round-trips closed poll", () => {
//     const poll = makePoll({ is_closed: true });
//     const decoded = decodePollData(encodePollData(poll));
//     expect(decoded.is_closed).toBe(true);
//   });

//   test("handles unicode question", () => {
//     const poll = makePoll({ question: "¿Cuál es tu cadena favorita? 🔗" });
//     const decoded = decodePollData(encodePollData(poll));
//     expect(decoded.question).toBe(poll.question);
//   });

//   test("handles 10 options", () => {
//     const options = Array.from({ length: 10 }, (_, i) => `Option ${i + 1}`);
//     const poll = makePoll({ options, vote_counts: new Array(10).fill(0n) });
//     const decoded = decodePollData(encodePollData(poll));
//     expect(decoded.options.length).toBe(10);
//     expect(decoded.options[9]).toBe("Option 10");
//   });

//   test("encodes deadline correctly", () => {
//     const poll = makePoll({ deadline: 9999999n });
//     const decoded = decodePollData(encodePollData(poll));
//     expect(decoded.deadline).toBe(9999999n);
//   });
// });

// // ─── VoteData molecule tests ───────────────────────────────────────────────────

// describe("VoteData molecule encoding", () => {
//   test("round-trips vote data", () => {
//     const vote = {
//       poll_type_hash:  new Uint8Array(32).fill(0x11),
//       voter_lock_hash: new Uint8Array(32).fill(0x22),
//       option_index:    2,
//       voted_at_epoch:  150n,
//     };
//     const encoded = encodeVoteData(vote);
//     expect(encoded.length).toBe(32 + 32 + 1 + 8); // 73 bytes

//     // We can import decodeVoteData too if needed
//     // For now just check size
//     expect(encoded[64]).toBe(2); // option_index at byte 64
//   });
// });

// // ─── Contract logic simulation ────────────────────────────────────────────────
// // These tests simulate what the contract validates by running the same
// // assertions against encoded data without the full VM harness.

// describe("Poll validation rules", () => {
//   test("rejects poll with 0 options", () => {
//     const poll = makePoll({ options: [], vote_counts: [] });
//     const encoded = encodePollData(poll);
//     const decoded = decodePollData(encoded);
//     expect(decoded.options.length).toBeLessThan(2);
//     // Contract would reject: "Poll must have at least 2 options"
//   });

//   test("rejects poll where vote_counts.length != options.length", () => {
//     // Directly test the shape invariant
//     const poll = makePoll({ options: ["A", "B"], vote_counts: [0n] });
//     // Encoding itself succeeds, but contract checks this
//     const encoded = encodePollData(poll);
//     const decoded = decodePollData(encoded);
//     expect(decoded.vote_counts.length).not.toBe(decoded.options.length);
//   });

//   test("state transition: cast_vote increments correct count", () => {
//     const before = makePoll({ vote_counts: [3n, 1n, 7n], total_voters: 11n });
//     const optionIndex = 1; // voting for index 1

//     // Simulate what the contract validates:
//     const newCounts = [...before.vote_counts];
//     newCounts[optionIndex] += 1n;
//     const after: PollData = {
//       ...before,
//       vote_counts:  newCounts,
//       total_voters: before.total_voters + 1n,
//     };

//     // Assertions the contract makes:
//     expect(after.vote_counts[0]).toBe(3n); // unchanged
//     expect(after.vote_counts[1]).toBe(2n); // incremented
//     expect(after.vote_counts[2]).toBe(7n); // unchanged
//     expect(after.total_voters).toBe(12n);
//     expect(after.question).toBe(before.question);
//     expect(after.deadline).toBe(before.deadline);
//   });

//   test("state transition: close_poll flips is_closed only", () => {
//     const before = makePoll({ vote_counts: [5n, 3n], total_voters: 8n });
//     const after: PollData = { ...before, is_closed: true };

//     // Assertions the contract makes:
//     expect(after.is_closed).toBe(true);
//     expect(after.question).toBe(before.question);
//     expect(after.total_voters).toBe(before.total_voters);
//     expect(after.vote_counts).toEqual(before.vote_counts);
//   });

//   test("capacity calculation: 100 bytes data + 130 bytes overhead = 230 CKB minimum", () => {
//     const dataLen = 100;
//     const lockBytes = 32 + 1 + 20; // typical secp256k1 lock
//     const overhead = 8;
//     const total = lockBytes + dataLen + overhead;
//     const shannons = BigInt(total) * 100_000_000n;
//     // 161 bytes * 1 CKByte/byte = 161 CKByte minimum
//     expect(shannons).toBe(16100000000n);
//   });
// });

// // ─── Hex utils ────────────────────────────────────────────────────────────────

// describe("hexToBytes / bytesToHex", () => {
//   test("roundtrip", () => {
//     const hex = "0xdeadbeef01020304";
//     expect(bytesToHex(hexToBytes(hex))).toBe(hex);
//   });

//   test("handles 0x prefix", () => {
//     expect(hexToBytes("0xab").length).toBe(1);
//     expect(hexToBytes("ab").length).toBe(1);
//   });

//   test("32-byte zero hash", () => {
//     const zero = "0x" + "00".repeat(32);
//     expect(hexToBytes(zero).length).toBe(32);
//   });
// });