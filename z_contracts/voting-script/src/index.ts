import * as bindings from "@ckb-js-std/bindings";
import { HighLevel, log } from "@ckb-js-std/core";
import { VotingOperation } from "./types";
import { parsePollData, parseVoteData, getCurrentTime, bytesEqual } from "./utils";

/**
 * Determine which operation is being performed
 * 
 * Logic:
 * - CREATE_POLL: No inputs with voting script, has output with voting script
 * - CAST_VOTE: Has input poll + output poll + new vote cell
 * - CLOSE_POLL: Has input poll + output poll, no new vote
 */
function detectOperation(): VotingOperation {
  let inputCount = 0;
  let outputCount = 0;
  
  // Count inputs with our script
  try {
    while (true) {
      HighLevel.loadCellData(inputCount, bindings.SOURCE_GROUP_INPUT);
      inputCount++;
    }
  } catch {
    // End of inputs
  }
  
  // Count outputs with our script
  try {
    while (true) {
      HighLevel.loadCellData(outputCount, bindings.SOURCE_GROUP_OUTPUT);
      outputCount++;
    }
  } catch {
    // End of outputs
  }
  
  log.info(`Inputs: ${inputCount}, Outputs: ${outputCount}`);
  
  if (inputCount === 0 && outputCount === 1) {
    return VotingOperation.CREATE_POLL;
  } else if (inputCount === 1 && outputCount === 2) {
    return VotingOperation.CAST_VOTE;
  } else if (inputCount === 1 && outputCount === 1) {
    return VotingOperation.CLOSE_POLL;
  }
  
  log.error(`Invalid operation: inputs=${inputCount}, outputs=${outputCount}`);
  throw new Error("Invalid operation");
}


/**
 * Validate poll creation
 * 
 * Checks:
 * 1. Deadline is in future
 * 2. Initial vote counts are zero
 * 3. Status is active (0)
 * 4. Poll ID is non-zero
 * 5. Question is non-empty
 */
function validateCreatePoll(): number {
  log.info("Validating CREATE_POLL");
  
  // Load output poll cell data
  // -  const outputData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
  // -  const poll = parsePollData(outputData);
   const outputData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
  const outputBytes = new Uint8Array(outputData);
  const poll = parsePollData(outputBytes);

  const now = getCurrentTime();
  if (poll.deadline <= now) {
    log.error(`Deadline ${poll.deadline} must be after now ${now}`);
    return 2;
  }
  
  // 2. Verify initial vote counts are zero
  if (poll.yes_count !== 0 || poll.no_count !== 0) {
    log.error(`Initial counts must be zero: yes=${poll.yes_count}, no=${poll.no_count}`);
    return 3;
  }
  
  // 3. Verify status is active
  if (poll.status !== 0) {
    log.error(`Initial status must be 0 (active), got ${poll.status}`);
    return 4;
  }
  
  // 4. Verify poll_id is not all zeros
  const allZeros = poll.poll_id.every(b => b === 0);
  if (allZeros) {
    log.error("Poll ID cannot be all zeros");
    return 5;
  }
  
  // 5. Verify question is non-empty
  if (poll.question.length === 0) {
    log.error("Question cannot be empty");
    return 6;
  }
  
  log.info(`Poll created successfully: "${poll.question}"`);
  return 0; // Success
}

/**
 * Validate vote casting
 * 
 * Checks:
 * 1. Poll is active
 * 2. Deadline hasn't passed
 * 3. Vote is 0 or 1
 * 4. Vote poll_id matches poll
 * 5. Vote counts incremented correctly
 * 6. Poll status unchanged
 * 7. Deadline unchanged
 */
function validateCastVote(): number {
  log.info("Validating CAST_VOTE");
  
  // Load input poll (index 0)
  const inputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
  const inputPoll = parsePollData(new Uint8Array(inputPollData));
  
  // Load output poll (index 0)
  const outputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
  const outputPoll = parsePollData(new Uint8Array(outputPollData));
  
  // Load new vote cell (index 1)
  const voteData = HighLevel.loadCellData(1, bindings.SOURCE_GROUP_OUTPUT);
  const vote = parseVoteData(new Uint8Array(voteData));
  
  // 1. Check poll is active
  if (inputPoll.status !== 0) {
    log.error(`Poll is not active: status=${inputPoll.status}`);
    return 10;
  }
  
  // 2. Check deadline hasn't passed
  const now = getCurrentTime();
  if (now >= inputPoll.deadline) {
    log.error(`Voting deadline ${inputPoll.deadline} has passed (now: ${now})`);
    return 11;
  }
  
  // 3. Verify vote is 0 or 1
  if (vote.vote !== 0 && vote.vote !== 1) {
    log.error(`Vote must be 0 (no) or 1 (yes), got ${vote.vote}`);
    return 12;
  }
  
  // 4. Verify poll_id matches
  if (!bytesEqual(vote.poll_id, inputPoll.poll_id)) {
    log.error("Vote poll_id doesn't match poll");
    return 13;
  }
  
  // 5. Verify vote count incremented correctly
  let expectedYes = inputPoll.yes_count;
  let expectedNo = inputPoll.no_count;
  
  if (vote.vote === 1) {
    expectedYes += 1;
  } else {
    expectedNo += 1;
  }
  
  if (outputPoll.yes_count !== expectedYes || outputPoll.no_count !== expectedNo) {
    log.error(
      `Vote counts incorrect: expected yes=${expectedYes} no=${expectedNo}, ` +
      `got yes=${outputPoll.yes_count} no=${outputPoll.no_count}`
    );
    return 14;
  }
  
  // 6. Verify poll status unchanged
  if (outputPoll.status !== inputPoll.status) {
    log.error("Poll status cannot change when voting");
    return 15;
  }
  
  // 7. Verify deadline unchanged
  if (outputPoll.deadline !== inputPoll.deadline) {
    log.error("Poll deadline cannot change");
    return 16;
  }
  
  log.info(`Vote cast successfully: ${vote.vote === 1 ? 'YES' : 'NO'}`);
  return 0; // Success
}


/**
 * Validate poll closing
 * 
 * Checks:
 * 1. Poll was active
 * 2. Deadline has passed
 * 3. Status changed to closed (1)
 * 4. Vote counts unchanged
 * 5. Other fields unchanged
 */
function validateClosePoll(): number {
  log.info("Validating CLOSE_POLL");
  
  // Load input poll
  const inputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_INPUT);
  const inputPoll = parsePollData(new Uint8Array(inputPollData));
  
  // Load output poll
  const outputPollData = HighLevel.loadCellData(0, bindings.SOURCE_GROUP_OUTPUT);
  const outputPoll = parsePollData(new Uint8Array(outputPollData));
  
  // 1. Verify poll was active
  if (inputPoll.status !== 0) {
    log.error(`Poll is already closed: status=${inputPoll.status}`);
    return 20;
  }
  
  // 2. Check deadline has passed
  const now = getCurrentTime();
  if (now < inputPoll.deadline) {
    log.error(`Deadline ${inputPoll.deadline} hasn't passed yet (now: ${now})`);
    return 21;
  }
  
  // 3. Verify status changed to closed
  if (outputPoll.status !== 1) {
    log.error(`Poll status must be set to 1 (closed), got ${outputPoll.status}`);
    return 22;
  }
  
  // 4. Verify vote counts unchanged
  if (outputPoll.yes_count !== inputPoll.yes_count || 
      outputPoll.no_count !== inputPoll.no_count) {
    log.error(
      `Vote counts cannot change when closing: ` +
      `input yes=${inputPoll.yes_count} no=${inputPoll.no_count}, ` +
      `output yes=${outputPoll.yes_count} no=${outputPoll.no_count}`
    );
    return 23;
  }
  
  // 5. Verify other fields unchanged
  if (!bytesEqual(outputPoll.poll_id, inputPoll.poll_id)) {
    log.error("Poll ID cannot change");
    return 24;
  }
  
  if (outputPoll.question !== inputPoll.question) {
    log.error("Question cannot change");
    return 25;
  }
  
  log.info(`Poll closed successfully: yes=${outputPoll.yes_count}, no=${outputPoll.no_count}`);
  return 0; // Success
}

function main(): number {
  // Enable debug logging
  log.setLevel(log.LogLevel.Debug);
  log.info("=== CKB Voting Script Starting ===");
  
  try {
    // Detect which operation is being performed
    const operation = detectOperation();
    
    // Execute appropriate validation
    switch (operation) {
      case VotingOperation.CREATE_POLL:
        return validateCreatePoll();
        
      case VotingOperation.CAST_VOTE:
        return validateCastVote();
        
      case VotingOperation.CLOSE_POLL:
        return validateClosePoll();
        
      default:
        log.error(`Unknown operation: ${operation}`);
        return 1;
    }
  } catch (error) {
    log.error(`Script error: ${error}`);
    return 1;
  }
}

// Exit with result code
bindings.exit(main());