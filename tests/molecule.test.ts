// /**
//  * Frontend Molecule Tests
//  * =======================
//  * Tests that the frontend molecule codec produces identical bytes to the
//  * backend codec. This ensures no encoding mismatch between what we send
//  * and what the contract expects.
//  *
//  * File: tests/molecule.test.ts
//  * Run:  cd frontend && npm test
//  */

// import { describe, test, expect } from "vitest";
// import {
//   encodePollData,
//   decodePollData,
//   encodeVoteData,
//   decodeVoteData,
//   hexToBytes,
//   bytesToHex,
//   PollData,
//   VoteData,
// } from "../frontend/src/lib/molecule";

// function makePoll(overrides: Partial<PollData> = {}): PollData {
//   return {
//     question:    "Frontend test poll?",
//     options:     ["Yes", "No", "Maybe"],
//     vote_counts: [0n, 0n, 0n],
//     deadline:    500n,
//     creator:     new Uint8Array(32).fill(0xcc),
//     is_closed:   false,
//     total_voters: 0n,
//     ...overrides,
//   };
// }

// describe("frontend/lib/molecule — PollData", () => {
//   test("encodes and decodes correctly", () => {
//     const poll = makePoll();
//     const buf  = encodePollData(poll);
//     const back = decodePollData(buf);
//     expect(back.question).toBe(poll.question);
//     expect(back.options).toEqual(poll.options);
//     expect(back.vote_counts).toEqual(poll.vote_counts);
//     expect(back.deadline).toBe(poll.deadline);
//     expect(back.is_closed).toBe(false);
//     expect(back.total_voters).toBe(0n);
//     expect(bytesToHex(back.creator)).toBe(bytesToHex(poll.creator));
//   });

//   test("encoded bytes are deterministic", () => {
//     const poll = makePoll();
//     const a = encodePollData(poll);
//     const b = encodePollData(poll);
//     expect(bytesToHex(a)).toBe(bytesToHex(b));
//   });

//   test("minimal poll (2 options)", () => {
//     const poll = makePoll({ options: ["A", "B"], vote_counts: [0n, 0n] });
//     const back = decodePollData(encodePollData(poll));
//     expect(back.options.length).toBe(2);
//   });

//   test("large vote counts survive encoding", () => {
//     const poll = makePoll({
//       vote_counts: [1_000_000n, 999_999n, 500_000n],
//       total_voters: 2_499_999n,
//     });
//     const back = decodePollData(encodePollData(poll));
//     expect(back.vote_counts[0]).toBe(1_000_000n);
//     expect(back.total_voters).toBe(2_499_999n);
//   });

//   test("closed poll flag roundtrips", () => {
//     const poll = makePoll({ is_closed: true });
//     const back = decodePollData(encodePollData(poll));
//     expect(back.is_closed).toBe(true);
//   });
// });

// describe("frontend/lib/molecule — VoteData", () => {
//   const sampleVote: VoteData = {
//     poll_type_hash:  new Uint8Array(32).fill(0xaa),
//     voter_lock_hash: new Uint8Array(32).fill(0xbb),
//     option_index:    1,
//     voted_at_epoch:  42n,
//   };

//   test("encodes to exactly 73 bytes", () => {
//     const buf = encodeVoteData(sampleVote);
//     expect(buf.length).toBe(73); // 32 + 32 + 1 + 8
//   });

//   test("decodes correctly", () => {
//     const buf  = encodeVoteData(sampleVote);
//     const back = decodeVoteData(buf);
//     expect(back.option_index).toBe(1);
//     expect(back.voted_at_epoch).toBe(42n);
//     expect(bytesToHex(back.poll_type_hash)).toBe(bytesToHex(sampleVote.poll_type_hash));
//     expect(bytesToHex(back.voter_lock_hash)).toBe(bytesToHex(sampleVote.voter_lock_hash));
//   });

//   test("option_index 0 encodes correctly", () => {
//     const buf = encodeVoteData({ ...sampleVote, option_index: 0 });
//     const back = decodeVoteData(buf);
//     expect(back.option_index).toBe(0);
//   });

//   test("option_index 9 encodes correctly", () => {
//     const buf = encodeVoteData({ ...sampleVote, option_index: 9 });
//     const back = decodeVoteData(buf);
//     expect(back.option_index).toBe(9);
//   });
// });

// describe("hexToBytes / bytesToHex utils", () => {
//   test("roundtrips", () => {
//     const cases = ["0x", "0x00", "0xdeadbeef", "0x" + "ff".repeat(32)];
//     for (const hex of cases) {
//       expect(bytesToHex(hexToBytes(hex))).toBe(hex);
//     }
//   });

//   test("no 0x prefix also works", () => {
//     expect(hexToBytes("deadbeef")[0]).toBe(0xde);
//   });
// });

// describe("backend ↔ frontend codec compatibility", () => {
//   /**
//    * This test manually checks that the byte layout is identical.
//    * The simplest way: encode on frontend, decode on backend (or vice versa).
//    * Since we can't import backend in vitest without ts-jest setup,
//    * we instead validate the byte-level structure directly.
//    */
//   test("PollData layout: first 4 bytes are question length (little-endian)", () => {
//     const question = "Hello";
//     const poll = makePoll({ question });
//     const buf  = encodePollData(poll);
//     // First 4 bytes should be length of "Hello" = 5 in little-endian
//     expect(buf[0]).toBe(5);
//     expect(buf[1]).toBe(0);
//     expect(buf[2]).toBe(0);
//     expect(buf[3]).toBe(0);
//     // Next 5 bytes should be "Hello"
//     expect(new TextDecoder().decode(buf.slice(4, 9))).toBe("Hello");
//   });

//   test("PollData layout: is_closed byte is 0x00 for false", () => {
//     const poll = makePoll({ is_closed: false });
//     const buf  = encodePollData(poll);
//     // Find is_closed byte: after question, options, vote_counts, deadline (8), creator (32)
//     // We can verify by encoding closed=true and finding the differing byte
//     const buf2 = encodePollData({ ...poll, is_closed: true });
//     let diffIdx = -1;
//     for (let i = 0; i < buf.length; i++) {
//       if (buf[i] !== buf2[i]) { diffIdx = i; break; }
//     }
//     expect(buf[diffIdx]).toBe(0);  // false = 0x00
//     expect(buf2[diffIdx]).toBe(1); // true  = 0x01
//   });
// });