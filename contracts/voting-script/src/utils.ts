import { HighLevel } from "@ckb-js-std/core";
import { PollData, VoteData } from "./types";

export function parsePollData(data: Uint8Array): PollData {
    // Parse Molecule-encoded poll data
    // TODO: Implement parsing logic
    void data;
return {} as PollData;
}

export function parseVoteData(data: Uint8Array): VoteData {
    // Parse Molecule-encoded vote data
    // TODO: Implement parsing logic
void data;
return {} as VoteData;
}

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