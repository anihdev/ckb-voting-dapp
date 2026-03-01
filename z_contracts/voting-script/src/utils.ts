import { HighLevel } from "@ckb-js-std/core";
import { PollData, VoteData } from "./types";

/**
 * Parse poll data from Molecule-encoded bytes
 * 
 * Molecule format for PollData:
 * - poll_id: Byte32 (32 bytes)
 * - question: Bytes (4-byte length + data)
 * - created_at: Uint64 (8 bytes)
 * - deadline: Uint64 (8 bytes)
 * - status: byte (1 byte)
 * - yes_count: Uint32 (4 bytes)
 * - no_count: Uint32 (4 bytes)
 * - creator: Bytes (4-byte length + data)
 * - version: Uint32 (4 bytes)
 */
export function parsePollData(data: Uint8Array): PollData {
  let offset = 0;
  
  // Parse poll_id (32 bytes)
  const poll_id = data.slice(offset, offset + 32);
  offset += 32;
  
  // Parse question (length-prefixed string)
  const questionLength = new DataView(data.buffer, offset, 4).getUint32(0, true);
  offset += 4;
  const questionBytes = data.slice(offset, offset + questionLength);
  const question = new TextDecoder().decode(questionBytes);
  offset += questionLength;
  
  // Parse created_at (8 bytes)
  const created_at = new DataView(data.buffer, offset, 8).getBigUint64(0, true);
  offset += 8;
  
  // Parse deadline (8 bytes)
  const deadline = new DataView(data.buffer, offset, 8).getBigUint64(0, true);
  offset += 8;
  
  // Parse status (1 byte)
  const status = data[offset];
  offset += 1;
  
  // Parse yes_count (4 bytes)
  const yes_count = new DataView(data.buffer, offset, 4).getUint32(0, true);
  offset += 4;
  
  // Parse no_count (4 bytes)
  const no_count = new DataView(data.buffer, offset, 4).getUint32(0, true);
  offset += 4;
  
  // Parse creator (length-prefixed string)
  const creatorLength = new DataView(data.buffer, offset, 4).getUint32(0, true);
  offset += 4;
  const creatorBytes = data.slice(offset, offset + creatorLength);
  const creator = new TextDecoder().decode(creatorBytes);
  offset += creatorLength;
  
  // Parse version (4 bytes)
  const version = new DataView(data.buffer, offset, 4).getUint32(0, true);
  
  return {
    poll_id,
    question,
    created_at,
    deadline,
    status,
    yes_count,
    no_count,
    creator,
    version,
  };
}

/**
 * Parse vote data from Molecule-encoded bytes
 */
export function parseVoteData(data: Uint8Array): VoteData {
  let offset = 0;
  
  // Parse poll_id (32 bytes)
  const poll_id = data.slice(offset, offset + 32);
  offset += 32;
  
  // Parse voter (length-prefixed string)
  const voterLength = new DataView(data.buffer, offset, 4).getUint32(0, true);
  offset += 4;
  const voterBytes = data.slice(offset, offset + voterLength);
  const voter = new TextDecoder().decode(voterBytes);
  offset += voterLength;
  
  // Parse vote (1 byte)
  const vote = data[offset];
  offset += 1;
  
  // Parse timestamp (8 bytes)
  const timestamp = new DataView(data.buffer, offset, 8).getBigUint64(0, true);
  offset += 8;
  
  // Parse version (4 bytes)
  const version = new DataView(data.buffer, offset, 4).getUint32(0, true);
  
  return {
    poll_id,
    voter,
    vote,
    timestamp,
    version,
  };
}

/**
 * Get current block timestamp
 */
// export function getCurrentTime(): bigint {
//   try {
//     const header = HighLevel.loadHeader(0, bindings.SOURCE_HEADER_DEP);
//     return header.timestamp;
//   } catch {
//     // Fallback if header not available
//     return BigInt(Date.now());
//   }
// }

// /**
//  * Compare two byte arrays
//  */
// export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
//   if (a.length !== b.length) return false;
//   for (let i = 0; i < a.length; i++) {
//     if (a[i] !== b[i]) return false;
//   }
//   return true;
// }

export function getCurrentTime(): bigint {
    // Get current block timestamp
    const header = HighLevel.loadHeader(0, 0);
    const anyHeader = header as any;

    // Prefer top-level timestamp if present
    if (anyHeader.timestamp !== undefined) {
        const ts = anyHeader.timestamp;
        return typeof ts === "bigint" ? ts : BigInt(ts);
    }

    // Fallback to raw.timestamp if present on older/newer runtimes
    const rawTs = anyHeader.raw !== undefined ? anyHeader.raw.timestamp : undefined;
    if (rawTs !== undefined) {
        return typeof rawTs === "bigint" ? rawTs : BigInt(rawTs);
    }

    throw new Error("Unable to read header timestamp");
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return false;
    }
    return true;
}