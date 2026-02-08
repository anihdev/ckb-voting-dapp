import * as bindings from "@ckb-js-std/bindings";
import { HighLevel, log } from "@ckb-js-std/core";
import { VotingOperation } from "./types";
import { parsePollData, parseVoteData, getCurrentTime } from "./utils";

function detectOperation(): VotingOperation {
    // Determine which operation is being performed
    // by analyzing inputs and outputs
    let hasInput = false;
    let hasOutput = false;

    try {
        HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
        hasInput = true;
    } catch (e) {
        hasInput = false;
    }

    try {
        HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
        hasOutput = true;
    } catch (e) {
        hasOutput = false;
    }

    // Only an output poll cell -> creating a new poll
    if (!hasInput && hasOutput) {
        return VotingOperation.CREATE_POLL;
    }

    // Both input and output poll cells exist -> either casting a vote or closing a poll
    if (hasInput && hasOutput) {
        const inputRaw = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
        const outputRaw = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
        const inputPoll = parsePollData(new Uint8Array(inputRaw));
        const outputPoll = parsePollData(new Uint8Array(outputRaw));

        // If status changed from active to closed -> close poll
        if (inputPoll.status === 0 && outputPoll.status === 1) {
            return VotingOperation.CLOSE_POLL;
        }

        // If vote counts changed -> cast vote
        if (outputPoll.yes_count !== inputPoll.yes_count || outputPoll.no_count !== inputPoll.no_count) {
            return VotingOperation.CAST_VOTE;
        }

        // Fallback to cast vote if both exist but no other clear change
        return VotingOperation.CAST_VOTE;
    }

    // Fallback default
    return VotingOperation.CREATE_POLL;
}

function validateCreatePoll(): number {
    // Load output poll cell
    const outputData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
    // const pollData = parsePollData(outputData);
    const pollData = parsePollData(new Uint8Array(outputData));

    // Verify deadline is in future
    const now = getCurrentTime();
    if (pollData.deadline <= now) {
        log.error("Deadline must be in future");
        return 2;
    }

    // Verify initial vote counts are zero
    if (pollData.yes_count !== 0 || pollData.no_count !== 0) {
        log.error("Initial vote counts must be zero");
        return 3;
    }

    // Verify status is active
    if (pollData.status !== 0) {
        log.error("Initial status must be active");
        return 4;
    }

    // Verify poll_id is properly set
    if (pollData.poll_id.every(b => b === 0)) {
        log.error("Poll ID cannot be all zeros");
        return 5;
    }

    log.info("Create poll validation passed");
    return 0;
}

function validateCastVote(): number {
    // Load input and output poll cells
    const inputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
    const outputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);

    //  const inputPoll = parsePollData(inputPollData);
    // const outputPoll = parsePollData(outputPollData);
    const inputPoll = parsePollData(new Uint8Array(inputPollData));
    const outputPoll = parsePollData(new Uint8Array(outputPollData));

    // Load new vote cell
    const voteData = HighLevel.loadCellData(0, bindings.SOURCE_OUTPUT);
    //  const vote = parseVoteData(voteData);
    const vote = parseVoteData(new Uint8Array(voteData));

    // Check poll is active
    if (inputPoll.status !== 0) {
        log.error("Poll is not active");
        return 10;
    }

    // Check deadline hasn't passed
    const now = getCurrentTime();
    if (now >= inputPoll.deadline) {
        log.error("Voting deadline has passed");
        return 11;
    }

    // Verify vote is 0 or 1
    if (vote.vote !== 0 && vote.vote !== 1) {
        log.error("Vote must be 0 (no) or 1 (yes)");
        return 12;
    }

    // Verify poll_id matches
    if (!bytesEqual(vote.poll_id, inputPoll.poll_id)) {
        log.error("Vote poll_id doesn't match poll");
        return 13;
    }

    // Verify vote count incremented correctly
    const expectedYes = vote.vote === 1 ? inputPoll.yes_count + 1 : inputPoll.yes_count;
    const expectedNo = vote.vote === 0 ? inputPoll.no_count + 1 : inputPoll.no_count;

    if (outputPoll.yes_count !== expectedYes || outputPoll.no_count !== expectedNo) {
        log.error("Vote counts not incremented correctly");
        return 14;
    }

    // Check voter hasn't voted before (TODO: implement in Phase 2)

    log.info("Cast vote validation passed");
    return 0;
}

function validateClosePoll(): number {
    // Load input and output poll cells
    const inputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
    const outputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);

    // const inputPoll = parsePollData(inputPollData);
    // const outputPoll = parsePollData(outputPollData);
    const inputPoll = parsePollData(new Uint8Array(inputPollData));
    const outputPoll = parsePollData(new Uint8Array(outputPollData));

    // Verify poll was active
    if (inputPoll.status !== 0) {
        log.error("Poll is already closed");
        return 20;
    }

    // Check deadline passed OR creator is closing early
    const now = getCurrentTime();
    const tx = HighLevel.loadTransaction();

    // Load transaction witness to verify signer
    // For early close, must be creator (i.e assume deadline must pass)
    if (now < inputPoll.deadline) {
        log.error("Deadline hasn't passed yet");
        return 21;
    }

    // Verify status changed to closed
    if (outputPoll.status !== 1) {
        log.error("Poll status must be set to closed");
        return 22;
    }

    // Verify vote counts unchanged
    if (outputPoll.yes_count !== inputPoll.yes_count ||
        outputPoll.no_count !== inputPoll.no_count) {
        log.error("Vote counts cannot change when closing");
        return 23;
    }

    log.info("Close poll validation passed");
    return 0;
}
function main(): number {
    log.setLevel(log.LogLevel.Debug);

    const operation = detectOperation();

    switch (operation) {
        case VotingOperation.CREATE_POLL:
            return validateCreatePoll();
        case VotingOperation.CAST_VOTE:
            return validateCastVote();
        case VotingOperation.CLOSE_POLL:
            return validateClosePoll();
        default:
            log.error("Unknown operation");
            return 1;
    }
}

bindings.exit(main());