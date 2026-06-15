//! CKB-VM tests for the non-ZK governance protocol.
//!
//! These fixtures intentionally mirror the Rust contract codec and syscall
//! assumptions locally. They exercise the compiled RISC-V script with
//! ckb-testtool rather than the TypeScript model tests.

use ckb_testtool::builtin::ALWAYS_SUCCESS;
use ckb_testtool::ckb_error::Error as CkbError;
use ckb_testtool::ckb_hash::new_blake2b;
use ckb_testtool::ckb_types::{
    bytes::Bytes,
    core::{Cycle, EpochNumberWithFraction, HeaderBuilder, TransactionBuilder},
    packed::{Byte32, CellDep, CellInput, CellOutput, OutPoint, Script, WitnessArgs},
    prelude::*,
};
use ckb_testtool::context::Context;

const MAX_CYCLES: u64 = 100_000_000;

const OP_CREATE_POLL: u8 = 0x01;
const OP_CREATE_VOTE_INTENT: u8 = 0x02;
const OP_AGGREGATE_VOTES: u8 = 0x03;
const OP_CLOSE_POLL: u8 = 0x04;
const OP_DELEGATE: u8 = 0x05;
const OP_REVOKE_DELEGATION: u8 = 0x06;
const OP_CREATE_TALLY_SHARD: u8 = 0x07;
const OP_MERGE_TALLY_SHARDS: u8 = 0x08;

const SHANNONS_PER_CKB: u64 = 100_000_000;
const CREATOR_DEPOSIT_SHANNONS: u64 = 500 * SHANNONS_PER_CKB;
const VOTER_DEPOSIT_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
const DELEGATION_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
const TALLY_SHARD_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
const TALLY_MERGE_RESULT_MIN_SHANNONS: u64 = 61 * SHANNONS_PER_CKB;
const MERGE_COVERAGE_BYTES: usize = 32;
const MAX_SHARDS_PER_MERGE: usize = 8;
const MAX_DIRECT_CLOSE_SHARDS: u32 = 8;
const FORCE_CLOSE_GRACE_EPOCHS: u64 = 10;
const POLL_CELL_SHANNONS: u64 = 900 * SHANNONS_PER_CKB;

#[derive(Clone, Debug, PartialEq, Eq)]
struct EncodedScript {
    code_hash: [u8; 32],
    hash_type: u8,
    args: Vec<u8>,
}

#[derive(Clone, Debug)]
struct PollData {
    question: Vec<u8>,
    options: Vec<Vec<u8>>,
    vote_counts: Vec<u64>,
    deadline: u64,
    creator: [u8; 32],
    creator_lock: EncodedScript,
    is_closed: bool,
    total_voters: u64,
    creator_deposit: u64,
    pending_intent_count: u64,
    counted_voter_lock_hashes: Vec<[u8; 32]>,
    token_weighted: bool,
    udt_type_hash: [u8; 32],
    shard_count: u32,
}

#[derive(Clone, Debug)]
struct VoteIntentData {
    poll_type_hash: [u8; 32],
    voter_lock_hash: [u8; 32],
    option_index: u8,
    voted_at_epoch: u64,
    aggregated: bool,
    refund_lock: EncodedScript,
}

#[derive(Clone, Debug)]
struct DelegationData {
    delegator_lock_hash: [u8; 32],
    delegate_lock_hash: [u8; 32],
    poll_type_hash: [u8; 32],
    expires_epoch: u64,
}

#[derive(Clone, Debug)]
struct TallyShardData {
    poll_type_hash: [u8; 32],
    shard_id: u32,
    shard_count: u32,
    vote_counts: Vec<u64>,
    total_voters: u64,
    counted_voter_lock_hashes: Vec<[u8; 32]>,
    finalized: bool,
}

#[derive(Clone, Debug)]
struct TallyMergeResultData {
    poll_type_hash: [u8; 32],
    coverage: [u8; MERGE_COVERAGE_BYTES],
    vote_counts: Vec<u64>,
    total_voters: u64,
    merge_level: u32,
    version: u32,
}

#[derive(Clone)]
struct Fixture {
    context: Context,
    governance_op: OutPoint,
    always_success_op: OutPoint,
    always_success: Script,
    header_hash: Byte32,
    epoch: u64,
}

struct PollFixture {
    context: Context,
    governance_op: OutPoint,
    always_success_op: OutPoint,
    always_success: Script,
    header_hash: Byte32,
    epoch: u64,
    creator_lock: Script,
    creator_auth_op: OutPoint,
    poll_type: Script,
    poll_type_hash: [u8; 32],
    poll_lock: Script,
    open_poll: PollData,
    poll_op: OutPoint,
    shard_ops: Vec<OutPoint>,
    shard_data: Vec<TallyShardData>,
}

fn script_binary() -> Bytes {
    let path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join("target")
        .join("riscv64imac-unknown-none-elf")
        .join("release")
        .join("governance-contract");
    let bytes = std::fs::read(&path).unwrap_or_else(|_| {
        panic!(
            "governance contract binary not found at {}; run `pnpm build:contract:rust` first",
            path.display()
        )
    });
    bytes.into()
}

fn fixture(epoch: u64) -> Fixture {
    let mut context = Context::default();
    let governance_op = context.deploy_cell(script_binary());
    let always_success_op = context.deploy_cell(ALWAYS_SUCCESS.clone());
    let always_success = context
        .build_script(&always_success_op, Bytes::new())
        .expect("always-success script");
    let header = HeaderBuilder::default()
        .number(epoch)
        .epoch(EpochNumberWithFraction::new(epoch, 0, 1).pack())
        .build();
    let header_hash = header.hash();
    context.insert_header(header);

    Fixture {
        context,
        governance_op,
        always_success_op,
        always_success,
        header_hash,
        epoch,
    }
}

fn governance_script(fixture: &mut Fixture, op: u8, scope: &[u8]) -> Script {
    let mut args = Vec::with_capacity(1 + scope.len());
    args.push(op);
    args.extend_from_slice(scope);
    fixture
        .context
        .build_script(&fixture.governance_op, Bytes::from(args))
        .expect("governance script")
}

fn governance_script_from_parts(
    context: &mut Context,
    governance_op: &OutPoint,
    op: u8,
    scope: &[u8],
) -> Script {
    let mut args = Vec::with_capacity(1 + scope.len());
    args.push(op);
    args.extend_from_slice(scope);
    context
        .build_script(governance_op, Bytes::from(args))
        .expect("governance script")
}

fn create_poll_script(fixture: &mut Fixture, type_id: &[u8; 32]) -> Script {
    governance_script(fixture, OP_CREATE_POLL, type_id)
}

#[allow(dead_code)]
fn aggregate_votes_script(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
) -> Script {
    governance_script_from_parts(context, governance_op, OP_AGGREGATE_VOTES, poll_type_hash)
}

fn close_poll_script(fixture: &mut Fixture, poll_type_hash: &[u8; 32]) -> Script {
    governance_script(fixture, OP_CLOSE_POLL, poll_type_hash)
}

fn vote_intent_script(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
) -> Script {
    governance_script_from_parts(
        context,
        governance_op,
        OP_CREATE_VOTE_INTENT,
        poll_type_hash,
    )
}

fn delegate_script(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
) -> Script {
    governance_script_from_parts(context, governance_op, OP_DELEGATE, poll_type_hash)
}

#[allow(dead_code)]
fn revoke_delegation_script(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
) -> Script {
    governance_script_from_parts(context, governance_op, OP_REVOKE_DELEGATION, poll_type_hash)
}

fn tally_shard_script(fixture: &mut Fixture, poll_type_hash: &[u8; 32], shard_id: u32) -> Script {
    governance_script(
        fixture,
        OP_CREATE_TALLY_SHARD,
        &scope_with_shard(poll_type_hash, shard_id),
    )
}

fn tally_shard_script_from_parts(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
    shard_id: u32,
) -> Script {
    governance_script_from_parts(
        context,
        governance_op,
        OP_CREATE_TALLY_SHARD,
        &scope_with_shard(poll_type_hash, shard_id),
    )
}

fn merge_tally_shards_script(
    context: &mut Context,
    governance_op: &OutPoint,
    poll_type_hash: &[u8; 32],
) -> Script {
    governance_script_from_parts(
        context,
        governance_op,
        OP_MERGE_TALLY_SHARDS,
        poll_type_hash,
    )
}

fn encode_script(script: &Script) -> EncodedScript {
    EncodedScript {
        code_hash: script.code_hash().as_slice().try_into().expect("code hash"),
        hash_type: u8::from(script.hash_type()),
        args: script.args().raw_data().to_vec(),
    }
}

fn script_hash(script: &Script) -> [u8; 32] {
    script
        .calc_script_hash()
        .as_slice()
        .try_into()
        .expect("script hash")
}

fn cell_dep(out_point: OutPoint) -> CellDep {
    CellDep::new_builder().out_point(out_point).build()
}

fn input(out_point: OutPoint) -> CellInput {
    CellInput::new_builder().previous_output(out_point).build()
}

fn output(capacity: u64, lock: Script, type_script: Option<Script>) -> CellOutput {
    CellOutput::new_builder()
        .capacity(capacity)
        .lock(lock)
        .type_(type_script.pack())
        .build()
}

fn plain_cell(context: &mut Context, lock: Script, capacity: u64) -> OutPoint {
    context.create_cell(output(capacity, lock, None), Bytes::new())
}

fn governance_cell(
    context: &mut Context,
    capacity: u64,
    lock: Script,
    type_script: Script,
    data: Bytes,
) -> OutPoint {
    context.create_cell(output(capacity, lock, Some(type_script)), data)
}

fn witness_option(option: u8) -> Bytes {
    WitnessArgs::new_builder()
        .input_type(Some(Bytes::from(vec![option])).pack())
        .build()
        .as_bytes()
}

fn blank_witness() -> Bytes {
    WitnessArgs::default().as_bytes()
}

fn tx_with_header(builder: TransactionBuilder, header_hash: Byte32) -> TransactionBuilder {
    builder.header_dep(header_hash)
}

fn verify_ok(context: &mut Context, tx: ckb_testtool::ckb_types::core::TransactionView) -> Cycle {
    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect("tx should verify")
}

fn verify_err(
    context: &mut Context,
    tx: ckb_testtool::ckb_types::core::TransactionView,
) -> CkbError {
    let tx = context.complete_tx(tx);
    context
        .verify_tx(&tx, MAX_CYCLES)
        .expect_err("tx should fail")
}

fn assert_exit_code(err: &CkbError, expected: i8) {
    let rendered = err.to_string();
    let needle = format!("code {expected}");
    assert!(
        rendered.contains(&needle),
        "expected `{needle}` in error, got: {rendered}"
    );
}

fn encode_u32(output: &mut Vec<u8>, value: u32) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn encode_u64(output: &mut Vec<u8>, value: u64) {
    output.extend_from_slice(&value.to_le_bytes());
}

fn encode_bool(output: &mut Vec<u8>, value: bool) {
    output.push(if value { 1 } else { 0 });
}

fn encode_bytes(output: &mut Vec<u8>, bytes: &[u8]) {
    encode_u32(output, bytes.len() as u32);
    output.extend_from_slice(bytes);
}

fn encode_u64_vec(output: &mut Vec<u8>, values: &[u64]) {
    encode_u32(output, values.len() as u32);
    for value in values {
        encode_u64(output, *value);
    }
}

fn encode_bytes32_vec(output: &mut Vec<u8>, values: &[[u8; 32]]) {
    encode_u32(output, values.len() as u32);
    for value in values {
        output.extend_from_slice(value);
    }
}

fn encode_encoded_script(output: &mut Vec<u8>, script: &EncodedScript) {
    output.extend_from_slice(&script.code_hash);
    output.push(script.hash_type);
    encode_bytes(output, &script.args);
}

fn encode_poll(data: &PollData) -> Bytes {
    let mut output = Vec::new();
    encode_bytes(&mut output, &data.question);
    encode_u32(&mut output, data.options.len() as u32);
    for option in &data.options {
        encode_bytes(&mut output, option);
    }
    encode_u64_vec(&mut output, &data.vote_counts);
    encode_u64(&mut output, data.deadline);
    output.extend_from_slice(&data.creator);
    encode_encoded_script(&mut output, &data.creator_lock);
    encode_bool(&mut output, data.is_closed);
    encode_u64(&mut output, data.total_voters);
    encode_u64(&mut output, data.creator_deposit);
    encode_u64(&mut output, data.pending_intent_count);
    encode_bytes32_vec(&mut output, &data.counted_voter_lock_hashes);
    encode_bool(&mut output, data.token_weighted);
    output.extend_from_slice(&data.udt_type_hash);
    encode_u32(&mut output, data.shard_count);
    Bytes::from(output)
}

fn encode_vote_intent(data: &VoteIntentData) -> Bytes {
    let mut output = Vec::new();
    output.extend_from_slice(&data.poll_type_hash);
    output.extend_from_slice(&data.voter_lock_hash);
    output.push(data.option_index);
    encode_u64(&mut output, data.voted_at_epoch);
    encode_bool(&mut output, data.aggregated);
    encode_encoded_script(&mut output, &data.refund_lock);
    Bytes::from(output)
}

fn encode_delegation(data: &DelegationData) -> Bytes {
    let mut output = Vec::new();
    output.extend_from_slice(&data.delegator_lock_hash);
    output.extend_from_slice(&data.delegate_lock_hash);
    output.extend_from_slice(&data.poll_type_hash);
    encode_u64(&mut output, data.expires_epoch);
    Bytes::from(output)
}

fn encode_tally_shard(data: &TallyShardData) -> Bytes {
    let mut output = Vec::new();
    output.extend_from_slice(&data.poll_type_hash);
    encode_u32(&mut output, data.shard_id);
    encode_u32(&mut output, data.shard_count);
    encode_u64_vec(&mut output, &data.vote_counts);
    encode_u64(&mut output, data.total_voters);
    encode_bytes32_vec(&mut output, &data.counted_voter_lock_hashes);
    encode_bool(&mut output, data.finalized);
    Bytes::from(output)
}

fn encode_tally_merge_result(data: &TallyMergeResultData) -> Bytes {
    let mut output = Vec::new();
    output.extend_from_slice(&data.poll_type_hash);
    output.extend_from_slice(&data.coverage);
    encode_u64_vec(&mut output, &data.vote_counts);
    encode_u64(&mut output, data.total_voters);
    encode_u32(&mut output, data.merge_level);
    encode_u32(&mut output, data.version);
    Bytes::from(output)
}

fn with_trailing_byte(mut bytes: Bytes) -> Bytes {
    let mut data = bytes.to_vec();
    data.push(0xEE);
    bytes = Bytes::from(data);
    bytes
}

fn mutate_byte(bytes: Bytes, offset: usize, value: u8) -> Bytes {
    let mut data = bytes.to_vec();
    data[offset] = value;
    Bytes::from(data)
}

fn calc_type_id(input: &CellInput, output_index: u64) -> [u8; 32] {
    let mut blake2b = new_blake2b();
    blake2b.update(input.as_slice());
    blake2b.update(&output_index.to_le_bytes());
    let mut id = [0u8; 32];
    blake2b.finalize(&mut id);
    id
}

fn blake2b_256(input: &[u8]) -> [u8; 32] {
    let mut blake2b = new_blake2b();
    blake2b.update(input);
    let mut digest = [0u8; 32];
    blake2b.finalize(&mut digest);
    digest
}

fn derive_tally_shard_id(
    poll_type_hash: &[u8; 32],
    voter_lock_hash: &[u8; 32],
    shard_count: u32,
) -> u32 {
    let mut input = [0u8; 64];
    input[..32].copy_from_slice(poll_type_hash);
    input[32..].copy_from_slice(voter_lock_hash);
    let digest = blake2b_256(&input);
    let bucket = u64::from_le_bytes(digest[..8].try_into().expect("bucket bytes"));
    (bucket % u64::from(shard_count)) as u32
}

fn scope_with_shard(poll_type_hash: &[u8; 32], shard_id: u32) -> Vec<u8> {
    let mut scope = Vec::with_capacity(36);
    scope.extend_from_slice(poll_type_hash);
    scope.extend_from_slice(&shard_id.to_le_bytes());
    scope
}

fn coverage_for_shards(shard_ids: &[u32]) -> [u8; MERGE_COVERAGE_BYTES] {
    let mut coverage = [0u8; MERGE_COVERAGE_BYTES];
    for shard_id in shard_ids {
        let byte_index = (*shard_id / 8) as usize;
        let bit = (*shard_id % 8) as u8;
        coverage[byte_index] |= 1u8 << bit;
    }
    coverage
}

fn poll_is_closed_offset(data: &PollData) -> usize {
    let mut offset = 4 + data.question.len() + 4;
    for option in &data.options {
        offset += 4 + option.len();
    }
    offset += 4 + data.vote_counts.len() * 8;
    offset += 8 + 32 + 32 + 1 + 4 + data.creator_lock.args.len();
    offset
}

fn poll_token_weighted_offset(data: &PollData) -> usize {
    let mut offset = poll_is_closed_offset(data);
    offset += 1 + 8 + 8 + 8;
    offset += 4 + data.counted_voter_lock_hashes.len() * 32;
    offset
}

fn vote_intent_aggregated_offset() -> usize {
    32 + 32 + 1 + 8
}

fn shard_finalized_offset(data: &TallyShardData) -> usize {
    32 + 4 + 4 + 4 + data.vote_counts.len() * 8 + 8 + 4 + data.counted_voter_lock_hashes.len() * 32
}

fn create_poll_tx(
    fixture: &mut Fixture,
    shard_count: u32,
    wrong_type_id: Option<[u8; 32]>,
    omit_last_shard: bool,
    swap_shard_outputs: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let seed_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let seed_input = input(seed_op);
    let type_id = wrong_type_id.unwrap_or_else(|| calc_type_id(&seed_input, 0));
    let poll_type = create_poll_script(fixture, &type_id);
    let poll_type_hash = script_hash(&poll_type);
    let poll_lock = close_poll_script(fixture, &poll_type_hash);
    let creator_hash = script_hash(&fixture.always_success);
    let poll = PollData {
        question: b"Choose a protocol path?".to_vec(),
        options: vec![b"yes".to_vec(), b"no".to_vec()],
        vote_counts: vec![0, 0],
        deadline: fixture.epoch + 5,
        creator: creator_hash,
        creator_lock: encode_script(&fixture.always_success),
        is_closed: false,
        total_voters: 0,
        creator_deposit: CREATOR_DEPOSIT_SHANNONS,
        pending_intent_count: 0,
        counted_voter_lock_hashes: Vec::new(),
        token_weighted: false,
        udt_type_hash: [0u8; 32],
        shard_count,
    };
    let poll_bytes = encode_poll(&poll);
    let mut builder = TransactionBuilder::default()
        .input(seed_input)
        .output(output(
            POLL_CELL_SHANNONS,
            poll_lock,
            Some(poll_type.clone()),
        ))
        .output_data(poll_bytes.pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .witness(blank_witness().pack());

    let mut shard_ids: Vec<u32> = (0..shard_count).collect();
    if swap_shard_outputs && shard_ids.len() >= 2 {
        shard_ids.swap(0, 1);
    }
    if omit_last_shard {
        shard_ids.pop();
    }

    for shard_id in shard_ids {
        let shard_script = tally_shard_script(fixture, &poll_type_hash, shard_id);
        let shard = TallyShardData {
            poll_type_hash,
            shard_id,
            shard_count,
            vote_counts: vec![0, 0],
            total_voters: 0,
            counted_voter_lock_hashes: Vec::new(),
            finalized: false,
        };
        builder = builder
            .output(output(
                TALLY_SHARD_MIN_SHANNONS,
                shard_script.clone(),
                Some(shard_script),
            ))
            .output_data(encode_tally_shard(&shard).pack());
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn create_poll_fixture(epoch: u64, shard_count: u32, finalized_shards: bool) -> PollFixture {
    let mut fixture = fixture(epoch);
    let creator_lock = fixture.always_success.clone();
    let creator_auth_op = plain_cell(
        &mut fixture.context,
        creator_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let creator_input = input(creator_auth_op.clone());
    let type_id = calc_type_id(&creator_input, 0);
    let poll_type = create_poll_script(&mut fixture, &type_id);
    let poll_type_hash = script_hash(&poll_type);
    let poll_lock = close_poll_script(&mut fixture, &poll_type_hash);
    let creator_hash = script_hash(&creator_lock);
    let open_poll = PollData {
        question: b"Should the protocol use sharded tally cells?".to_vec(),
        options: vec![b"yes".to_vec(), b"no".to_vec()],
        vote_counts: vec![0, 0],
        deadline: epoch + 5,
        creator: creator_hash,
        creator_lock: encode_script(&creator_lock),
        is_closed: false,
        total_voters: 0,
        creator_deposit: CREATOR_DEPOSIT_SHANNONS,
        pending_intent_count: 0,
        counted_voter_lock_hashes: Vec::new(),
        token_weighted: false,
        udt_type_hash: [0u8; 32],
        shard_count,
    };
    let open_poll_bytes = encode_poll(&open_poll);
    let poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        poll_lock.clone(),
        poll_type.clone(),
        open_poll_bytes.clone(),
    );

    let mut shard_ops = Vec::new();
    let mut shard_data = Vec::new();
    for shard_id in 0..shard_count {
        let shard_script = tally_shard_script(&mut fixture, &poll_type_hash, shard_id);
        let shard = TallyShardData {
            poll_type_hash,
            shard_id,
            shard_count,
            vote_counts: vec![0, 0],
            total_voters: 0,
            counted_voter_lock_hashes: Vec::new(),
            finalized: finalized_shards,
        };
        let bytes = encode_tally_shard(&shard);
        let op = governance_cell(
            &mut fixture.context,
            TALLY_SHARD_MIN_SHANNONS,
            shard_script.clone(),
            shard_script.clone(),
            bytes.clone(),
        );
        shard_ops.push(op);
        shard_data.push(shard);
    }

    PollFixture {
        context: fixture.context,
        governance_op: fixture.governance_op,
        always_success_op: fixture.always_success_op,
        always_success: fixture.always_success,
        header_hash: fixture.header_hash,
        epoch,
        creator_lock,
        creator_auth_op,
        poll_type,
        poll_type_hash,
        poll_lock,
        open_poll,
        poll_op,
        shard_ops,
        shard_data,
    }
}

fn close_poll_tx(
    fixture: &mut PollFixture,
    include_creator_auth: bool,
    creator_auth_override: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut closed = fixture.open_poll.clone();
    closed.is_closed = true;
    closed.vote_counts = vec![0, 0];
    closed.total_voters = 0;
    closed.pending_intent_count = 0;
    closed.counted_voter_lock_hashes.clear();

    let mut builder = TransactionBuilder::default()
        .input(input(fixture.poll_op.clone()))
        .output(output(
            POLL_CELL_SHANNONS,
            fixture.poll_lock.clone(),
            Some(fixture.poll_type.clone()),
        ))
        .output_data(encode_poll(&closed).pack())
        .output(output(
            CREATOR_DEPOSIT_SHANNONS,
            fixture.creator_lock.clone(),
            None,
        ))
        .output_data(Bytes::new().pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .witness(blank_witness().pack());

    if include_creator_auth {
        builder = builder
            .input(input(
                creator_auth_override.unwrap_or_else(|| fixture.creator_auth_op.clone()),
            ))
            .witness(blank_witness().pack());
    }

    for (index, shard_op) in fixture.shard_ops.iter().enumerate() {
        builder = builder
            .input(input(shard_op.clone()))
            .output(output(
                TALLY_SHARD_MIN_SHANNONS,
                fixture.creator_lock.clone(),
                None,
            ))
            .output_data(Bytes::new().pack())
            .witness(blank_witness().pack());
        assert!(fixture.shard_data[index].finalized);
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn poll_dep_from_fixture(fixture: &mut PollFixture, closed: bool) -> OutPoint {
    let mut poll = fixture.open_poll.clone();
    poll.is_closed = closed;
    let data = encode_poll(&poll);
    governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        data,
    )
}

fn poll_dep_from_data(fixture: &mut PollFixture, poll: PollData) -> OutPoint {
    governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&poll),
    )
}

fn shard_script_for_fixture(fixture: &mut PollFixture, shard_id: u32) -> Script {
    tally_shard_script_from_parts(
        &mut fixture.context,
        &fixture.governance_op,
        &fixture.poll_type_hash,
        shard_id,
    )
}

fn shard_cell_with_capacity(
    fixture: &mut PollFixture,
    shard: &TallyShardData,
    capacity: u64,
) -> (OutPoint, Script) {
    let script = shard_script_for_fixture(fixture, shard.shard_id);
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        script.clone(),
        script.clone(),
        encode_tally_shard(shard),
    );
    (op, script)
}

fn merge_script_for_fixture(fixture: &mut PollFixture) -> Script {
    merge_tally_shards_script(
        &mut fixture.context,
        &fixture.governance_op,
        &fixture.poll_type_hash,
    )
}

fn merge_cell_with_capacity(
    fixture: &mut PollFixture,
    result: &TallyMergeResultData,
    capacity: u64,
) -> (OutPoint, Script) {
    let script = merge_script_for_fixture(fixture);
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        script.clone(),
        script.clone(),
        encode_tally_merge_result(result),
    );
    (op, script)
}

fn live_intent_cell_with_capacity(
    fixture: &mut PollFixture,
    poll_hash: [u8; 32],
    type_scope: [u8; 32],
    voter_hash: [u8; 32],
    option_index: u8,
    aggregated: bool,
    refund_lock: Script,
    capacity: u64,
) -> (OutPoint, VoteIntentData, Script) {
    let intent_type = vote_intent_script(&mut fixture.context, &fixture.governance_op, &type_scope);
    let intent = VoteIntentData {
        poll_type_hash: poll_hash,
        voter_lock_hash: voter_hash,
        option_index,
        voted_at_epoch: fixture.epoch,
        aggregated,
        refund_lock: encode_script(&refund_lock),
    };
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        intent_type.clone(),
        intent_type.clone(),
        encode_vote_intent(&intent),
    );
    (op, intent, intent_type)
}

fn intent_cell_from_data(
    fixture: &mut PollFixture,
    intent: VoteIntentData,
    type_scope: [u8; 32],
    capacity: u64,
) -> (OutPoint, VoteIntentData, Script) {
    let intent_type = vote_intent_script(&mut fixture.context, &fixture.governance_op, &type_scope);
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        intent_type.clone(),
        intent_type.clone(),
        encode_vote_intent(&intent),
    );
    (op, intent, intent_type)
}

fn voter_for_shard_excluding(
    fixture: &mut PollFixture,
    shard_id: u32,
    seed_start: u8,
    excluded: &[[u8; 32]],
) -> (Script, [u8; 32]) {
    for seed in seed_start..=u8::MAX {
        let lock = fixture
            .context
            .build_script(&fixture.always_success_op, Bytes::from(vec![seed]))
            .expect("voter lock");
        let hash = script_hash(&lock);
        if derive_tally_shard_id(
            &fixture.poll_type_hash,
            &hash,
            fixture.open_poll.shard_count,
        ) == shard_id
            && !excluded.iter().any(|existing| existing == &hash)
        {
            return (lock, hash);
        }
    }
    panic!("unable to find voter for shard {shard_id}");
}

fn voter_for_shard(fixture: &mut PollFixture, shard_id: u32, seed_start: u8) -> (Script, [u8; 32]) {
    voter_for_shard_excluding(fixture, shard_id, seed_start, &[])
}

fn voter_for_other_shard(
    fixture: &mut PollFixture,
    shard_id: u32,
    seed_start: u8,
) -> (Script, [u8; 32]) {
    for seed in seed_start..=u8::MAX {
        let lock = fixture
            .context
            .build_script(&fixture.always_success_op, Bytes::from(vec![seed]))
            .expect("voter lock");
        let hash = script_hash(&lock);
        if derive_tally_shard_id(
            &fixture.poll_type_hash,
            &hash,
            fixture.open_poll.shard_count,
        ) != shard_id
        {
            return (lock, hash);
        }
    }
    panic!("unable to find voter outside shard {shard_id}");
}

fn build_tally_shard_aggregation_tx(
    fixture: &mut PollFixture,
    shard_op: OutPoint,
    before_shard: TallyShardData,
    after_shard: TallyShardData,
    intents: Vec<(OutPoint, VoteIntentData, Script, u64)>,
    marker_overrides: Vec<Option<(VoteIntentData, Script, Script, u64)>>,
    poll_dep: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let shard_script = shard_script_for_fixture(fixture, before_shard.shard_id);
    let mut builder = TransactionBuilder::default()
        .input(input(shard_op))
        .output(output(
            TALLY_SHARD_MIN_SHANNONS,
            shard_script.clone(),
            Some(shard_script),
        ))
        .output_data(encode_tally_shard(&after_shard).pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .cell_dep(cell_dep(
            poll_dep.unwrap_or_else(|| poll_dep_from_fixture(fixture, false)),
        ))
        .witness(blank_witness().pack());

    for (index, (intent_op, intent, intent_script, capacity)) in intents.into_iter().enumerate() {
        let (marker, marker_lock, marker_type, marker_capacity) = marker_overrides
            .get(index)
            .cloned()
            .flatten()
            .unwrap_or_else(|| {
                let mut marker = intent.clone();
                marker.aggregated = true;
                (
                    marker,
                    intent_script.clone(),
                    intent_script.clone(),
                    capacity,
                )
            });
        builder = builder
            .input(input(intent_op))
            .output(output(marker_capacity, marker_lock, Some(marker_type)))
            .output_data(encode_vote_intent(&marker).pack())
            .witness(blank_witness().pack());
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn build_tally_shard_finalization_tx(
    fixture: &mut PollFixture,
    shard_op: OutPoint,
    before_shard: TallyShardData,
    after_shard: TallyShardData,
    poll_dep: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let shard_script = shard_script_for_fixture(fixture, before_shard.shard_id);
    tx_with_header(
        TransactionBuilder::default()
            .input(input(shard_op))
            .output(output(
                TALLY_SHARD_MIN_SHANNONS,
                shard_script.clone(),
                Some(shard_script),
            ))
            .output_data(encode_tally_shard(&after_shard).pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .cell_dep(cell_dep(
                poll_dep.unwrap_or_else(|| poll_dep_from_fixture(fixture, false)),
            ))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

fn close_poll_with_inputs_tx(
    fixture: &mut PollFixture,
    poll_before: PollData,
    poll_after: PollData,
    include_creator_auth: bool,
    tally_inputs: Vec<(OutPoint, u64)>,
    tally_return_locks: Vec<Script>,
    intent_inputs: Vec<(OutPoint, VoteIntentData, Script, u64)>,
    creator_return_capacity: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&poll_before),
    );
    let mut builder = TransactionBuilder::default()
        .input(input(poll_op))
        .output(output(
            POLL_CELL_SHANNONS,
            fixture.poll_lock.clone(),
            Some(fixture.poll_type.clone()),
        ))
        .output_data(encode_poll(&poll_after).pack())
        .output(output(
            creator_return_capacity,
            fixture.creator_lock.clone(),
            None,
        ))
        .output_data(Bytes::new().pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .witness(blank_witness().pack());

    if include_creator_auth {
        builder = builder
            .input(input(fixture.creator_auth_op.clone()))
            .witness(blank_witness().pack());
    }

    for (index, (op, capacity)) in tally_inputs.iter().enumerate() {
        builder = builder
            .input(input(op.clone()))
            .output(output(
                *capacity,
                tally_return_locks
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| fixture.creator_lock.clone()),
                None,
            ))
            .output_data(Bytes::new().pack())
            .witness(blank_witness().pack());
    }

    for (op, intent, refund_lock, capacity) in intent_inputs {
        builder = builder
            .input(input(op))
            .output(output(capacity, refund_lock, None))
            .output_data(Bytes::new().pack())
            .witness(blank_witness().pack());
        let _ = intent;
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn close_poll_with_return_overrides_tx(
    fixture: &mut PollFixture,
    poll_before: PollData,
    poll_after: PollData,
    include_creator_auth: bool,
    tally_inputs: Vec<(OutPoint, u64)>,
    tally_return_locks: Vec<Script>,
    tally_return_capacities: Vec<u64>,
    intent_inputs: Vec<(OutPoint, VoteIntentData, Script, u64)>,
    creator_return_capacity: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&poll_before),
    );
    let mut builder = TransactionBuilder::default()
        .input(input(poll_op))
        .output(output(
            POLL_CELL_SHANNONS,
            fixture.poll_lock.clone(),
            Some(fixture.poll_type.clone()),
        ))
        .output_data(encode_poll(&poll_after).pack())
        .output(output(
            creator_return_capacity,
            fixture.creator_lock.clone(),
            None,
        ))
        .output_data(Bytes::new().pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .witness(blank_witness().pack());

    if include_creator_auth {
        builder = builder
            .input(input(fixture.creator_auth_op.clone()))
            .witness(blank_witness().pack());
    }

    for (index, (op, input_capacity)) in tally_inputs.iter().enumerate() {
        let return_capacity = tally_return_capacities
            .get(index)
            .copied()
            .unwrap_or(*input_capacity);
        builder = builder
            .input(input(op.clone()))
            .output(output(
                return_capacity,
                tally_return_locks
                    .get(index)
                    .cloned()
                    .unwrap_or_else(|| fixture.creator_lock.clone()),
                None,
            ))
            .output_data(Bytes::new().pack())
            .witness(blank_witness().pack());
    }

    for (op, intent, refund_lock, capacity) in intent_inputs {
        builder = builder
            .input(input(op))
            .output(output(capacity, refund_lock, None))
            .output_data(Bytes::new().pack())
            .witness(blank_witness().pack());
        let _ = intent;
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn build_merge_tx(
    fixture: &mut PollFixture,
    inputs: Vec<OutPoint>,
    output_result: TallyMergeResultData,
    output_capacity: u64,
    output_lock_override: Option<Script>,
    output_type_override: Option<Script>,
    output_data_override: Option<Bytes>,
    extra_same_group_output: bool,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let merge_script = merge_script_for_fixture(fixture);
    let output_lock = output_lock_override.unwrap_or_else(|| merge_script.clone());
    let output_type = output_type_override.unwrap_or_else(|| merge_script.clone());
    let output_data =
        output_data_override.unwrap_or_else(|| encode_tally_merge_result(&output_result));
    let mut builder = TransactionBuilder::default()
        .output(output(output_capacity, output_lock, Some(output_type)))
        .output_data(output_data.pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .cell_dep(cell_dep(poll_dep_from_fixture(fixture, false)));

    for op in inputs {
        builder = builder.input(input(op)).witness(blank_witness().pack());
    }

    if extra_same_group_output {
        builder = builder
            .output(output(
                TALLY_MERGE_RESULT_MIN_SHANNONS,
                merge_script.clone(),
                Some(merge_script),
            ))
            .output_data(encode_tally_merge_result(&output_result).pack());
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn finalized_shard(
    fixture: &mut PollFixture,
    shard_id: u32,
    vote_counts: Vec<u64>,
    seed: u8,
) -> TallyShardData {
    let mut voters = Vec::new();
    let total_voters: u64 = vote_counts.iter().sum();
    for offset in 0..total_voters {
        let (_, hash) = voter_for_shard_excluding(
            fixture,
            shard_id,
            seed.saturating_add(offset as u8),
            &voters,
        );
        voters.push(hash);
    }
    TallyShardData {
        poll_type_hash: fixture.poll_type_hash,
        shard_id,
        shard_count: fixture.open_poll.shard_count,
        vote_counts,
        total_voters,
        counted_voter_lock_hashes: voters,
        finalized: true,
    }
}

fn summed_vote_counts(shards: &[TallyShardData]) -> Vec<u64> {
    let mut sums = vec![0u64; shards[0].vote_counts.len()];
    for shard in shards {
        for (index, count) in shard.vote_counts.iter().enumerate() {
            sums[index] += count;
        }
    }
    sums
}

fn summed_total_voters(shards: &[TallyShardData]) -> u64 {
    shards.iter().map(|shard| shard.total_voters).sum()
}

fn merge_result_for_shards(
    poll_type_hash: [u8; 32],
    shards: &[TallyShardData],
    merge_level: u32,
) -> TallyMergeResultData {
    let shard_ids: Vec<u32> = shards.iter().map(|shard| shard.shard_id).collect();
    TallyMergeResultData {
        poll_type_hash,
        coverage: coverage_for_shards(&shard_ids),
        vote_counts: summed_vote_counts(shards),
        total_voters: summed_total_voters(shards),
        merge_level,
        version: 1,
    }
}

fn closed_poll_from_result(
    before: &PollData,
    vote_counts: Vec<u64>,
    total_voters: u64,
) -> PollData {
    let mut after = before.clone();
    after.is_closed = true;
    after.vote_counts = vote_counts;
    after.total_voters = total_voters;
    after.pending_intent_count = 0;
    after.counted_voter_lock_hashes.clear();
    after
}

fn set_fixture_epoch(fixture: &mut PollFixture, epoch: u64) {
    fixture.epoch = epoch;
    let header = HeaderBuilder::default()
        .number(epoch)
        .epoch(EpochNumberWithFraction::new(epoch, 0, 1).pack())
        .build();
    fixture.header_hash = header.hash();
    fixture.context.insert_header(header);
}

fn build_create_intent_tx(
    fixture: &mut PollFixture,
    signer_op: OutPoint,
    signer_lock: Script,
    voter_lock_hash: [u8; 32],
    refund_lock: Script,
    option_index: u8,
    voted_at_epoch: u64,
    poll_hash_override: Option<[u8; 32]>,
    intent_type_hash_override: Option<[u8; 32]>,
    extra_dep: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let encoded_poll_hash = poll_hash_override.unwrap_or(fixture.poll_type_hash);
    let script_poll_hash = intent_type_hash_override.unwrap_or(encoded_poll_hash);
    let intent_type = vote_intent_script(
        &mut fixture.context,
        &fixture.governance_op,
        &script_poll_hash,
    );
    let intent = VoteIntentData {
        poll_type_hash: encoded_poll_hash,
        voter_lock_hash,
        option_index,
        voted_at_epoch,
        aggregated: false,
        refund_lock: encode_script(&refund_lock),
    };
    let mut builder = TransactionBuilder::default()
        .input(input(signer_op))
        .output(output(
            VOTER_DEPOSIT_SHANNONS,
            intent_type.clone(),
            Some(intent_type),
        ))
        .output_data(encode_vote_intent(&intent).pack())
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .cell_dep(cell_dep(poll_dep_from_fixture(fixture, false)))
        .witness(witness_option(option_index).pack());

    if let Some(dep) = extra_dep {
        builder = builder.cell_dep(cell_dep(dep));
    }

    let _ = signer_lock;
    tx_with_header(builder, fixture.header_hash.clone()).build()
}

fn live_intent_cell(
    fixture: &mut PollFixture,
    poll_hash: [u8; 32],
    voter_hash: [u8; 32],
    option_index: u8,
    aggregated: bool,
    refund_lock: Script,
) -> (OutPoint, VoteIntentData, Script) {
    let intent_type = vote_intent_script(&mut fixture.context, &fixture.governance_op, &poll_hash);
    let intent = VoteIntentData {
        poll_type_hash: poll_hash,
        voter_lock_hash: voter_hash,
        option_index,
        voted_at_epoch: fixture.epoch,
        aggregated,
        refund_lock: encode_script(&refund_lock),
    };
    let data = encode_vote_intent(&intent);
    let op = governance_cell(
        &mut fixture.context,
        VOTER_DEPOSIT_SHANNONS,
        intent_type.clone(),
        intent_type.clone(),
        data,
    );
    (op, intent, intent_type)
}

fn refund_omitted_intent_tx(
    fixture: &mut PollFixture,
    intent_op: OutPoint,
    closed_poll_dep: OutPoint,
    refund_lock: Script,
) -> ckb_testtool::ckb_types::core::TransactionView {
    tx_with_header(
        TransactionBuilder::default()
            .input(input(intent_op))
            .output(output(VOTER_DEPOSIT_SHANNONS, refund_lock, None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .cell_dep(cell_dep(closed_poll_dep))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

fn shadow_same_index_type_update_tx(
    fixture: &mut PollFixture,
    input_lock: Script,
    same_index_type: Script,
    input_data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let capacity = 1_000 * SHANNONS_PER_CKB;
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        input_lock,
        same_index_type.clone(),
        input_data.clone(),
    );
    tx_with_header(
        TransactionBuilder::default()
            .input(input(op))
            .output(output(
                capacity,
                fixture.always_success.clone(),
                Some(same_index_type),
            ))
            .output_data(input_data.pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

#[test]
fn create_poll_type_id_and_complete_shards_pass() {
    let mut fixture = fixture(10);
    let tx = create_poll_tx(&mut fixture, 2, None, false, false);

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn create_poll_wrong_type_id_args_fail() {
    let mut fixture = fixture(10);
    let tx = create_poll_tx(&mut fixture, 2, Some([0xAA; 32]), false, false);

    let err = verify_err(&mut fixture.context, tx);
    assert_exit_code(&err, 5);
}

#[test]
fn create_poll_missing_or_misordered_shard_outputs_fail() {
    let mut missing = fixture(10);
    let missing_tx = create_poll_tx(&mut missing, 2, None, true, false);
    assert_exit_code(&verify_err(&mut missing.context, missing_tx), 1);

    let mut misordered = fixture(10);
    let misordered_tx = create_poll_tx(&mut misordered, 2, None, false, true);
    assert_exit_code(&verify_err(&mut misordered.context, misordered_tx), 5);
}

#[test]
fn protocol_poll_lock_and_creator_close_auth_are_enforced() {
    let mut fixture = create_poll_fixture(20, 2, true);
    let close_epoch = fixture.open_poll.deadline + 1;
    set_fixture_epoch(&mut fixture, close_epoch);

    assert_eq!(
        fixture.poll_lock.args().raw_data().to_vec()[0],
        OP_CLOSE_POLL,
        "poll cell lock must use CLOSE_POLL scope"
    );
    assert_ne!(
        fixture.poll_lock.calc_script_hash(),
        fixture.creator_lock.calc_script_hash(),
        "poll cell lock must not be the creator wallet lock"
    );

    let tx = close_poll_tx(&mut fixture, true, None);
    verify_ok(&mut fixture.context, tx);
}

#[test]
fn non_creator_close_before_force_close_grace_fails() {
    let mut fixture = create_poll_fixture(20, 2, true);
    let close_epoch = fixture.open_poll.deadline + 1;
    set_fixture_epoch(&mut fixture, close_epoch);
    let non_creator_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0x99]))
        .expect("non-creator always-success lock");
    let non_creator_op = plain_cell(
        &mut fixture.context,
        non_creator_lock,
        2_000 * SHANNONS_PER_CKB,
    );
    let tx = close_poll_tx(&mut fixture, true, Some(non_creator_op));

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn non_creator_force_close_after_grace_passes() {
    let mut fixture = create_poll_fixture(20, 2, true);
    let force_close_epoch = fixture.open_poll.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1;
    set_fixture_epoch(&mut fixture, force_close_epoch);

    let tx = close_poll_tx(&mut fixture, false, None);
    verify_ok(&mut fixture.context, tx);
}

#[test]
fn vote_intent_creation_validates_scope_option_epoch_and_poll_dep() {
    let mut fixture = create_poll_fixture(30, 2, false);
    let epoch = fixture.epoch;
    let voter_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&voter_lock);
    let voter_op = plain_cell(
        &mut fixture.context,
        voter_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );

    let valid = build_create_intent_tx(
        &mut fixture,
        voter_op.clone(),
        voter_lock.clone(),
        voter_hash,
        voter_lock.clone(),
        1,
        epoch,
        None,
        None,
        None,
    );
    verify_ok(&mut fixture.context, valid);

    let wrong_poll = build_create_intent_tx(
        &mut fixture,
        voter_op.clone(),
        voter_lock.clone(),
        voter_hash,
        voter_lock.clone(),
        1,
        epoch,
        Some([0x42; 32]),
        None,
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, wrong_poll), 5);

    let bad_option = build_create_intent_tx(
        &mut fixture,
        voter_op.clone(),
        voter_lock.clone(),
        voter_hash,
        voter_lock.clone(),
        2,
        epoch,
        None,
        None,
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, bad_option), 5);

    let bad_epoch = build_create_intent_tx(
        &mut fixture,
        voter_op.clone(),
        voter_lock.clone(),
        voter_hash,
        voter_lock.clone(),
        1,
        epoch + 1,
        None,
        None,
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, bad_epoch), 5);

    let wrong_type_args = build_create_intent_tx(
        &mut fixture,
        voter_op,
        voter_lock.clone(),
        voter_hash,
        voter_lock,
        1,
        epoch,
        None,
        Some([0x77; 32]),
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, wrong_type_args), 5);
}

#[test]
fn delegated_voting_uses_read_only_delegation_dep_and_revocation_is_separate() {
    let mut fixture = create_poll_fixture(40, 2, false);
    let epoch = fixture.epoch;
    let poll_type_hash = fixture.poll_type_hash;
    let delegator_lock = fixture.always_success.clone();
    let delegate_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xD2]))
        .expect("delegate always-success lock");
    let delegator_hash = script_hash(&delegator_lock);
    let delegate_hash = script_hash(&delegate_lock);
    let delegate_op = plain_cell(
        &mut fixture.context,
        delegate_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let delegation_type = delegate_script(
        &mut fixture.context,
        &fixture.governance_op,
        &poll_type_hash,
    );
    let delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash,
        expires_epoch: 0,
    };
    let delegation_op = governance_cell(
        &mut fixture.context,
        DELEGATION_MIN_SHANNONS,
        delegator_lock.clone(),
        delegation_type.clone(),
        encode_delegation(&delegation),
    );

    let delegated_vote = build_create_intent_tx(
        &mut fixture,
        delegate_op,
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(delegation_op.clone()),
    );
    verify_ok(&mut fixture.context, delegated_vote);

    let consumed_intent_type = vote_intent_script(
        &mut fixture.context,
        &fixture.governance_op,
        &poll_type_hash,
    );
    let consumed_intent = VoteIntentData {
        poll_type_hash,
        voter_lock_hash: delegator_hash,
        option_index: 0,
        voted_at_epoch: epoch,
        aggregated: false,
        refund_lock: encode_script(&delegator_lock),
    };
    let open_poll_dep = poll_dep_from_fixture(&mut fixture, false);
    let consumed_delegation_vote = tx_with_header(
        TransactionBuilder::default()
            .input(input(delegation_op.clone()))
            .output(output(
                VOTER_DEPOSIT_SHANNONS,
                consumed_intent_type.clone(),
                Some(consumed_intent_type),
            ))
            .output_data(encode_vote_intent(&consumed_intent).pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .cell_dep(cell_dep(open_poll_dep))
            .witness(witness_option(0).pack()),
        fixture.header_hash.clone(),
    )
    .build();
    assert_exit_code(
        &verify_err(&mut fixture.context, consumed_delegation_vote),
        5,
    );

    let revoke_tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(delegation_op))
            .output(output(
                DELEGATION_MIN_SHANNONS,
                delegator_lock.clone(),
                None,
            ))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();
    verify_ok(&mut fixture.context, revoke_tx);
}

#[test]
fn post_close_omitted_intent_refund_accepts_pending_and_aggregated_markers() {
    let mut fixture = create_poll_fixture(50, 2, true);
    let poll_type_hash = fixture.poll_type_hash;
    let closed_dep = poll_dep_from_fixture(&mut fixture, true);
    let refund_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&refund_lock);

    let (pending_op, _, _) = live_intent_cell(
        &mut fixture,
        poll_type_hash,
        voter_hash,
        0,
        false,
        refund_lock.clone(),
    );
    let pending_refund = refund_omitted_intent_tx(
        &mut fixture,
        pending_op,
        closed_dep.clone(),
        refund_lock.clone(),
    );
    verify_ok(&mut fixture.context, pending_refund);

    let (aggregated_op, _, _) = live_intent_cell(
        &mut fixture,
        poll_type_hash,
        voter_hash,
        1,
        true,
        refund_lock.clone(),
    );
    let aggregated_refund = refund_omitted_intent_tx(
        &mut fixture,
        aggregated_op,
        closed_dep.clone(),
        refund_lock.clone(),
    );
    verify_ok(&mut fixture.context, aggregated_refund);

    let (wrong_poll_op, _, _) = live_intent_cell(
        &mut fixture,
        [0xAB; 32],
        voter_hash,
        0,
        false,
        refund_lock.clone(),
    );
    let wrong_poll_refund =
        refund_omitted_intent_tx(&mut fixture, wrong_poll_op, closed_dep, refund_lock);
    assert_exit_code(&verify_err(&mut fixture.context, wrong_poll_refund), 5);
}

#[test]
fn same_index_bypass_rejects_close_lock_with_arbitrary_type_update() {
    let mut fixture = create_poll_fixture(300, 2, false);
    let input_lock = fixture.poll_lock.clone();
    let arbitrary_type = fixture.always_success.clone();
    let input_data = encode_poll(&fixture.open_poll);
    let tx = shadow_same_index_type_update_tx(&mut fixture, input_lock, arbitrary_type, input_data);

    let _ = verify_err(&mut fixture.context, tx);
}

#[test]
fn same_index_bypass_rejects_intent_lock_with_arbitrary_type_update() {
    let mut fixture = create_poll_fixture(301, 2, false);
    let poll_type_hash = fixture.poll_type_hash;
    let input_lock = vote_intent_script(
        &mut fixture.context,
        &fixture.governance_op,
        &poll_type_hash,
    );
    let intent = VoteIntentData {
        poll_type_hash,
        voter_lock_hash: script_hash(&fixture.always_success),
        option_index: 0,
        voted_at_epoch: fixture.epoch,
        aggregated: false,
        refund_lock: encode_script(&fixture.always_success),
    };
    let arbitrary_type = fixture.always_success.clone();
    let tx = shadow_same_index_type_update_tx(
        &mut fixture,
        input_lock,
        arbitrary_type,
        encode_vote_intent(&intent),
    );

    let _ = verify_err(&mut fixture.context, tx);
}

#[test]
fn same_index_bypass_rejects_shard_lock_with_arbitrary_or_wrong_governance_type_update() {
    let mut arbitrary = create_poll_fixture(302, 2, false);
    let input_lock = shard_script_for_fixture(&mut arbitrary, 0);
    let arbitrary_type = arbitrary.always_success.clone();
    let input_data = encode_tally_shard(&arbitrary.shard_data[0]);
    let tx =
        shadow_same_index_type_update_tx(&mut arbitrary, input_lock, arbitrary_type, input_data);
    let _ = verify_err(&mut arbitrary.context, tx);

    let mut wrong_op = create_poll_fixture(303, 2, false);
    let poll_type_hash = wrong_op.poll_type_hash;
    let input_lock = shard_script_for_fixture(&mut wrong_op, 0);
    let wrong_governance_type = vote_intent_script(
        &mut wrong_op.context,
        &wrong_op.governance_op,
        &poll_type_hash,
    );
    let input_data = encode_tally_shard(&wrong_op.shard_data[0]);
    let tx = shadow_same_index_type_update_tx(
        &mut wrong_op,
        input_lock,
        wrong_governance_type,
        input_data,
    );
    let _ = verify_err(&mut wrong_op.context, tx);
}

#[test]
fn same_index_bypass_rejects_merge_lock_with_arbitrary_or_wrong_governance_type_update() {
    let (mut arbitrary, _shards, _ops, result, _capacity) = merge_fixture(45, 9);
    let input_lock = merge_script_for_fixture(&mut arbitrary);
    let arbitrary_type = arbitrary.always_success.clone();
    let tx = shadow_same_index_type_update_tx(
        &mut arbitrary,
        input_lock,
        arbitrary_type,
        encode_tally_merge_result(&result),
    );
    let _ = verify_err(&mut arbitrary.context, tx);

    let (mut wrong_op, _shards, _ops, result, _capacity) = merge_fixture(46, 9);
    let poll_type_hash = wrong_op.poll_type_hash;
    let input_lock = merge_script_for_fixture(&mut wrong_op);
    let wrong_governance_type = tally_shard_script_from_parts(
        &mut wrong_op.context,
        &wrong_op.governance_op,
        &poll_type_hash,
        0,
    );
    let tx = shadow_same_index_type_update_tx(
        &mut wrong_op,
        input_lock,
        wrong_governance_type,
        encode_tally_merge_result(&result),
    );
    let _ = verify_err(&mut wrong_op.context, tx);
}

fn aggregation_fixture(
    seed: u8,
) -> (
    PollFixture,
    OutPoint,
    TallyShardData,
    TallyShardData,
    Vec<(OutPoint, VoteIntentData, Script, u64)>,
) {
    let mut fixture = create_poll_fixture(u64::from(seed) + 60, 4, false);
    let shard_id = 1;
    let poll_type_hash = fixture.poll_type_hash;
    let before_shard = fixture.shard_data[shard_id as usize].clone();
    let shard_op = fixture.shard_ops[shard_id as usize].clone();
    let (voter_lock, voter_hash) = voter_for_shard(&mut fixture, shard_id, seed);
    let (_, second_voter_hash) = voter_for_shard_excluding(
        &mut fixture,
        shard_id,
        seed.saturating_add(1),
        &[voter_hash],
    );
    let (intent_op, intent, intent_script) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_type_hash,
        poll_type_hash,
        voter_hash,
        0,
        false,
        voter_lock,
        VOTER_DEPOSIT_SHANNONS,
    );
    let refund_lock = fixture.always_success.clone();
    let (second_op, second_intent, second_script) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_type_hash,
        poll_type_hash,
        second_voter_hash,
        1,
        false,
        refund_lock,
        VOTER_DEPOSIT_SHANNONS,
    );
    let mut after_shard = before_shard.clone();
    after_shard.vote_counts = vec![1, 1];
    after_shard.total_voters = 2;
    after_shard.counted_voter_lock_hashes = vec![voter_hash, second_voter_hash];

    (
        fixture,
        shard_op,
        before_shard,
        after_shard,
        vec![
            (intent_op, intent, intent_script, VOTER_DEPOSIT_SHANNONS),
            (
                second_op,
                second_intent,
                second_script,
                VOTER_DEPOSIT_SHANNONS,
            ),
        ],
    )
}

#[test]
fn tally_shard_aggregation_happy_path_passes() {
    let (mut fixture, shard_op, before_shard, after_shard, intents) = aggregation_fixture(70);
    let tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before_shard,
        after_shard,
        intents,
        Vec::new(),
        None,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn tally_shard_aggregation_rejects_bad_intents_and_markers() {
    let (mut wrong_shard, shard_op, before, after, mut intents) = aggregation_fixture(80);
    let (_, wrong_hash) = voter_for_other_shard(&mut wrong_shard, before.shard_id, 120);
    let mut bad_intent = intents[0].1.clone();
    bad_intent.voter_lock_hash = wrong_hash;
    let poll_hash = wrong_shard.poll_type_hash;
    let rebuilt = intent_cell_from_data(
        &mut wrong_shard,
        bad_intent,
        poll_hash,
        VOTER_DEPOSIT_SHANNONS,
    );
    intents[0] = (rebuilt.0, rebuilt.1, rebuilt.2, VOTER_DEPOSIT_SHANNONS);
    let tx = build_tally_shard_aggregation_tx(
        &mut wrong_shard,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut wrong_shard.context, tx), 5);

    let (mut wrong_poll, shard_op, before, after, mut intents) = aggregation_fixture(81);
    let mut bad_intent = intents[0].1.clone();
    bad_intent.poll_type_hash = [0x44; 32];
    let poll_hash = wrong_poll.poll_type_hash;
    let rebuilt = intent_cell_from_data(
        &mut wrong_poll,
        bad_intent,
        poll_hash,
        VOTER_DEPOSIT_SHANNONS,
    );
    intents[0] = (rebuilt.0, rebuilt.1, rebuilt.2, VOTER_DEPOSIT_SHANNONS);
    let tx = build_tally_shard_aggregation_tx(
        &mut wrong_poll,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut wrong_poll.context, tx), 5);

    let (mut duplicate, shard_op, before, after, mut intents) = aggregation_fixture(82);
    let mut bad_intent = intents[1].1.clone();
    bad_intent.voter_lock_hash = intents[0].1.voter_lock_hash;
    let poll_hash = duplicate.poll_type_hash;
    let rebuilt = intent_cell_from_data(
        &mut duplicate,
        bad_intent,
        poll_hash,
        VOTER_DEPOSIT_SHANNONS,
    );
    intents[1] = (rebuilt.0, rebuilt.1, rebuilt.2, VOTER_DEPOSIT_SHANNONS);
    let tx = build_tally_shard_aggregation_tx(
        &mut duplicate,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut duplicate.context, tx), 5);

    let (mut already_counted, shard_op, mut before, mut after, intents) = aggregation_fixture(83);
    before.counted_voter_lock_hashes = vec![intents[0].1.voter_lock_hash];
    before.total_voters = 1;
    before.vote_counts = vec![1, 0];
    after
        .counted_voter_lock_hashes
        .insert(0, intents[0].1.voter_lock_hash);
    after.total_voters = 3;
    after.vote_counts = vec![2, 1];
    let tx = build_tally_shard_aggregation_tx(
        &mut already_counted,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut already_counted.context, tx), 5);

    let (mut bad_option, shard_op, before, after, mut intents) = aggregation_fixture(84);
    let mut bad_intent = intents[0].1.clone();
    bad_intent.option_index = 2;
    let poll_hash = bad_option.poll_type_hash;
    let rebuilt = intent_cell_from_data(
        &mut bad_option,
        bad_intent,
        poll_hash,
        VOTER_DEPOSIT_SHANNONS,
    );
    intents[0] = (rebuilt.0, rebuilt.1, rebuilt.2, VOTER_DEPOSIT_SHANNONS);
    let tx = build_tally_shard_aggregation_tx(
        &mut bad_option,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut bad_option.context, tx), 5);

    let (mut missing_marker, shard_op, before, after, intents) = aggregation_fixture(85);
    let mut marker_overrides = vec![None, None];
    let mut marker = intents[0].1.clone();
    marker.aggregated = true;
    marker_overrides[0] = Some((
        marker,
        missing_marker.always_success.clone(),
        intents[0].2.clone(),
        VOTER_DEPOSIT_SHANNONS,
    ));
    let tx = build_tally_shard_aggregation_tx(
        &mut missing_marker,
        shard_op,
        before,
        after,
        intents,
        marker_overrides,
        None,
    );
    assert_exit_code(&verify_err(&mut missing_marker.context, tx), 5);
}

#[test]
fn tally_shard_aggregation_rejects_deadline_finalized_and_mutated_shards() {
    let (mut after_deadline, shard_op, before, after, intents) = aggregation_fixture(90);
    let late_epoch = after_deadline.open_poll.deadline + 1;
    set_fixture_epoch(&mut after_deadline, late_epoch);
    let tx = build_tally_shard_aggregation_tx(
        &mut after_deadline,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut after_deadline.context, tx), 5);

    let (mut finalized, shard_op, mut before, mut after, intents) = aggregation_fixture(91);
    before.finalized = true;
    after.finalized = true;
    let tx = build_tally_shard_aggregation_tx(
        &mut finalized,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut finalized.context, tx), 5);

    let (mut mutated, shard_op, before, mut after, intents) = aggregation_fixture(92);
    after.shard_count += 1;
    let tx = build_tally_shard_aggregation_tx(
        &mut mutated,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut mutated.context, tx), 5);
}

#[test]
fn tally_shard_finalization_validates_deadline_and_immutables() {
    let mut fixture = create_poll_fixture(100, 3, false);
    let shard_op = fixture.shard_ops[0].clone();
    let before = fixture.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + 1);
    let valid = build_tally_shard_finalization_tx(
        &mut fixture,
        shard_op.clone(),
        before.clone(),
        after.clone(),
        None,
    );
    verify_ok(&mut fixture.context, valid);

    let mut early = create_poll_fixture(101, 3, false);
    let shard_op = early.shard_ops[0].clone();
    let before = early.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let early_tx = build_tally_shard_finalization_tx(&mut early, shard_op, before, after, None);
    assert_exit_code(&verify_err(&mut early.context, early_tx), 5);

    let mut mutated = create_poll_fixture(102, 3, false);
    let shard_op = mutated.shard_ops[0].clone();
    let before = mutated.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    after.vote_counts[0] = 1;
    let deadline = mutated.open_poll.deadline;
    set_fixture_epoch(&mut mutated, deadline + 1);
    let mutated_tx = build_tally_shard_finalization_tx(&mut mutated, shard_op, before, after, None);
    assert_exit_code(&verify_err(&mut mutated.context, mutated_tx), 5);

    let mut wrong_dep = create_poll_fixture(103, 3, false);
    let shard_op = wrong_dep.shard_ops[0].clone();
    let before = wrong_dep.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let deadline = wrong_dep.open_poll.deadline;
    set_fixture_epoch(&mut wrong_dep, deadline + 1);
    let mut poll = wrong_dep.open_poll.clone();
    poll.shard_count = 2;
    let dep = poll_dep_from_data(&mut wrong_dep, poll);
    let wrong_dep_tx =
        build_tally_shard_finalization_tx(&mut wrong_dep, shard_op, before, after, Some(dep));
    assert_exit_code(&verify_err(&mut wrong_dep.context, wrong_dep_tx), 5);
}

#[test]
fn direct_small_poll_close_uses_finalized_shards_and_refunds_exact_capacity() {
    let mut fixture = create_poll_fixture(120, 3, false);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + 1);
    let shards = vec![
        finalized_shard(&mut fixture, 0, vec![2, 0], 10),
        finalized_shard(&mut fixture, 1, vec![0, 1], 30),
        finalized_shard(&mut fixture, 2, vec![1, 1], 50),
    ];
    let capacities = vec![
        TALLY_SHARD_MIN_SHANNONS,
        TALLY_SHARD_MIN_SHANNONS + 123,
        TALLY_SHARD_MIN_SHANNONS + 456,
    ];
    let mut shard_inputs = Vec::new();
    for (shard, capacity) in shards.iter().zip(capacities.iter()) {
        let (op, _) = shard_cell_with_capacity(&mut fixture, shard, *capacity);
        shard_inputs.push((op, *capacity));
    }
    let mut before_poll = fixture.open_poll.clone();
    before_poll.vote_counts = vec![9, 9];
    before_poll.total_voters = 18;
    before_poll.pending_intent_count = 1;
    let after_poll = closed_poll_from_result(
        &before_poll,
        summed_vote_counts(&shards),
        summed_total_voters(&shards),
    );
    let refund_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&refund_lock);
    let poll_hash = fixture.poll_type_hash;
    let (pending_op, pending, _) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_hash,
        poll_hash,
        voter_hash,
        0,
        false,
        refund_lock.clone(),
        VOTER_DEPOSIT_SHANNONS + 777,
    );
    let (aggregated_op, aggregated, _) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_hash,
        poll_hash,
        voter_hash,
        1,
        true,
        refund_lock.clone(),
        VOTER_DEPOSIT_SHANNONS + 888,
    );
    let tx = close_poll_with_inputs_tx(
        &mut fixture,
        before_poll,
        after_poll,
        true,
        shard_inputs,
        Vec::new(),
        vec![
            (
                pending_op,
                pending,
                refund_lock.clone(),
                VOTER_DEPOSIT_SHANNONS + 777,
            ),
            (
                aggregated_op,
                aggregated,
                refund_lock,
                VOTER_DEPOSIT_SHANNONS + 888,
            ),
        ],
        CREATOR_DEPOSIT_SHANNONS,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn direct_small_poll_close_rejects_bad_shard_sets_and_auth() {
    let mut unfinalized = create_poll_fixture(130, 2, false);
    let deadline = unfinalized.open_poll.deadline;
    set_fixture_epoch(&mut unfinalized, deadline + 1);
    let shards = vec![
        unfinalized.shard_data[0].clone(),
        finalized_shard(&mut unfinalized, 1, vec![0, 1], 20),
    ];
    let mut inputs = Vec::new();
    for shard in &shards {
        let (op, _) = shard_cell_with_capacity(&mut unfinalized, shard, TALLY_SHARD_MIN_SHANNONS);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = unfinalized.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![0, 1], 1);
    let tx = close_poll_with_inputs_tx(
        &mut unfinalized,
        before,
        after,
        true,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut unfinalized.context, tx), 5);

    let mut missing = create_poll_fixture(131, 2, false);
    let deadline = missing.open_poll.deadline;
    set_fixture_epoch(&mut missing, deadline + 1);
    let shard = finalized_shard(&mut missing, 0, vec![1, 0], 30);
    let (op, _) = shard_cell_with_capacity(&mut missing, &shard, TALLY_SHARD_MIN_SHANNONS);
    let before = missing.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 0], 1);
    let tx = close_poll_with_inputs_tx(
        &mut missing,
        before,
        after,
        true,
        vec![(op, TALLY_SHARD_MIN_SHANNONS)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut missing.context, tx), 5);

    let mut duplicate = create_poll_fixture(132, 2, false);
    let deadline = duplicate.open_poll.deadline;
    set_fixture_epoch(&mut duplicate, deadline + 1);
    let shard0 = finalized_shard(&mut duplicate, 0, vec![1, 0], 40);
    let shard0_again = finalized_shard(&mut duplicate, 0, vec![0, 1], 50);
    let (op0, _) = shard_cell_with_capacity(&mut duplicate, &shard0, TALLY_SHARD_MIN_SHANNONS);
    let (op1, _) =
        shard_cell_with_capacity(&mut duplicate, &shard0_again, TALLY_SHARD_MIN_SHANNONS);
    let before = duplicate.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 1], 2);
    let tx = close_poll_with_inputs_tx(
        &mut duplicate,
        before,
        after,
        true,
        vec![
            (op0, TALLY_SHARD_MIN_SHANNONS),
            (op1, TALLY_SHARD_MIN_SHANNONS),
        ],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut duplicate.context, tx), 5);

    let mut wrong_poll = create_poll_fixture(133, 2, false);
    let deadline = wrong_poll.open_poll.deadline;
    set_fixture_epoch(&mut wrong_poll, deadline + 1);
    let mut shard0 = finalized_shard(&mut wrong_poll, 0, vec![1, 0], 60);
    shard0.poll_type_hash = [0x77; 32];
    let shard1 = finalized_shard(&mut wrong_poll, 1, vec![0, 1], 70);
    let (op0, _) = shard_cell_with_capacity(&mut wrong_poll, &shard0, TALLY_SHARD_MIN_SHANNONS);
    let (op1, _) = shard_cell_with_capacity(&mut wrong_poll, &shard1, TALLY_SHARD_MIN_SHANNONS);
    let before = wrong_poll.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 1], 2);
    let tx = close_poll_with_inputs_tx(
        &mut wrong_poll,
        before,
        after,
        true,
        vec![
            (op0, TALLY_SHARD_MIN_SHANNONS),
            (op1, TALLY_SHARD_MIN_SHANNONS),
        ],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut wrong_poll.context, tx), 5);

    let mut no_auth = create_poll_fixture(134, 2, false);
    let deadline = no_auth.open_poll.deadline;
    set_fixture_epoch(&mut no_auth, deadline + 1);
    let shards = vec![
        finalized_shard(&mut no_auth, 0, vec![1, 0], 80),
        finalized_shard(&mut no_auth, 1, vec![0, 1], 90),
    ];
    let mut inputs = Vec::new();
    for shard in &shards {
        let (op, _) = shard_cell_with_capacity(&mut no_auth, shard, TALLY_SHARD_MIN_SHANNONS);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = no_auth.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 1], 2);
    let tx = close_poll_with_inputs_tx(
        &mut no_auth,
        before,
        after,
        false,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut no_auth.context, tx), 5);
}

#[test]
fn direct_small_poll_close_rejects_extra_tally_inputs_and_large_poll_direct_close() {
    let mut extra = create_poll_fixture(140, 2, false);
    let deadline = extra.open_poll.deadline;
    set_fixture_epoch(&mut extra, deadline + 1);
    let shards = vec![
        finalized_shard(&mut extra, 0, vec![1, 0], 10),
        finalized_shard(&mut extra, 1, vec![0, 1], 20),
        finalized_shard(&mut extra, 1, vec![0, 1], 30),
    ];
    let mut inputs = Vec::new();
    for shard in &shards {
        let (op, _) = shard_cell_with_capacity(&mut extra, shard, TALLY_SHARD_MIN_SHANNONS);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = extra.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 1], 2);
    let tx = close_poll_with_inputs_tx(
        &mut extra,
        before,
        after,
        true,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut extra.context, tx), 5);

    let mut large = create_poll_fixture(141, MAX_DIRECT_CLOSE_SHARDS + 1, false);
    let deadline = large.open_poll.deadline;
    set_fixture_epoch(&mut large, deadline + 1);
    let mut shards = Vec::new();
    let mut inputs = Vec::new();
    for shard_id in 0..large.open_poll.shard_count {
        let shard = finalized_shard(&mut large, shard_id, vec![0, 0], shard_id as u8);
        let (op, _) = shard_cell_with_capacity(&mut large, &shard, TALLY_SHARD_MIN_SHANNONS);
        shards.push(shard);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = large.open_poll.clone();
    let after = closed_poll_from_result(&before, summed_vote_counts(&shards), 0);
    let tx = close_poll_with_inputs_tx(
        &mut large,
        before,
        after,
        true,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut large.context, tx), 4);
}

#[test]
fn non_creator_force_close_after_grace_passes_with_direct_shards() {
    let mut fixture = create_poll_fixture(145, 2, false);
    let force_epoch = fixture.open_poll.deadline + FORCE_CLOSE_GRACE_EPOCHS + 1;
    set_fixture_epoch(&mut fixture, force_epoch);
    let shards = vec![
        finalized_shard(&mut fixture, 0, vec![1, 0], 10),
        finalized_shard(&mut fixture, 1, vec![0, 1], 20),
    ];
    let mut inputs = Vec::new();
    for shard in &shards {
        let (op, _) = shard_cell_with_capacity(&mut fixture, shard, TALLY_SHARD_MIN_SHANNONS);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = fixture.open_poll.clone();
    let after = closed_poll_from_result(&before, vec![1, 1], 2);
    let tx = close_poll_with_inputs_tx(
        &mut fixture,
        before,
        after,
        false,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );

    verify_ok(&mut fixture.context, tx);
}

fn merge_fixture(
    seed: u8,
    shard_count: u32,
) -> (
    PollFixture,
    Vec<TallyShardData>,
    Vec<OutPoint>,
    TallyMergeResultData,
    u64,
) {
    let mut fixture = create_poll_fixture(u64::from(seed) + 160, shard_count, false);
    let mut shards = Vec::new();
    let mut ops = Vec::new();
    let mut total_capacity = 0u64;
    for shard_id in 0..core::cmp::min(MAX_SHARDS_PER_MERGE as u32, shard_count) {
        let shard = finalized_shard(
            &mut fixture,
            shard_id,
            vec![u64::from(shard_id + 1), u64::from(shard_id % 2)],
            seed.saturating_add(shard_id as u8),
        );
        let capacity = TALLY_SHARD_MIN_SHANNONS + u64::from(shard_id);
        let (op, _) = shard_cell_with_capacity(&mut fixture, &shard, capacity);
        shards.push(shard);
        ops.push(op);
        total_capacity += capacity;
    }
    let result = merge_result_for_shards(fixture.poll_type_hash, &shards, 1);
    (fixture, shards, ops, result, total_capacity)
}

#[test]
fn merge_tally_shards_happy_path_passes() {
    let (mut fixture, _, ops, result, total_capacity) = merge_fixture(10, 9);
    let tx = build_merge_tx(
        &mut fixture,
        ops,
        result,
        total_capacity,
        None,
        None,
        None,
        false,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn merge_tally_shards_rejects_bad_shard_inputs_and_overlap() {
    let (mut unfinalized, mut shards, _ops, result, total_capacity) = merge_fixture(20, 9);
    shards[0].finalized = false;
    let (bad_op, _) =
        shard_cell_with_capacity(&mut unfinalized, &shards[0], TALLY_SHARD_MIN_SHANNONS);
    let tx = build_merge_tx(
        &mut unfinalized,
        vec![bad_op],
        result.clone(),
        total_capacity,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut unfinalized.context, tx), 5);

    let (mut wrong_poll, mut shards, _ops, result, total_capacity) = merge_fixture(21, 9);
    shards[0].poll_type_hash = [0x66; 32];
    let (bad_op, _) =
        shard_cell_with_capacity(&mut wrong_poll, &shards[0], TALLY_SHARD_MIN_SHANNONS);
    let tx = build_merge_tx(
        &mut wrong_poll,
        vec![bad_op],
        result.clone(),
        total_capacity,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut wrong_poll.context, tx), 5);

    let (mut duplicate, shards, _ops, _result, _total_capacity) = merge_fixture(22, 9);
    let (op0, _) = shard_cell_with_capacity(&mut duplicate, &shards[0], TALLY_SHARD_MIN_SHANNONS);
    let mut duplicate_shard = shards[0].clone();
    duplicate_shard.vote_counts = vec![0, 1];
    duplicate_shard.total_voters = 1;
    duplicate_shard.counted_voter_lock_hashes.truncate(1);
    let (op1, _) =
        shard_cell_with_capacity(&mut duplicate, &duplicate_shard, TALLY_SHARD_MIN_SHANNONS);
    let result = merge_result_for_shards(duplicate.poll_type_hash, &[shards[0].clone()], 1);
    let tx = build_merge_tx(
        &mut duplicate,
        vec![op0, op1],
        result,
        TALLY_SHARD_MIN_SHANNONS * 2,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut duplicate.context, tx), 5);
}

#[test]
fn merge_tally_shards_rejects_wrong_result_shape_and_scripts() {
    let (mut wrong_totals, _, ops, mut result, total_capacity) = merge_fixture(30, 9);
    result.vote_counts[0] += 1;
    let tx = build_merge_tx(
        &mut wrong_totals,
        ops,
        result,
        total_capacity,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut wrong_totals.context, tx), 5);

    let (mut wrong_coverage, _, ops, mut result, total_capacity) = merge_fixture(31, 9);
    result.coverage[0] ^= 0b0000_0001;
    let tx = build_merge_tx(
        &mut wrong_coverage,
        ops,
        result,
        total_capacity,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut wrong_coverage.context, tx), 5);

    let (mut wrong_lock, _, ops, result, total_capacity) = merge_fixture(32, 9);
    let bad_lock = wrong_lock
        .context
        .build_script(&wrong_lock.always_success_op, Bytes::from(vec![0xB1]))
        .expect("wrong return lock");
    let tx = build_merge_tx(
        &mut wrong_lock,
        ops,
        result,
        total_capacity,
        Some(bad_lock),
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut wrong_lock.context, tx), 5);

    let (mut wrong_type, _, ops, result, total_capacity) = merge_fixture(33, 9);
    let bad_type = vote_intent_script(
        &mut wrong_type.context,
        &wrong_type.governance_op,
        &wrong_type.poll_type_hash,
    );
    let tx = build_merge_tx(
        &mut wrong_type,
        ops,
        result,
        total_capacity,
        None,
        Some(bad_type),
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut wrong_type.context, tx), 5);

    let (mut extra_output, _, ops, result, total_capacity) = merge_fixture(34, 9);
    let tx = build_merge_tx(
        &mut extra_output,
        ops,
        result,
        total_capacity,
        None,
        None,
        None,
        true,
    );
    assert_exit_code(&verify_err(&mut extra_output.context, tx), 5);
}

#[test]
fn merge_tally_shards_rejects_more_than_max_inputs() {
    let mut fixture = create_poll_fixture(200, 9, false);
    let mut shards = Vec::new();
    let mut ops = Vec::new();
    for shard_id in 0..9 {
        let shard = finalized_shard(&mut fixture, shard_id, vec![0, 0], shard_id as u8);
        let (op, _) = shard_cell_with_capacity(&mut fixture, &shard, TALLY_SHARD_MIN_SHANNONS);
        shards.push(shard);
        ops.push(op);
    }
    let result = merge_result_for_shards(fixture.poll_type_hash, &shards, 1);
    let tx = build_merge_tx(
        &mut fixture,
        ops,
        result,
        TALLY_SHARD_MIN_SHANNONS * 9,
        None,
        None,
        None,
        false,
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

fn large_close_fixture(
    seed: u8,
) -> (
    PollFixture,
    Vec<TallyShardData>,
    TallyMergeResultData,
    OutPoint,
    u64,
) {
    let mut fixture =
        create_poll_fixture(u64::from(seed) + 220, MAX_DIRECT_CLOSE_SHARDS + 1, false);
    let mut shards = Vec::new();
    for shard_id in 0..fixture.open_poll.shard_count {
        shards.push(finalized_shard(
            &mut fixture,
            shard_id,
            vec![u64::from(shard_id % 3), u64::from((shard_id + 1) % 2)],
            seed.saturating_add(shard_id as u8),
        ));
    }
    let result = merge_result_for_shards(fixture.poll_type_hash, &shards, 2);
    let capacity = TALLY_MERGE_RESULT_MIN_SHANNONS + 9_999;
    let (op, _) = merge_cell_with_capacity(&mut fixture, &result, capacity);
    (fixture, shards, result, op, capacity)
}

#[test]
fn large_poll_close_from_complete_merge_result_passes() {
    let (mut fixture, _shards, result, result_op, result_capacity) = large_close_fixture(10);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + 1);
    let before = fixture.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let tx = close_poll_with_inputs_tx(
        &mut fixture,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn large_poll_close_rejects_incomplete_wrong_poll_wrong_totals_and_extra_inputs() {
    let (mut incomplete, _shards, mut result, _result_op, result_capacity) =
        large_close_fixture(20);
    result.coverage[0] &= !0b0000_0001;
    let (result_op, _) = merge_cell_with_capacity(&mut incomplete, &result, result_capacity);
    let deadline = incomplete.open_poll.deadline;
    set_fixture_epoch(&mut incomplete, deadline + 1);
    let before = incomplete.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let tx = close_poll_with_inputs_tx(
        &mut incomplete,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut incomplete.context, tx), 5);

    let (mut wrong_poll, _shards, mut result, _result_op, result_capacity) =
        large_close_fixture(21);
    result.poll_type_hash = [0x99; 32];
    let (result_op, _) = merge_cell_with_capacity(&mut wrong_poll, &result, result_capacity);
    let deadline = wrong_poll.open_poll.deadline;
    set_fixture_epoch(&mut wrong_poll, deadline + 1);
    let before = wrong_poll.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let tx = close_poll_with_inputs_tx(
        &mut wrong_poll,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut wrong_poll.context, tx), 5);

    let (mut wrong_totals, _shards, result, result_op, result_capacity) = large_close_fixture(22);
    let deadline = wrong_totals.open_poll.deadline;
    set_fixture_epoch(&mut wrong_totals, deadline + 1);
    let before = wrong_totals.open_poll.clone();
    let after = closed_poll_from_result(
        &before,
        vec![result.vote_counts[0] + 1, result.vote_counts[1]],
        result.total_voters,
    );
    let tx = close_poll_with_inputs_tx(
        &mut wrong_totals,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut wrong_totals.context, tx), 5);

    let (mut extra, shards, result, result_op, result_capacity) = large_close_fixture(23);
    let (extra_shard_op, _) =
        shard_cell_with_capacity(&mut extra, &shards[0], TALLY_SHARD_MIN_SHANNONS);
    let deadline = extra.open_poll.deadline;
    set_fixture_epoch(&mut extra, deadline + 1);
    let before = extra.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let tx = close_poll_with_inputs_tx(
        &mut extra,
        before,
        after,
        true,
        vec![
            (result_op, result_capacity),
            (extra_shard_op, TALLY_SHARD_MIN_SHANNONS),
        ],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut extra.context, tx), 5);
}

#[test]
fn large_poll_close_enforces_merge_capacity_and_return_lock() {
    let (mut underpaid, _shards, result, result_op, result_capacity) = large_close_fixture(30);
    let deadline = underpaid.open_poll.deadline;
    set_fixture_epoch(&mut underpaid, deadline + 1);
    let before = underpaid.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let tx = close_poll_with_return_overrides_tx(
        &mut underpaid,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        Vec::new(),
        vec![result_capacity - 1],
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut underpaid.context, tx), 5);

    let (mut wrong_lock, _shards, result, result_op, result_capacity) = large_close_fixture(31);
    let deadline = wrong_lock.open_poll.deadline;
    set_fixture_epoch(&mut wrong_lock, deadline + 1);
    let before = wrong_lock.open_poll.clone();
    let after = closed_poll_from_result(&before, result.vote_counts.clone(), result.total_voters);
    let bad_lock = wrong_lock
        .context
        .build_script(&wrong_lock.always_success_op, Bytes::from(vec![0xB1]))
        .expect("wrong return lock");
    let tx = close_poll_with_return_overrides_tx(
        &mut wrong_lock,
        before,
        after,
        true,
        vec![(result_op, result_capacity)],
        vec![bad_lock],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut wrong_lock.context, tx), 5);
}

fn create_poll_tx_with_output_data(
    fixture: &mut Fixture,
    data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let seed_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let seed_input = input(seed_op);
    let type_id = calc_type_id(&seed_input, 0);
    let poll_type = create_poll_script(fixture, &type_id);
    let poll_type_hash = script_hash(&poll_type);
    let poll_lock = close_poll_script(fixture, &poll_type_hash);
    tx_with_header(
        TransactionBuilder::default()
            .input(seed_input)
            .output(output(POLL_CELL_SHANNONS, poll_lock, Some(poll_type)))
            .output_data(data.pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

fn create_intent_tx_with_output_data(
    fixture: &mut PollFixture,
    data: Bytes,
    option_index: u8,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let voter_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let intent_type = vote_intent_script(
        &mut fixture.context,
        &fixture.governance_op,
        &fixture.poll_type_hash,
    );
    tx_with_header(
        TransactionBuilder::default()
            .input(input(voter_op))
            .output(output(
                VOTER_DEPOSIT_SHANNONS,
                intent_type.clone(),
                Some(intent_type),
            ))
            .output_data(data.pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .cell_dep(cell_dep(poll_dep_from_fixture(fixture, false)))
            .witness(witness_option(option_index).pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

fn create_delegation_tx_with_output_data(
    fixture: &mut PollFixture,
    data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let delegator_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let delegation_type = delegate_script(
        &mut fixture.context,
        &fixture.governance_op,
        &fixture.poll_type_hash,
    );
    tx_with_header(
        TransactionBuilder::default()
            .input(input(delegator_op))
            .output(output(
                DELEGATION_MIN_SHANNONS,
                fixture.always_success.clone(),
                Some(delegation_type),
            ))
            .output_data(data.pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

fn merge_tx_with_output_data(
    fixture: &mut PollFixture,
    shard: TallyShardData,
    result: TallyMergeResultData,
    output_data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let (op, _) = shard_cell_with_capacity(fixture, &shard, TALLY_SHARD_MIN_SHANNONS);
    build_merge_tx(
        fixture,
        vec![op],
        result,
        TALLY_SHARD_MIN_SHANNONS,
        None,
        None,
        Some(output_data),
        false,
    )
}

#[test]
fn codec_canonicality_rejects_trailing_bytes_in_vm() {
    let mut poll_fixture = fixture(260);
    let poll_tx = create_poll_tx(&mut poll_fixture, 1, None, false, false);
    verify_ok(&mut poll_fixture.context, poll_tx);

    let mut bad_poll = fixture(261);
    let mut sample_poll = create_poll_fixture(261, 1, false).open_poll;
    sample_poll.creator = script_hash(&bad_poll.always_success);
    sample_poll.creator_lock = encode_script(&bad_poll.always_success);
    let tx = create_poll_tx_with_output_data(
        &mut bad_poll,
        with_trailing_byte(encode_poll(&sample_poll)),
    );
    assert_exit_code(&verify_err(&mut bad_poll.context, tx), 4);

    let mut bad_intent = create_poll_fixture(262, 2, false);
    let voter_hash = script_hash(&bad_intent.always_success);
    let intent = VoteIntentData {
        poll_type_hash: bad_intent.poll_type_hash,
        voter_lock_hash: voter_hash,
        option_index: 0,
        voted_at_epoch: bad_intent.epoch,
        aggregated: false,
        refund_lock: encode_script(&bad_intent.always_success),
    };
    let tx = create_intent_tx_with_output_data(
        &mut bad_intent,
        with_trailing_byte(encode_vote_intent(&intent)),
        0,
    );
    assert_exit_code(&verify_err(&mut bad_intent.context, tx), 4);

    let mut bad_delegation = create_poll_fixture(263, 2, false);
    let delegation = DelegationData {
        delegator_lock_hash: script_hash(&bad_delegation.always_success),
        delegate_lock_hash: [0x11; 32],
        poll_type_hash: bad_delegation.poll_type_hash,
        expires_epoch: 0,
    };
    let tx = create_delegation_tx_with_output_data(
        &mut bad_delegation,
        with_trailing_byte(encode_delegation(&delegation)),
    );
    assert_exit_code(&verify_err(&mut bad_delegation.context, tx), 4);

    let mut bad_shard = create_poll_fixture(264, 2, false);
    let shard_op = bad_shard.shard_ops[0].clone();
    let before = bad_shard.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let deadline = bad_shard.open_poll.deadline;
    set_fixture_epoch(&mut bad_shard, deadline + 1);
    let shard_script = shard_script_for_fixture(&mut bad_shard, before.shard_id);
    let tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(shard_op))
            .output(output(
                TALLY_SHARD_MIN_SHANNONS,
                shard_script.clone(),
                Some(shard_script),
            ))
            .output_data(with_trailing_byte(encode_tally_shard(&after)).pack())
            .cell_dep(cell_dep(bad_shard.governance_op.clone()))
            .cell_dep(cell_dep(bad_shard.always_success_op.clone()))
            .cell_dep(cell_dep(poll_dep_from_fixture(&mut bad_shard, false)))
            .witness(blank_witness().pack()),
        bad_shard.header_hash.clone(),
    )
    .build();
    assert_exit_code(&verify_err(&mut bad_shard.context, tx), 4);

    let (mut bad_merge, shards, _ops, result, _capacity) = merge_fixture(40, 9);
    let output_data = with_trailing_byte(encode_tally_merge_result(&result));
    let tx = merge_tx_with_output_data(&mut bad_merge, shards[0].clone(), result, output_data);
    assert_exit_code(&verify_err(&mut bad_merge.context, tx), 4);
}

#[test]
fn codec_canonicality_rejects_invalid_bool_bytes_in_vm() {
    let mut bad_poll = fixture(270);
    let mut sample_poll = create_poll_fixture(270, 1, false).open_poll;
    sample_poll.creator = script_hash(&bad_poll.always_success);
    sample_poll.creator_lock = encode_script(&bad_poll.always_success);
    let poll_offset = poll_is_closed_offset(&sample_poll);
    let tx = create_poll_tx_with_output_data(
        &mut bad_poll,
        mutate_byte(encode_poll(&sample_poll), poll_offset, 2),
    );
    assert_exit_code(&verify_err(&mut bad_poll.context, tx), 4);

    let mut bad_intent = create_poll_fixture(271, 2, false);
    let intent = VoteIntentData {
        poll_type_hash: bad_intent.poll_type_hash,
        voter_lock_hash: script_hash(&bad_intent.always_success),
        option_index: 0,
        voted_at_epoch: bad_intent.epoch,
        aggregated: false,
        refund_lock: encode_script(&bad_intent.always_success),
    };
    let tx = create_intent_tx_with_output_data(
        &mut bad_intent,
        mutate_byte(
            encode_vote_intent(&intent),
            vote_intent_aggregated_offset(),
            2,
        ),
        0,
    );
    assert_exit_code(&verify_err(&mut bad_intent.context, tx), 4);

    let mut bad_shard = create_poll_fixture(272, 2, false);
    let shard_op = bad_shard.shard_ops[0].clone();
    let before = bad_shard.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let deadline = bad_shard.open_poll.deadline;
    set_fixture_epoch(&mut bad_shard, deadline + 1);
    let offset = shard_finalized_offset(&after);
    let shard_script = shard_script_for_fixture(&mut bad_shard, before.shard_id);
    let tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(shard_op))
            .output(output(
                TALLY_SHARD_MIN_SHANNONS,
                shard_script.clone(),
                Some(shard_script),
            ))
            .output_data(mutate_byte(encode_tally_shard(&after), offset, 2).pack())
            .cell_dep(cell_dep(bad_shard.governance_op.clone()))
            .cell_dep(cell_dep(bad_shard.always_success_op.clone()))
            .cell_dep(cell_dep(poll_dep_from_fixture(&mut bad_shard, false)))
            .witness(blank_witness().pack()),
        bad_shard.header_hash.clone(),
    )
    .build();
    assert_exit_code(&verify_err(&mut bad_shard.context, tx), 4);

    let mut bad_poll_token_flag = fixture(273);
    let mut sample_poll = create_poll_fixture(273, 1, false).open_poll;
    sample_poll.creator = script_hash(&bad_poll_token_flag.always_success);
    sample_poll.creator_lock = encode_script(&bad_poll_token_flag.always_success);
    let token_offset = poll_token_weighted_offset(&sample_poll);
    let tx = create_poll_tx_with_output_data(
        &mut bad_poll_token_flag,
        mutate_byte(encode_poll(&sample_poll), token_offset, 2),
    );
    assert_exit_code(&verify_err(&mut bad_poll_token_flag.context, tx), 4);
}

fn delegation_cell(
    fixture: &mut PollFixture,
    delegator_lock: Script,
    delegation: DelegationData,
    capacity: u64,
) -> OutPoint {
    let delegation_type = delegate_script(
        &mut fixture.context,
        &fixture.governance_op,
        &delegation.poll_type_hash,
    );
    governance_cell(
        &mut fixture.context,
        capacity,
        delegator_lock,
        delegation_type,
        encode_delegation(&delegation),
    )
}

#[test]
fn delegated_vote_requires_matching_live_delegation_dep() {
    let mut fixture = create_poll_fixture(280, 2, false);
    let epoch = fixture.epoch;
    let poll_type_hash = fixture.poll_type_hash;
    let delegator_lock = fixture.always_success.clone();
    let delegate_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xDA]))
        .expect("delegate lock");
    let delegator_hash = script_hash(&delegator_lock);
    let delegate_hash = script_hash(&delegate_lock);
    let delegate_op = plain_cell(
        &mut fixture.context,
        delegate_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash,
        expires_epoch: epoch + 5,
    };
    let delegation_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        delegation,
        DELEGATION_MIN_SHANNONS,
    );

    let valid = build_create_intent_tx(
        &mut fixture,
        delegate_op.clone(),
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(delegation_op),
    );
    verify_ok(&mut fixture.context, valid);

    let without_dep = build_create_intent_tx(
        &mut fixture,
        delegate_op.clone(),
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, without_dep), 5);

    let expired_delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash,
        expires_epoch: epoch - 1,
    };
    let expired_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        expired_delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let expired = build_create_intent_tx(
        &mut fixture,
        delegate_op.clone(),
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(expired_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, expired), 5);

    let wrong_delegate_delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: [0x55; 32],
        poll_type_hash,
        expires_epoch: 0,
    };
    let wrong_delegate_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        wrong_delegate_delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let wrong_delegate = build_create_intent_tx(
        &mut fixture,
        delegate_op.clone(),
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(wrong_delegate_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, wrong_delegate), 5);

    let wrong_scope_delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash: [0xAA; 32],
        expires_epoch: 0,
    };
    let wrong_scope_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        wrong_scope_delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let wrong_scope = build_create_intent_tx(
        &mut fixture,
        delegate_op,
        delegate_lock,
        delegator_hash,
        delegator_lock,
        0,
        epoch,
        None,
        None,
        Some(wrong_scope_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, wrong_scope), 5);
}

#[test]
fn revoke_delegation_preserves_lock_and_capacity() {
    let mut fixture = create_poll_fixture(285, 2, false);
    let delegator_lock = fixture.always_success.clone();
    let delegate_hash = [0x22; 32];
    let delegation = DelegationData {
        delegator_lock_hash: script_hash(&delegator_lock),
        delegate_lock_hash: delegate_hash,
        poll_type_hash: fixture.poll_type_hash,
        expires_epoch: 0,
    };
    let delegation_capacity = DELEGATION_MIN_SHANNONS + 44;
    let delegation_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        delegation,
        delegation_capacity,
    );

    let valid = tx_with_header(
        TransactionBuilder::default()
            .input(input(delegation_op.clone()))
            .output(output(delegation_capacity, delegator_lock.clone(), None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();
    verify_ok(&mut fixture.context, valid);

    let wrong_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xEF]))
        .expect("wrong lock");
    let wrong_lock_tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(delegation_op.clone()))
            .output(output(delegation_capacity, wrong_lock, None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();
    assert_exit_code(&verify_err(&mut fixture.context, wrong_lock_tx), 5);

    let underpaid_tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(delegation_op))
            .output(output(delegation_capacity - 1, delegator_lock, None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();
    assert_exit_code(&verify_err(&mut fixture.context, underpaid_tx), 5);
}

fn legacy_poll_fixture(epoch: u64) -> PollFixture {
    let mut fixture = create_poll_fixture(epoch, 1, false);
    fixture.open_poll.shard_count = 0;
    fixture.open_poll.vote_counts = vec![0, 0];
    fixture.open_poll.total_voters = 0;
    fixture.open_poll.counted_voter_lock_hashes.clear();
    fixture.poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&fixture.open_poll),
    );
    fixture.shard_ops.clear();
    fixture.shard_data.clear();
    fixture
}

fn aggregate_votes_tx(
    fixture: &mut PollFixture,
    before_poll: PollData,
    after_poll: PollData,
    intent_op: OutPoint,
    before_intent: VoteIntentData,
    capacity: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&before_poll),
    );
    let mut marker = before_intent.clone();
    marker.aggregated = true;
    let intent_type = vote_intent_script(
        &mut fixture.context,
        &fixture.governance_op,
        &fixture.poll_type_hash,
    );

    tx_with_header(
        TransactionBuilder::default()
            .input(input(poll_op))
            .input(input(intent_op))
            .output(output(
                POLL_CELL_SHANNONS,
                fixture.poll_lock.clone(),
                Some(fixture.poll_type.clone()),
            ))
            .output_data(encode_poll(&after_poll).pack())
            .output(output(capacity, intent_type.clone(), Some(intent_type)))
            .output_data(encode_vote_intent(&marker).pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack())
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build()
}

#[test]
fn legacy_aggregate_votes_rejected_for_sharded_polls_and_allowed_for_historical_non_sharded() {
    let mut sharded = create_poll_fixture(290, 2, false);
    let voter_hash = script_hash(&sharded.always_success);
    let poll_hash = sharded.poll_type_hash;
    let refund_lock = sharded.always_success.clone();
    let (intent_op, intent, _) = live_intent_cell_with_capacity(
        &mut sharded,
        poll_hash,
        poll_hash,
        voter_hash,
        0,
        false,
        refund_lock,
        VOTER_DEPOSIT_SHANNONS,
    );
    let before = sharded.open_poll.clone();
    let mut after = before.clone();
    after.vote_counts = vec![1, 0];
    after.total_voters = 1;
    after.counted_voter_lock_hashes = vec![voter_hash];
    let sharded_tx = aggregate_votes_tx(
        &mut sharded,
        before,
        after,
        intent_op,
        intent,
        VOTER_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut sharded.context, sharded_tx), 5);

    let mut legacy = legacy_poll_fixture(291);
    let voter_hash = script_hash(&legacy.always_success);
    let poll_hash = legacy.poll_type_hash;
    let refund_lock = legacy.always_success.clone();
    let (intent_op, intent, _) = live_intent_cell_with_capacity(
        &mut legacy,
        poll_hash,
        poll_hash,
        voter_hash,
        1,
        false,
        refund_lock,
        VOTER_DEPOSIT_SHANNONS,
    );
    let mut before = legacy.open_poll.clone();
    before.shard_count = 0;
    let mut after = before.clone();
    after.vote_counts = vec![0, 1];
    after.total_voters = 1;
    after.counted_voter_lock_hashes = vec![voter_hash];
    let legacy_tx = aggregate_votes_tx(
        &mut legacy,
        before,
        after,
        intent_op,
        intent,
        VOTER_DEPOSIT_SHANNONS,
    );
    verify_ok(&mut legacy.context, legacy_tx);
}
