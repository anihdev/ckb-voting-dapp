// /**
//  * usePolls Hook
//  * =============
//  * Core business logic for the voting dApp.
//  * Handles: fetching polls, creating, voting, closing.
//  *
//  * File: frontend/src/hooks/usePolls.ts
//  */

// import { useState, useCallback } from "react";
// import { ccc } from "@ckb-ccc/core";
// import {
//   VOTING_SCRIPT_CODE_HASH,
//   buildPollTypeScript,
//   buildVoteReceiptTypeScript,
//   OP,
//   estimatePollCellCapacity,
//   ckbToShannons,
// } from "../lib/ckb";
// import {
//   encodePollData,
//   decodePollData,
//   encodeVoteData,
//   hexToBytes,
//   bytesToHex,
//   PollData,
// } from "../lib/molecule";
// import { Poll, TxState } from "../lib/types";

// // ─── Types ────────────────────────────────────────────────────────────────────

// export interface CreatePollParams {
//   question:         string;
//   options:          string[];
//   durationEpochs:   number;
// }

// export interface CastVoteParams {
//   poll:        Poll;
//   optionIndex: number;
// }

// // ─── Hook ─────────────────────────────────────────────────────────────────────

// export function usePolls(signer: ccc.Signer | null) {
//   const [polls,   setPolls]   = useState<Poll[]>([]);
//   const [loading, setLoading] = useState(false);
//   const [txState, setTxState] = useState<TxState>({
//     status: "idle", txHash: null, error: null,
//   });

//   // ── Fetch all polls ────────────────────────────────────────────────────────

//   const fetchPolls = useCallback(async () => {
//     if (!signer) return;
//     setLoading(true);
//     try {
//       const client = signer.client;
//       const pollTypeScript = ccc.Script.from({
//         codeHash: VOTING_SCRIPT_CODE_HASH,
//         hashType: "data1",
//         args: "0x" + OP.CREATE_POLL.toString(16).padStart(2, "0"),
//       });

//       // Search for all live cells matching the voting type script
//       const results: Poll[] = [];
//       for await (const cell of client.findCells({
//         script: pollTypeScript,
//         scriptType: "type",
//         scriptSearchMode: "prefix",
//       })) {
//         try {
//           const data = hexToBytes(ccc.hexFrom(cell.outputData ?? "0x"));
//           const pollData = decodePollData(data);

//           // Compute a stable poll ID from the type script hash
//           const typeScript = cell.output.type!;
//           const typeScriptHash = ccc.hashCkb(
//             ccc.bytesFrom(typeScript.codeHash),
//             ccc.bytesFrom([typeScript.hashType === "data" ? 0 : typeScript.hashType === "type" ? 1 : 2]),
//             ccc.bytesFrom(typeScript.args)
//           );
//           const pollId = ccc.hexFrom(typeScriptHash);

//           const totalVotes = pollData.vote_counts.reduce((s, v) => s + v, 0n);
//           let winnerIndex: number | null = null;
//           if (totalVotes > 0n) {
//             let max = -1n;
//             pollData.vote_counts.forEach((v, i) => {
//               if (v > max) { max = v; winnerIndex = i; }
//             });
//           }

//           results.push({
//             id:         pollId,
//             outPoint: {
//               txHash: cell.outPoint.txHash,
//               index:  Number(cell.outPoint.index),
//             },
//             question:    pollData.question,
//             options:     pollData.options,
//             voteCounts:  pollData.vote_counts,
//             deadline:    pollData.deadline,
//             creator:     bytesToHex(pollData.creator),
//             isClosed:    pollData.is_closed,
//             totalVoters: pollData.total_voters,
//             totalVotes,
//             winnerIndex,
//           });
//         } catch (e) {
//           console.warn("Failed to decode poll cell:", e);
//         }
//       }
//       setPolls(results);
//     } catch (e) {
//       console.error("fetchPolls error:", e);
//     } finally {
//       setLoading(false);
//     }
//   }, [signer]);

//   // ── Create Poll ────────────────────────────────────────────────────────────

//   const createPoll = useCallback(
//     async ({ question, options, durationEpochs }: CreatePollParams) => {
//       if (!signer) throw new Error("Wallet not connected");

//       setTxState({ status: "building", txHash: null, error: null });

//       try {
//         // Get current epoch from RPC
//         const client = signer.client;
//         const tipHeader = await client.getTipHeader();
//         const currentEpoch = BigInt(tipHeader.epoch);
//         const deadline = currentEpoch + BigInt(durationEpochs);

//         // Get creator lock hash for poll data
//         const creatorAddr = await signer.getAddressObjSecp256k1();
//         const creatorLockHash = ccc.hashCkb(
//           ccc.bytesFrom(creatorAddr.script.codeHash),
//           ccc.bytesFrom([creatorAddr.script.hashType === "type" ? 1 : 0]),
//           ccc.bytesFrom(creatorAddr.script.args)
//         );

//         // Encode poll cell data
//         const pollData: PollData = {
//           question,
//           options,
//           vote_counts:  new Array(options.length).fill(0n),
//           deadline,
//           creator:      new Uint8Array(creatorLockHash),
//           is_closed:    false,
//           total_voters: 0n,
//         };
//         const encodedData = encodePollData(pollData);
//         const dataHex = bytesToHex(encodedData);

//         // Build type script for the poll cell
//         const pollTypeScript = buildPollTypeScript(OP.CREATE_POLL);

//         // Estimate capacity
//         const capacity = estimatePollCellCapacity(encodedData.length);

//         // Build transaction
//         const tx = ccc.Transaction.from({
//           outputs: [{
//             lock:     creatorAddr.script,
//             type:     pollTypeScript,
//             capacity: capacity,
//           }],
//           outputsData: [dataHex],
//         });

//         // CCC auto-selects input UTXOs and adds change output
//         await tx.completeInputsByCapacity(signer);
//         await tx.completeFeeBy(signer, 1000);

//         setTxState({ status: "signing", txHash: null, error: null });
//         await signer.signTransaction(tx);

//         setTxState({ status: "sending", txHash: null, error: null });
//         const txHash = await client.sendTransaction(tx);

//         setTxState({ status: "confirming", txHash, error: null });

//         // Wait for confirmation (non-blocking - UI can show txHash immediately)
//         waitForTx(client, txHash).then(() => {
//           setTxState({ status: "success", txHash, error: null });
//           fetchPolls(); // refresh list
//         });

//         return txHash;
//       } catch (e: any) {
//         setTxState({ status: "error", txHash: null, error: e.message ?? String(e) });
//         throw e;
//       }
//     },
//     [signer, fetchPolls]
//   );

//   // ── Cast Vote ──────────────────────────────────────────────────────────────

//   const castVote = useCallback(
//     async ({ poll, optionIndex }: CastVoteParams) => {
//       if (!signer) throw new Error("Wallet not connected");

//       setTxState({ status: "building", txHash: null, error: null });

//       try {
//         const client  = signer.client;
//         const voterAddr = await signer.getAddressObjSecp256k1();

//         // Load the current poll cell
//         const pollOutPoint = ccc.OutPoint.from({
//           txHash: poll.outPoint.txHash,
//           index:  poll.outPoint.index,
//         });
//         const pollCell = await client.getCell(pollOutPoint);
//         if (!pollCell) throw new Error("Poll cell not found on chain");

//         // Decode current state
//         const pollRawData = hexToBytes(ccc.hexFrom(pollCell.outputData ?? "0x"));
//         const pollData    = decodePollData(pollRawData);

//         // Update state
//         const newVoteCounts = [...pollData.vote_counts];
//         newVoteCounts[optionIndex] += 1n;
//         const updatedPoll: PollData = {
//           ...pollData,
//           vote_counts:  newVoteCounts,
//           total_voters: pollData.total_voters + 1n,
//         };
//         const updatedDataHex = bytesToHex(encodePollData(updatedPoll));

//         // Build vote receipt data
//         const voterLockHash = ccc.hashCkb(
//           ccc.bytesFrom(voterAddr.script.codeHash),
//           ccc.bytesFrom([voterAddr.script.hashType === "type" ? 1 : 0]),
//           ccc.bytesFrom(voterAddr.script.args)
//         );
//         const tipHeader   = await client.getTipHeader();
//         const currentEpoch = BigInt(tipHeader.epoch);
//         const receiptData = encodeVoteData({
//           poll_type_hash:  hexToBytes(poll.id),
//           voter_lock_hash: new Uint8Array(voterLockHash),
//           option_index:    optionIndex,
//           voted_at_epoch:  currentEpoch,
//         });
//         const receiptDataHex = bytesToHex(receiptData);

//         // Receipt type script uses the poll's type hash as part of args
//         const receiptTypeScript = buildVoteReceiptTypeScript(poll.id);

//         // Minimum capacity for vote receipt cell (~130 bytes data)
//         const receiptCapacity = estimatePollCellCapacity(receiptData.length);

//         // Build witness: option_index in input_type field of witness at index 1
//         const optionByte = new Uint8Array([optionIndex]);

//         const tx = ccc.Transaction.from({
//           inputs: [
//             // Input 0: poll cell (being consumed and recreated)
//             { previousOutput: pollOutPoint },
//           ],
//           outputs: [
//             // Output 0: updated poll cell (same type script, updated data)
//             {
//               lock:     pollCell.output.lock,
//               type:     pollCell.output.type,
//               capacity: pollCell.output.capacity,
//             },
//             // Output 1: vote receipt (proves voter voted)
//             {
//               lock:     voterAddr.script,
//               type:     receiptTypeScript,
//               capacity: receiptCapacity,
//             },
//           ],
//           outputsData: [updatedDataHex, receiptDataHex],
//           witnesses: [
//             "0x", // placeholder for input 0 (poll cell — no lock witness needed from voter for poll)
//             ccc.WitnessArgs.from({
//               lock:       new Uint8Array(0),
//               inputType:  optionByte, // option_index byte validated by contract
//               outputType: new Uint8Array(0),
//             }).toBytes(),
//           ],
//         });

//         await tx.completeInputsByCapacity(signer);
//         await tx.completeFeeBy(signer, 1000);

//         setTxState({ status: "signing", txHash: null, error: null });
//         await signer.signTransaction(tx);

//         setTxState({ status: "sending", txHash: null, error: null });
//         const txHash = await client.sendTransaction(tx);

//         setTxState({ status: "confirming", txHash, error: null });
//         waitForTx(client, txHash).then(() => {
//           setTxState({ status: "success", txHash, error: null });
//           fetchPolls();
//         });

//         return txHash;
//       } catch (e: any) {
//         setTxState({ status: "error", txHash: null, error: e.message ?? String(e) });
//         throw e;
//       }
//     },
//     [signer, fetchPolls]
//   );

//   // ── Close Poll ─────────────────────────────────────────────────────────────

//   const closePoll = useCallback(
//     async (poll: Poll) => {
//       if (!signer) throw new Error("Wallet not connected");
//       setTxState({ status: "building", txHash: null, error: null });

//       try {
//         const client = signer.client;
//         const creatorAddr = await signer.getAddressObjSecp256k1();

//         const pollOutPoint = ccc.OutPoint.from({
//           txHash: poll.outPoint.txHash,
//           index:  poll.outPoint.index,
//         });
//         const pollCell = await client.getCell(pollOutPoint);
//         if (!pollCell) throw new Error("Poll cell not found");

//         const rawData  = hexToBytes(ccc.hexFrom(pollCell.outputData ?? "0x"));
//         const pollData = decodePollData(rawData);

//         const closedPoll: PollData = { ...pollData, is_closed: true };
//         const closedDataHex = bytesToHex(encodePollData(closedPoll));

//         const tx = ccc.Transaction.from({
//           inputs: [
//             { previousOutput: pollOutPoint },   // index 0: poll cell
//           ],
//           outputs: [{
//             lock:     pollCell.output.lock,
//             type:     pollCell.output.type,
//             capacity: pollCell.output.capacity,
//           }],
//           outputsData: [closedDataHex],
//         });

//         // CCC will add the creator's cell as input[1] automatically (for fee + auth)
//         await tx.completeInputsByCapacity(signer);
//         await tx.completeFeeBy(signer, 1000);

//         setTxState({ status: "signing", txHash: null, error: null });
//         await signer.signTransaction(tx);

//         setTxState({ status: "sending", txHash: null, error: null });
//         const txHash = await client.sendTransaction(tx);

//         setTxState({ status: "confirming", txHash, error: null });
//         waitForTx(client, txHash).then(() => {
//           setTxState({ status: "success", txHash, error: null });
//           fetchPolls();
//         });
//         return txHash;
//       } catch (e: any) {
//         setTxState({ status: "error", txHash: null, error: e.message ?? String(e) });
//         throw e;
//       }
//     },
//     [signer, fetchPolls]
//   );

//   return { polls, loading, txState, fetchPolls, createPoll, castVote, closePoll };
// }

// // ─── Helpers ──────────────────────────────────────────────────────────────────

// async function waitForTx(client: ccc.Client, txHash: string): Promise<void> {
//   for (let i = 0; i < 60; i++) {
//     await new Promise((r) => setTimeout(r, 5000));
//     try {
//       const tx = await client.getTransaction(txHash);
//       if (tx) return;
//     } catch (_) {}
//   }
// }