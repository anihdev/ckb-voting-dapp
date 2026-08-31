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
use sparse_merkle_tree::{
    blake2b::{Blake2b, Blake2bBuilder},
    default_store::DefaultStore,
    traits::Hasher,
    SparseMerkleTree, H256,
};

const MAX_CYCLES: u64 = 100_000_000;
const MAX_AGGREGATION_CYCLES: u64 = 50_000_000;
const MAX_ACTIVE_TALLY_SHARDS: u32 = 16;
const MAX_SHARDS_PER_FINALIZE: usize = 16;

const OP_CREATE_POLL: u8 = 0x01;
const OP_CREATE_VOTE_INTENT: u8 = 0x02;
const OP_RETIRED_AGGREGATE_VOTES: u8 = 0x03;
const OP_CLOSE_POLL: u8 = 0x04;
const OP_DELEGATE: u8 = 0x05;
const OP_RETIRED_REVOKE_DELEGATION: u8 = 0x06;
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
const FINALIZATION_GRACE_EPOCHS: u64 = 1;
const FORCE_CLOSE_GRACE_EPOCHS: u64 = 10;
const POLL_CELL_SHANNONS: u64 = 900 * SHANNONS_PER_CKB;
const SINCE_RELATIVE_FLAG: u64 = 1 << 63;
const SINCE_EPOCH_METRIC: u64 = 0x2000_0000_0000_0000;
const SINCE_TIMESTAMP_METRIC: u64 = 0x4000_0000_0000_0000;
const SINCE_RESERVED_FLAG: u64 = 0x0100_0000_0000_0000;
const MAX_DEADLINE_EPOCH: u64 = (1u64 << 24) - FORCE_CLOSE_GRACE_EPOCHS - 2;
const TALLY_SHARD_CODEC_VERSION: u8 = 2;
const TALLY_AGGREGATION_PROOF_VERSION: u8 = 1;
const COUNTED_VOTER_PRESENT_VALUE: [u8; 32] = [1u8; 32];

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

// The fixture retains source voter hashes so host-side Rust can reconstruct
// the committed tree and generate proofs. Only the derived root is serialized.
struct CkbSmtHasher(Blake2b);

impl Default for CkbSmtHasher {
    fn default() -> Self {
        Self(
            Blake2bBuilder::new(32)
                .personal(b"ckb-default-hash")
                .build(),
        )
    }
}

impl Hasher for CkbSmtHasher {
    fn write_h256(&mut self, value: &H256) {
        self.0.update(value.as_slice());
    }

    fn write_byte(&mut self, value: u8) {
        self.0.update(&[value]);
    }

    fn finish(self) -> H256 {
        let mut output = [0u8; 32];
        self.0.finalize(&mut output);
        output.into()
    }
}

type CountedVoterSmt = SparseMerkleTree<CkbSmtHasher, H256, DefaultStore<H256>>;

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

type AggregationIntent = (OutPoint, VoteIntentData, Script, u64, Byte32);

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
    let header_hash = insert_epoch_header(&mut context, epoch);

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
    input_with_since(out_point, 0)
}

fn input_with_since(out_point: OutPoint, since: u64) -> CellInput {
    CellInput::new_builder()
        .since(since)
        .previous_output(out_point)
        .build()
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

fn insert_epoch_header(context: &mut Context, epoch: u64) -> Byte32 {
    let header = HeaderBuilder::default()
        .number(epoch)
        .epoch(EpochNumberWithFraction::new(epoch, 0, 1).pack())
        .build();
    let header_hash = header.hash();
    context.insert_header(header);
    header_hash
}

fn link_cell_to_epoch(context: &mut Context, out_point: &OutPoint, epoch: u64) -> Byte32 {
    let header_hash = insert_epoch_header(context, epoch);
    context.link_cell_with_block(out_point.clone(), header_hash.clone(), 0);
    header_hash
}

fn absolute_epoch_since(epoch: u64) -> u64 {
    SINCE_EPOCH_METRIC | EpochNumberWithFraction::new(epoch, 0, 1).full_value()
}

fn invalid_since_values(strictly_after: u64) -> Vec<u64> {
    let valid_epoch = strictly_after + 1;
    let epoch_value = EpochNumberWithFraction::new(valid_epoch, 0, 1).full_value();
    vec![
        0,
        absolute_epoch_since(strictly_after),
        SINCE_RELATIVE_FLAG | SINCE_EPOCH_METRIC | epoch_value,
        epoch_value,
        SINCE_TIMESTAMP_METRIC | epoch_value,
        SINCE_RESERVED_FLAG | SINCE_EPOCH_METRIC | epoch_value,
        SINCE_EPOCH_METRIC | valid_epoch,
        SINCE_EPOCH_METRIC | EpochNumberWithFraction::new_unchecked(valid_epoch, 1, 1).full_value(),
        u64::MAX,
    ]
}

fn tx_with_headers(
    mut builder: TransactionBuilder,
    header_hashes: impl IntoIterator<Item = Byte32>,
) -> TransactionBuilder {
    let mut unique = Vec::new();
    for header_hash in header_hashes {
        if !unique.iter().any(|existing| existing == &header_hash) {
            unique.push(header_hash.clone());
            builder = builder.header_dep(header_hash);
        }
    }
    builder
}

fn tx_with_header(builder: TransactionBuilder, header_hash: Byte32) -> TransactionBuilder {
    tx_with_headers(builder, [header_hash])
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
    output.push(TALLY_SHARD_CODEC_VERSION);
    output.extend_from_slice(&data.poll_type_hash);
    encode_u32(&mut output, data.shard_id);
    encode_u32(&mut output, data.shard_count);
    encode_u64_vec(&mut output, &data.vote_counts);
    encode_u64(&mut output, data.total_voters);
    output.extend_from_slice(&counted_voter_root(&data.counted_voter_lock_hashes));
    encode_bool(&mut output, data.finalized);
    Bytes::from(output)
}

fn counted_voter_tree(voters: &[[u8; 32]]) -> CountedVoterSmt {
    let mut tree = CountedVoterSmt::default();
    let present = H256::from(COUNTED_VOTER_PRESENT_VALUE);
    tree.update_all(
        voters
            .iter()
            .copied()
            .map(|voter| (H256::from(voter), present))
            .collect(),
    )
    .expect("build counted-voter tree");
    tree
}

fn counted_voter_root(voters: &[[u8; 32]]) -> [u8; 32] {
    counted_voter_tree(voters)
        .root()
        .as_slice()
        .try_into()
        .expect("SMT root")
}

fn encode_tally_aggregation_proof(
    existing_voters: &[[u8; 32]],
    batch_voters: &[[u8; 32]],
) -> Bytes {
    let tree = counted_voter_tree(existing_voters);
    let mut unique_keys: Vec<H256> = Vec::new();
    for voter in batch_voters {
        let key = H256::from(*voter);
        if !unique_keys.iter().any(|existing| existing == &key) {
            unique_keys.push(key);
        }
    }
    let proof: Vec<u8> = tree
        .merkle_proof(unique_keys.clone())
        .expect("build aggregation proof")
        .compile(unique_keys)
        .expect("compile aggregation proof")
        .into();
    let mut payload = Vec::with_capacity(5 + proof.len());
    payload.push(TALLY_AGGREGATION_PROOF_VERSION);
    encode_u32(&mut payload, proof.len() as u32);
    payload.extend_from_slice(&proof);
    Bytes::from(payload)
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

fn replace_first_witness_input_type(
    tx: ckb_testtool::ckb_types::core::TransactionView,
    input_type: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut witnesses: Vec<_> = tx.witnesses().into_iter().collect();
    witnesses[0] = WitnessArgs::new_builder()
        .input_type(Some(input_type).pack())
        .build()
        .as_bytes()
        .pack();
    tx.as_advanced_builder().set_witnesses(witnesses).build()
}

fn append_output(
    tx: ckb_testtool::ckb_types::core::TransactionView,
    cell_output: CellOutput,
    data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    tx.as_advanced_builder()
        .output(cell_output)
        .output_data(data.pack())
        .build()
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
    1 + 32 + 4 + 4 + 4 + data.vote_counts.len() * 8 + 8 + 32
}

fn create_poll_tx(
    fixture: &mut Fixture,
    shard_count: u32,
    wrong_type_id: Option<[u8; 32]>,
    omit_last_shard: bool,
    swap_shard_outputs: bool,
    token_weighted: bool,
    udt_type_hash: [u8; 32],
    deadline_override: Option<u64>,
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
        deadline: deadline_override.unwrap_or(fixture.epoch + 5),
        creator: creator_hash,
        creator_lock: encode_script(&fixture.always_success),
        is_closed: false,
        total_voters: 0,
        creator_deposit: CREATOR_DEPOSIT_SHANNONS,
        pending_intent_count: 0,
        counted_voter_lock_hashes: Vec::new(),
        token_weighted,
        udt_type_hash,
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
    // Keep the creator distinct from the fixture's default participant lock so
    // voting tests exercise the protocol's creator-exclusion rule explicitly.
    let creator_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xC0]))
        .expect("creator always-success lock");
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
    let threshold = if include_creator_auth {
        fixture
            .open_poll
            .deadline
            .checked_add(FINALIZATION_GRACE_EPOCHS)
            .expect("creator-close threshold")
    } else {
        fixture
            .open_poll
            .deadline
            .checked_add(FORCE_CLOSE_GRACE_EPOCHS)
            .expect("force-close threshold")
    };
    close_poll_tx_with_since(
        fixture,
        include_creator_auth,
        creator_auth_override,
        absolute_epoch_since(threshold + 1),
    )
}

fn close_poll_tx_with_since(
    fixture: &mut PollFixture,
    include_creator_auth: bool,
    creator_auth_override: Option<OutPoint>,
    protocol_since: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut closed = fixture.open_poll.clone();
    closed.is_closed = true;
    closed.vote_counts = vec![0, 0];
    closed.total_voters = 0;
    closed.pending_intent_count = 0;
    closed.counted_voter_lock_hashes.clear();

    let mut builder = TransactionBuilder::default()
        .input(input_with_since(fixture.poll_op.clone(), protocol_since))
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

fn replace_fixture_poll_input(fixture: &mut PollFixture) {
    fixture.poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&fixture.open_poll),
    );
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
) -> (OutPoint, VoteIntentData, Script, Byte32) {
    let intent_type = vote_intent_script(&mut fixture.context, &fixture.governance_op, &type_scope);
    let op = governance_cell(
        &mut fixture.context,
        capacity,
        intent_type.clone(),
        intent_type.clone(),
        encode_vote_intent(&intent),
    );
    let creation_header = link_cell_to_epoch(&mut fixture.context, &op, fixture.epoch);
    (op, intent, intent_type, creation_header)
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

fn shard_id_has_voter(fixture: &mut PollFixture, shard_id: u32, seed_start: u8) -> bool {
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
        {
            return true;
        }
    }
    false
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
    intents: Vec<AggregationIntent>,
    marker_overrides: Vec<Option<(VoteIntentData, Script, Script, u64)>>,
    poll_dep: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let shard_script = shard_script_for_fixture(fixture, before_shard.shard_id);
    let batch_voters: Vec<[u8; 32]> = intents
        .iter()
        .map(|(_, intent, _, _, _)| intent.voter_lock_hash)
        .collect();
    let proof_witness = WitnessArgs::new_builder()
        .input_type(
            Some(encode_tally_aggregation_proof(
                &before_shard.counted_voter_lock_hashes,
                &batch_voters,
            ))
            .pack(),
        )
        .build();
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
        .witness(proof_witness.as_bytes().pack());

    let mut header_hashes = vec![fixture.header_hash.clone()];
    for (index, (intent_op, intent, intent_script, capacity, creation_header)) in
        intents.into_iter().enumerate()
    {
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
        header_hashes.push(creation_header);
    }

    tx_with_headers(builder, header_hashes).build()
}

fn build_tally_shard_batch_finalization_tx(
    fixture: &mut PollFixture,
    lanes: Vec<(OutPoint, TallyShardData, TallyShardData, u64)>,
    poll_dep: Option<OutPoint>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    build_tally_shard_batch_finalization_tx_with_output_overrides(
        fixture,
        lanes,
        poll_dep,
        Vec::new(),
    )
}

fn build_tally_shard_batch_finalization_tx_with_output_overrides(
    fixture: &mut PollFixture,
    lanes: Vec<(OutPoint, TallyShardData, TallyShardData, u64)>,
    poll_dep: Option<OutPoint>,
    output_overrides: Vec<Option<(u64, Script, Option<Script>)>>,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut builder = TransactionBuilder::default()
        .cell_dep(cell_dep(fixture.governance_op.clone()))
        .cell_dep(cell_dep(fixture.always_success_op.clone()))
        .cell_dep(cell_dep(
            poll_dep.unwrap_or_else(|| poll_dep_from_fixture(fixture, false)),
        ));

    // Flow: every selected lane occupies the same input/output index. Distinct
    // lane type groups each validate the complete ordered protocol prefix.
    for (index, (shard_op, before, after, protocol_since)) in lanes.into_iter().enumerate() {
        let shard_script = tally_shard_script_from_parts(
            &mut fixture.context,
            &fixture.governance_op,
            &before.poll_type_hash,
            before.shard_id,
        );
        let (output_capacity, output_lock, output_type) = output_overrides
            .get(index)
            .cloned()
            .flatten()
            .unwrap_or_else(|| {
                (
                    TALLY_SHARD_MIN_SHANNONS,
                    shard_script.clone(),
                    Some(shard_script),
                )
            });
        builder = builder
            .input(input_with_since(shard_op, protocol_since))
            .output(output(output_capacity, output_lock, output_type))
            .output_data(encode_tally_shard(&after).pack())
            .witness(blank_witness().pack());
    }

    tx_with_header(builder, fixture.header_hash.clone()).build()
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
    let threshold = if include_creator_auth {
        poll_before
            .deadline
            .checked_add(FINALIZATION_GRACE_EPOCHS)
            .expect("creator-close threshold")
    } else {
        poll_before
            .deadline
            .checked_add(FORCE_CLOSE_GRACE_EPOCHS)
            .expect("force-close threshold")
    };
    close_poll_with_inputs_tx_at_since(
        fixture,
        poll_before,
        poll_after,
        include_creator_auth,
        tally_inputs,
        tally_return_locks,
        intent_inputs,
        creator_return_capacity,
        absolute_epoch_since(threshold + 1),
    )
}

#[allow(clippy::too_many_arguments)]
fn close_poll_with_inputs_tx_at_since(
    fixture: &mut PollFixture,
    poll_before: PollData,
    poll_after: PollData,
    include_creator_auth: bool,
    tally_inputs: Vec<(OutPoint, u64)>,
    tally_return_locks: Vec<Script>,
    intent_inputs: Vec<(OutPoint, VoteIntentData, Script, u64)>,
    creator_return_capacity: u64,
    protocol_since: u64,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let poll_op = governance_cell(
        &mut fixture.context,
        POLL_CELL_SHANNONS,
        fixture.poll_lock.clone(),
        fixture.poll_type.clone(),
        encode_poll(&poll_before),
    );
    let mut builder = TransactionBuilder::default()
        .input(input_with_since(poll_op, protocol_since))
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
    let threshold = poll_before
        .deadline
        .checked_add(FINALIZATION_GRACE_EPOCHS)
        .expect("creator-close threshold");
    let mut builder = TransactionBuilder::default()
        .input(input_with_since(
            poll_op,
            absolute_epoch_since(threshold + 1),
        ))
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
    fixture.header_hash = insert_epoch_header(&mut fixture.context, epoch);
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

fn refund_intent_with_origin_tx(
    fixture: &mut PollFixture,
    intent_op: OutPoint,
    poll_dep: OutPoint,
    refund_lock: Script,
    output_capacity: u64,
    creation_header: Byte32,
) -> ckb_testtool::ckb_types::core::TransactionView {
    tx_with_headers(
        TransactionBuilder::default()
            .input(input(intent_op))
            .output(output(output_capacity, refund_lock, None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .cell_dep(cell_dep(poll_dep))
            .witness(blank_witness().pack()),
        [fixture.header_hash.clone(), creation_header],
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
    let tx = create_poll_tx(
        &mut fixture,
        MAX_ACTIVE_TALLY_SHARDS,
        None,
        false,
        false,
        false,
        [0u8; 32],
        None,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn create_poll_enforces_active_lane_cap() {
    let mut within_cap = fixture(10);
    let valid = create_poll_tx(
        &mut within_cap,
        MAX_ACTIVE_TALLY_SHARDS,
        None,
        false,
        false,
        false,
        [0u8; 32],
        None,
    );
    verify_ok(&mut within_cap.context, valid);

    let mut above_cap = fixture(10);
    let invalid = create_poll_tx(
        &mut above_cap,
        MAX_ACTIVE_TALLY_SHARDS + 1,
        None,
        false,
        false,
        false,
        [0u8; 32],
        None,
    );
    assert_exit_code(&verify_err(&mut above_cap.context, invalid), 5);
}

#[test]
fn create_poll_wrong_type_id_args_fail() {
    let mut fixture = fixture(10);
    let tx = create_poll_tx(
        &mut fixture,
        2,
        Some([0xAA; 32]),
        false,
        false,
        false,
        [0u8; 32],
        None,
    );

    let err = verify_err(&mut fixture.context, tx);
    assert_exit_code(&err, 5);
}

#[test]
fn create_poll_missing_or_misordered_shard_outputs_fail() {
    let mut missing = fixture(10);
    let missing_tx = create_poll_tx(&mut missing, 2, None, true, false, false, [0u8; 32], None);
    assert_exit_code(&verify_err(&mut missing.context, missing_tx), 1);

    let mut misordered = fixture(10);
    let misordered_tx = create_poll_tx(
        &mut misordered,
        2,
        None,
        false,
        true,
        false,
        [0u8; 32],
        None,
    );
    assert_exit_code(&verify_err(&mut misordered.context, misordered_tx), 5);
}

#[test]
fn create_poll_enforces_maximum_encodable_deadline() {
    let mut maximum = fixture(10);
    let valid = create_poll_tx(
        &mut maximum,
        1,
        None,
        false,
        false,
        false,
        [0u8; 32],
        Some(MAX_DEADLINE_EPOCH),
    );
    verify_ok(&mut maximum.context, valid);

    let mut overflow = fixture(10);
    let invalid = create_poll_tx(
        &mut overflow,
        1,
        None,
        false,
        false,
        false,
        [0u8; 32],
        Some(MAX_DEADLINE_EPOCH + 1),
    );
    assert_exit_code(&verify_err(&mut overflow.context, invalid), 5);
}

#[test]
fn create_poll_rejects_token_weighted_mode() {
    let mut fixture = fixture(11);
    let tx = create_poll_tx(&mut fixture, 2, None, false, false, true, [0u8; 32], None);

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn create_poll_rejects_nonzero_udt_type_hash() {
    let mut fixture = fixture(12);
    let tx = create_poll_tx(&mut fixture, 2, None, false, false, false, [0x55; 32], None);

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn protocol_poll_lock_and_creator_close_auth_are_enforced() {
    let mut fixture = create_poll_fixture(20, 2, true);
    let close_epoch = fixture.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1;
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
fn poll_close_rejects_additional_same_type_output() {
    let mut fixture = create_poll_fixture(21, 2, true);
    let close_epoch = fixture.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1;
    set_fixture_epoch(&mut fixture, close_epoch);
    let tx = close_poll_tx(&mut fixture, true, None);
    let extra_output = tx.outputs().get(0).expect("closed poll output");
    let extra_data = tx
        .outputs_data()
        .get(0)
        .expect("closed poll data")
        .raw_data();
    let tx = append_output(tx, extra_output, extra_data);

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn non_creator_close_before_force_close_grace_fails() {
    let mut fixture = create_poll_fixture(20, 2, true);
    let close_epoch = fixture.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1;
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
fn creator_close_rejects_invalid_since_values_and_threshold_overflow() {
    let mut fixture = create_poll_fixture(21, 2, true);
    let deadline = fixture.open_poll.deadline;
    for protocol_since in invalid_since_values(deadline + FINALIZATION_GRACE_EPOCHS) {
        let tx = close_poll_tx_with_since(&mut fixture, true, None, protocol_since);
        assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
    }

    let valid = close_poll_tx_with_since(
        &mut fixture,
        true,
        None,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    );
    verify_ok(&mut fixture.context, valid);

    let mut overflow = create_poll_fixture(22, 2, true);
    overflow.open_poll.deadline = u64::MAX;
    replace_fixture_poll_input(&mut overflow);
    let tx = close_poll_tx_with_since(
        &mut overflow,
        true,
        None,
        absolute_epoch_since(MAX_DEADLINE_EPOCH + 1),
    );
    assert_exit_code(&verify_err(&mut overflow.context, tx), 5);
}

#[test]
fn force_close_rejects_invalid_since_values_and_threshold_overflow() {
    let mut fixture = create_poll_fixture(23, 2, true);
    let force_threshold = fixture.open_poll.deadline + FORCE_CLOSE_GRACE_EPOCHS;
    for protocol_since in invalid_since_values(force_threshold) {
        let tx = close_poll_tx_with_since(&mut fixture, false, None, protocol_since);
        assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
    }

    let valid = close_poll_tx_with_since(
        &mut fixture,
        false,
        None,
        absolute_epoch_since(force_threshold + 1),
    );
    verify_ok(&mut fixture.context, valid);

    let mut overflow = create_poll_fixture(24, 2, true);
    overflow.open_poll.deadline = u64::MAX - FORCE_CLOSE_GRACE_EPOCHS + 1;
    replace_fixture_poll_input(&mut overflow);
    let tx = close_poll_tx_with_since(
        &mut overflow,
        false,
        None,
        absolute_epoch_since(MAX_DEADLINE_EPOCH + 1),
    );
    assert_exit_code(&verify_err(&mut overflow.context, tx), 5);
}

#[test]
fn vote_intent_creation_validates_scope_option_and_poll_dep() {
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

    let informational_epoch = build_create_intent_tx(
        &mut fixture,
        voter_op.clone(),
        voter_lock.clone(),
        voter_hash,
        voter_lock.clone(),
        1,
        epoch + 100,
        None,
        None,
        None,
    );
    // This legacy field is preserved for codec compatibility, but it is not a
    // consensus timestamp and cannot authorize later aggregation.
    verify_ok(&mut fixture.context, informational_epoch);

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
fn token_weighted_poll_dep_cannot_authorize_vote_intent_creation() {
    let mut fixture = create_poll_fixture(33, 2, false);
    fixture.open_poll.token_weighted = true;
    let voter_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&voter_lock);
    let voter_op = plain_cell(
        &mut fixture.context,
        voter_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let tx = build_create_intent_tx(
        &mut fixture,
        voter_op,
        voter_lock.clone(),
        voter_hash,
        voter_lock,
        0,
        0,
        None,
        None,
        None,
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn vote_intent_creation_rejects_additional_same_script_output() {
    let mut fixture = create_poll_fixture(31, 2, false);
    let voter_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&voter_lock);
    let voter_op = plain_cell(
        &mut fixture.context,
        voter_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let tx = build_create_intent_tx(
        &mut fixture,
        voter_op,
        voter_lock.clone(),
        voter_hash,
        voter_lock,
        1,
        0,
        None,
        None,
        None,
    );
    verify_ok(&mut fixture.context, tx.clone());
    let extra_output = tx.outputs().get(0).expect("intent output");
    let extra_data = tx.outputs_data().get(0).expect("intent data").raw_data();
    let tx = append_output(tx, extra_output, extra_data);

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn vote_intent_creation_rejects_unauthorized_appended_represented_voter() {
    let mut fixture = create_poll_fixture(32, 2, false);
    let voter_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&voter_lock);
    let voter_op = plain_cell(
        &mut fixture.context,
        voter_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let tx = build_create_intent_tx(
        &mut fixture,
        voter_op,
        voter_lock.clone(),
        voter_hash,
        voter_lock,
        0,
        0,
        None,
        None,
        None,
    );
    let unauthorized_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0x91]))
        .expect("unauthorized represented voter lock");
    let unauthorized_intent = VoteIntentData {
        poll_type_hash: fixture.poll_type_hash,
        voter_lock_hash: script_hash(&unauthorized_lock),
        option_index: 0,
        voted_at_epoch: 0,
        aggregated: false,
        refund_lock: encode_script(&unauthorized_lock),
    };
    let extra_output = tx.outputs().get(0).expect("intent output");
    let tx = append_output(tx, extra_output, encode_vote_intent(&unauthorized_intent));

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn poll_creator_cannot_submit_direct_or_delegated_vote_intents() {
    let mut fixture = create_poll_fixture(32, 2, false);
    let epoch = fixture.epoch;
    let poll_type_hash = fixture.poll_type_hash;
    let creator_hash = fixture.open_poll.creator;
    let creator_lock = fixture.creator_lock.clone();
    let creator_auth_op = fixture.creator_auth_op.clone();
    let participant_lock = fixture.always_success.clone();
    let participant_hash = script_hash(&participant_lock);
    let participant_auth_op = plain_cell(
        &mut fixture.context,
        participant_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );

    let direct = build_create_intent_tx(
        &mut fixture,
        creator_auth_op.clone(),
        creator_lock.clone(),
        creator_hash,
        creator_lock.clone(),
        0,
        epoch,
        None,
        None,
        None,
    );
    assert_exit_code(&verify_err(&mut fixture.context, direct), 5);

    let creator_delegation = DelegationData {
        delegator_lock_hash: creator_hash,
        delegate_lock_hash: participant_hash,
        poll_type_hash,
        expires_epoch: 0,
    };
    let creator_delegation_op = delegation_cell(
        &mut fixture,
        creator_lock.clone(),
        creator_delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let represented_creator = build_create_intent_tx(
        &mut fixture,
        participant_auth_op,
        participant_lock.clone(),
        creator_hash,
        creator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(creator_delegation_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, represented_creator), 5);

    let creator_as_delegate = DelegationData {
        delegator_lock_hash: participant_hash,
        delegate_lock_hash: creator_hash,
        poll_type_hash,
        expires_epoch: 0,
    };
    let creator_as_delegate_op = delegation_cell(
        &mut fixture,
        participant_lock.clone(),
        creator_as_delegate,
        DELEGATION_MIN_SHANNONS,
    );
    let submitted_by_creator = build_create_intent_tx(
        &mut fixture,
        creator_auth_op,
        creator_lock,
        participant_hash,
        participant_lock,
        0,
        epoch,
        None,
        None,
        Some(creator_as_delegate_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, submitted_by_creator), 5);
}

#[test]
fn caller_selected_header_dep_zero_is_not_a_current_time_authority() {
    let mut fixture = create_poll_fixture(35, 2, false);
    let stale_epoch = fixture.epoch;
    let stale_header_hash = fixture.header_hash.clone();
    let newer_epoch = fixture.open_poll.deadline + 1;
    let newer_header = HeaderBuilder::default()
        .parent_hash(stale_header_hash.clone())
        .number(newer_epoch)
        .epoch(EpochNumberWithFraction::new(newer_epoch, 0, 1).pack())
        .build();
    fixture.context.insert_header(newer_header);

    let voter_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&voter_lock);
    let voter_op = plain_cell(
        &mut fixture.context,
        voter_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let tx = build_create_intent_tx(
        &mut fixture,
        voter_op,
        voter_lock.clone(),
        voter_hash,
        voter_lock,
        1,
        stale_epoch,
        None,
        None,
        None,
    );

    assert_eq!(tx.header_deps().get(0), Some(stale_header_hash));
    // Pre-fix, HeaderDep(0) returned `stale_epoch`, so the matching caller-set
    // field passed even though a newer canonical descendant was present.
    // Hardened intent creation treats the field as informational and defers
    // the enforceable cutoff to the input-linked creation header.
    verify_ok(&mut fixture.context, tx);
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
fn late_intent_refund_requires_authenticated_late_origin_and_exact_full_capacity() {
    let mut fixture = create_poll_fixture(52, 2, false);
    let poll_hash = fixture.poll_type_hash;
    let refund_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&refund_lock);
    let capacity = VOTER_DEPOSIT_SHANNONS + 4_321;
    let (late_op, _, _) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_hash,
        poll_hash,
        voter_hash,
        0,
        false,
        refund_lock.clone(),
        capacity,
    );
    let late_epoch = fixture.open_poll.deadline + 1;
    let late_header = link_cell_to_epoch(&mut fixture.context, &late_op, late_epoch);
    let open_poll_dep = poll_dep_from_fixture(&mut fixture, false);
    let valid = refund_intent_with_origin_tx(
        &mut fixture,
        late_op.clone(),
        open_poll_dep.clone(),
        refund_lock.clone(),
        capacity,
        late_header.clone(),
    );
    verify_ok(&mut fixture.context, valid);

    let underpaid = refund_intent_with_origin_tx(
        &mut fixture,
        late_op,
        open_poll_dep,
        refund_lock.clone(),
        capacity - 1,
        late_header,
    );
    assert_exit_code(&verify_err(&mut fixture.context, underpaid), 5);

    let (timely_op, _, _) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_hash,
        poll_hash,
        voter_hash,
        1,
        false,
        refund_lock.clone(),
        capacity,
    );
    let timely_header = link_cell_to_epoch(&mut fixture.context, &timely_op, fixture.epoch);
    let open_poll_dep = poll_dep_from_fixture(&mut fixture, false);
    let premature = refund_intent_with_origin_tx(
        &mut fixture,
        timely_op,
        open_poll_dep,
        refund_lock,
        capacity,
        timely_header,
    );
    assert_exit_code(&verify_err(&mut fixture.context, premature), 5);
}

#[test]
fn open_poll_late_refund_rejects_aggregated_marker_with_exact_capacity() {
    let mut fixture = create_poll_fixture(53, 2, false);
    let poll_hash = fixture.poll_type_hash;
    let refund_lock = fixture.always_success.clone();
    let voter_hash = script_hash(&refund_lock);
    let capacity = VOTER_DEPOSIT_SHANNONS + 5_432;
    let (marker_op, _, _) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_hash,
        poll_hash,
        voter_hash,
        0,
        true,
        refund_lock.clone(),
        capacity,
    );
    let late_epoch = fixture.open_poll.deadline + 1;
    let marker_header = link_cell_to_epoch(&mut fixture.context, &marker_op, late_epoch);
    let open_poll_dep = poll_dep_from_fixture(&mut fixture, false);
    let tx = refund_intent_with_origin_tx(
        &mut fixture,
        marker_op,
        open_poll_dep,
        refund_lock,
        capacity,
        marker_header,
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
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
    Vec<AggregationIntent>,
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
    let intent_header = link_cell_to_epoch(&mut fixture.context, &intent_op, fixture.epoch);
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
    let second_header = link_cell_to_epoch(&mut fixture.context, &second_op, fixture.epoch);
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
            (
                intent_op,
                intent,
                intent_script,
                VOTER_DEPOSIT_SHANNONS,
                intent_header,
            ),
            (
                second_op,
                second_intent,
                second_script,
                VOTER_DEPOSIT_SHANNONS,
                second_header,
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

    assert_eq!(
        tx.header_deps().len(),
        1,
        "shared intent creation headers must be deduplicated"
    );
    verify_ok(&mut fixture.context, tx);
}

#[test]
fn tally_shard_aggregation_stays_bounded_through_50_intents() {
    for batch_size in [1u8, 10, 25, 50] {
        let mut fixture = create_poll_fixture(137 + u64::from(batch_size), 1, false);
        let before = fixture.shard_data[0].clone();
        let shard_op = fixture.shard_ops[0].clone();
        let poll_type_hash = fixture.poll_type_hash;
        let mut after = before.clone();
        let mut intents: Vec<AggregationIntent> = Vec::new();

        for seed in 0u8..batch_size {
            let voter_lock = fixture
                .context
                .build_script(&fixture.always_success_op, Bytes::from(vec![seed]))
                .expect("voter lock");
            let voter_hash = script_hash(&voter_lock);
            let option_index = seed % 2;
            let (intent_op, intent, intent_script) = live_intent_cell_with_capacity(
                &mut fixture,
                poll_type_hash,
                poll_type_hash,
                voter_hash,
                option_index,
                false,
                voter_lock,
                VOTER_DEPOSIT_SHANNONS,
            );
            let creation_header =
                link_cell_to_epoch(&mut fixture.context, &intent_op, fixture.epoch);
            intents.push((
                intent_op,
                intent,
                intent_script,
                VOTER_DEPOSIT_SHANNONS,
                creation_header,
            ));
            after.vote_counts[usize::from(option_index)] += 1;
            after.total_voters += 1;
            after.counted_voter_lock_hashes.push(voter_hash);
        }

        let tx = build_tally_shard_aggregation_tx(
            &mut fixture,
            shard_op,
            before,
            after,
            intents,
            Vec::new(),
            None,
        );
        let tx_bytes = tx.data().serialized_size_in_block();
        let cycles = verify_ok(&mut fixture.context, tx);
        assert!(
            cycles <= MAX_AGGREGATION_CYCLES,
            "batch {batch_size} used {cycles} cycles, above the {MAX_AGGREGATION_CYCLES} project ceiling"
        );
        println!(
            "V2_SMT_AGG batch={batch_size} tx_bytes={tx_bytes} cycles={cycles} ceiling={MAX_AGGREGATION_CYCLES}"
        );
    }
}

#[test]
fn tally_shard_aggregation_stays_bounded_with_1024_existing_voters() {
    let mut fixture = create_poll_fixture(190, 1, false);
    let mut before = fixture.shard_data[0].clone();
    before.counted_voter_lock_hashes = (0..1_024u64)
        .map(|index| {
            let mut input = b"mature-tally-lane".to_vec();
            input.extend_from_slice(&index.to_le_bytes());
            blake2b_256(&input)
        })
        .collect();
    before.vote_counts = vec![512, 512];
    before.total_voters = 1_024;
    let shard_script = shard_script_for_fixture(&mut fixture, 0);
    let shard_op = governance_cell(
        &mut fixture.context,
        TALLY_SHARD_MIN_SHANNONS,
        shard_script.clone(),
        shard_script,
        encode_tally_shard(&before),
    );
    let poll_type_hash = fixture.poll_type_hash;
    let mut after = before.clone();
    let mut intents: Vec<AggregationIntent> = Vec::new();

    for seed in 0u8..50 {
        let voter_lock = fixture
            .context
            .build_script(&fixture.always_success_op, Bytes::from(vec![0x80, seed]))
            .expect("mature-lane voter lock");
        let voter_hash = script_hash(&voter_lock);
        assert!(!before.counted_voter_lock_hashes.contains(&voter_hash));
        let option_index = seed % 2;
        let (intent_op, intent, intent_script) = live_intent_cell_with_capacity(
            &mut fixture,
            poll_type_hash,
            poll_type_hash,
            voter_hash,
            option_index,
            false,
            voter_lock,
            VOTER_DEPOSIT_SHANNONS,
        );
        let creation_header = link_cell_to_epoch(&mut fixture.context, &intent_op, fixture.epoch);
        intents.push((
            intent_op,
            intent,
            intent_script,
            VOTER_DEPOSIT_SHANNONS,
            creation_header,
        ));
        after.vote_counts[usize::from(option_index)] += 1;
        after.total_voters += 1;
        after.counted_voter_lock_hashes.push(voter_hash);
    }

    let batch_voters: Vec<[u8; 32]> = after.counted_voter_lock_hashes[1_024..].to_vec();
    let proof_bytes =
        encode_tally_aggregation_proof(&before.counted_voter_lock_hashes, &batch_voters).len();
    let tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    let tx_bytes = tx.data().serialized_size_in_block();
    let cycles = verify_ok(&mut fixture.context, tx);
    assert!(
        cycles <= MAX_AGGREGATION_CYCLES,
        "mature 50-intent batch used {cycles} cycles, above the project ceiling"
    );
    println!(
        "V2_SMT_AGG_MATURE existing=1024 batch=50 proof_bytes={proof_bytes} tx_bytes={tx_bytes} cycles={cycles} ceiling={MAX_AGGREGATION_CYCLES}"
    );
}

#[test]
fn token_weighted_poll_dep_cannot_authorize_tally_shard_aggregation() {
    let (mut fixture, shard_op, before_shard, after_shard, intents) = aggregation_fixture(136);
    let mut weighted_poll = fixture.open_poll.clone();
    weighted_poll.token_weighted = true;
    let weighted_poll_dep = poll_dep_from_data(&mut fixture, weighted_poll);
    let tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before_shard,
        after_shard,
        intents,
        Vec::new(),
        Some(weighted_poll_dep),
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn equal_weight_aggregation_counts_oversized_intent_as_one() {
    let mut fixture = create_poll_fixture(131, 4, false);
    let shard_id = 1u32;
    let before = fixture.shard_data[shard_id as usize].clone();
    let shard_op = fixture.shard_ops[shard_id as usize].clone();
    let (voter_lock, voter_hash) = voter_for_shard(&mut fixture, shard_id, 0x31);
    let oversized_capacity = VOTER_DEPOSIT_SHANNONS * 5;
    let poll_type_hash = fixture.poll_type_hash;
    let (intent_op, intent, intent_script) = live_intent_cell_with_capacity(
        &mut fixture,
        poll_type_hash,
        poll_type_hash,
        voter_hash,
        0,
        false,
        voter_lock,
        oversized_capacity,
    );
    let creation_header = link_cell_to_epoch(&mut fixture.context, &intent_op, fixture.epoch);
    let mut after = before.clone();
    after.vote_counts[0] = 1;
    after.total_voters = 1;
    after.counted_voter_lock_hashes = vec![voter_hash];
    let tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before,
        after,
        vec![(
            intent_op,
            intent,
            intent_script,
            oversized_capacity,
            creation_header,
        )],
        Vec::new(),
        None,
    );

    verify_ok(&mut fixture.context, tx);
}

#[test]
fn weighted_poll_cells_retain_finalize_close_and_refund_recovery() {
    let mut finalize = create_poll_fixture(132, 2, false);
    let mut weighted_open = finalize.open_poll.clone();
    weighted_open.token_weighted = true;
    let weighted_poll_dep = poll_dep_from_data(&mut finalize, weighted_open);
    let finalize_epoch = finalize.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1;
    set_fixture_epoch(&mut finalize, finalize_epoch);
    let lanes = (0..finalize.shard_ops.len())
        .map(|index| {
            let before = finalize.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                finalize.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(finalize.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut finalize, lanes, Some(weighted_poll_dep));
    verify_ok(&mut finalize.context, tx);

    let mut close = create_poll_fixture(133, 2, true);
    let close_epoch = close.open_poll.deadline + FINALIZATION_GRACE_EPOCHS + 1;
    set_fixture_epoch(&mut close, close_epoch);
    let mut weighted_before = close.open_poll.clone();
    weighted_before.token_weighted = true;
    let weighted_after = closed_poll_from_result(&weighted_before, vec![0, 0], 0);
    let tally_inputs = close
        .shard_ops
        .iter()
        .cloned()
        .map(|op| (op, TALLY_SHARD_MIN_SHANNONS))
        .collect();
    let tally_return_locks = vec![close.creator_lock.clone(); close.shard_ops.len()];
    let tx = close_poll_with_inputs_tx(
        &mut close,
        weighted_before,
        weighted_after,
        true,
        tally_inputs,
        tally_return_locks,
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    verify_ok(&mut close.context, tx);

    let mut refund = create_poll_fixture(134, 2, false);
    let refund_lock = refund.always_success.clone();
    let voter_hash = script_hash(&refund_lock);
    let poll_type_hash = refund.poll_type_hash;
    let (intent_op, _, _) = live_intent_cell(
        &mut refund,
        poll_type_hash,
        voter_hash,
        0,
        false,
        refund_lock.clone(),
    );
    let mut weighted_closed = refund.open_poll.clone();
    weighted_closed.token_weighted = true;
    weighted_closed.is_closed = true;
    let weighted_closed_dep = poll_dep_from_data(&mut refund, weighted_closed);
    let tx = refund_omitted_intent_tx(&mut refund, intent_op, weighted_closed_dep, refund_lock);
    verify_ok(&mut refund.context, tx);
}

#[test]
fn tally_shard_aggregation_rejects_appended_intent_output() {
    let (mut fixture, shard_op, before, after, intents) = aggregation_fixture(132);
    let extra_intent = intents[0].1.clone();
    let extra_script = intents[0].2.clone();
    let funding_lock = fixture.always_success.clone();
    let funding_op = plain_cell(&mut fixture.context, funding_lock, VOTER_DEPOSIT_SHANNONS);
    let tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    )
    .as_advanced_builder()
    .input(input(funding_op))
    .output(output(
        VOTER_DEPOSIT_SHANNONS,
        extra_script.clone(),
        Some(extra_script),
    ))
    .output_data(encode_vote_intent(&extra_intent).pack())
    .witness(blank_witness().pack())
    .build();

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
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
    intents[0] = (
        rebuilt.0,
        rebuilt.1,
        rebuilt.2,
        VOTER_DEPOSIT_SHANNONS,
        rebuilt.3,
    );
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
    intents[0] = (
        rebuilt.0,
        rebuilt.1,
        rebuilt.2,
        VOTER_DEPOSIT_SHANNONS,
        rebuilt.3,
    );
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
    intents[1] = (
        rebuilt.0,
        rebuilt.1,
        rebuilt.2,
        VOTER_DEPOSIT_SHANNONS,
        rebuilt.3,
    );
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
    intents[0] = (
        rebuilt.0,
        rebuilt.1,
        rebuilt.2,
        VOTER_DEPOSIT_SHANNONS,
        rebuilt.3,
    );
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
fn tally_shard_aggregation_rejects_malformed_proofs_and_wrong_roots() {
    let (mut fixture, shard_op, before, after, intents) = aggregation_fixture(86);
    let batch_voters: Vec<[u8; 32]> = intents
        .iter()
        .map(|(_, intent, _, _, _)| intent.voter_lock_hash)
        .collect();
    let valid_payload =
        encode_tally_aggregation_proof(&before.counted_voter_lock_hashes, &batch_voters);
    let valid_tx = build_tally_shard_aggregation_tx(
        &mut fixture,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );

    let mut unknown_version = valid_payload.to_vec();
    unknown_version[0] = 2;
    let tx = replace_first_witness_input_type(valid_tx.clone(), Bytes::from(unknown_version));
    let _ = verify_err(&mut fixture.context, tx);

    let mut truncated = valid_payload.to_vec();
    truncated.pop();
    let tx = replace_first_witness_input_type(valid_tx.clone(), Bytes::from(truncated));
    let _ = verify_err(&mut fixture.context, tx);

    let tx = replace_first_witness_input_type(
        valid_tx.clone(),
        with_trailing_byte(valid_payload.clone()),
    );
    let _ = verify_err(&mut fixture.context, tx);

    let mut corrupted = valid_payload.to_vec();
    let last = corrupted.len() - 1;
    corrupted[last] ^= 1;
    let tx = replace_first_witness_input_type(valid_tx, Bytes::from(corrupted));
    let _ = verify_err(&mut fixture.context, tx);

    let (mut wrong_root, shard_op, before, mut after, intents) = aggregation_fixture(87);
    // The proof covers only the consumed intent keys; adding another committed
    // leaf changes the output root and must fail the same proof.
    after.counted_voter_lock_hashes.push([0xEE; 32]);
    let tx = build_tally_shard_aggregation_tx(
        &mut wrong_root,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut wrong_root.context, tx), 5);
}

#[test]
fn tally_shard_aggregation_uses_authenticated_intent_creation_epochs() {
    let (mut timely, shard_op, before, after, intents) = aggregation_fixture(90);
    let post_deadline_epoch = timely.open_poll.deadline + 1;
    set_fixture_epoch(&mut timely, post_deadline_epoch);
    let tx = build_tally_shard_aggregation_tx(
        &mut timely,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_eq!(tx.header_deps().len(), 2);
    verify_ok(&mut timely.context, tx);

    let (mut late, shard_op, before, after, mut intents) = aggregation_fixture(93);
    let late_epoch = late.open_poll.deadline + 1;
    for intent in &mut intents {
        // HeaderDep(0) remains the fixture's old pre-deadline header. The
        // input-linked header is later, so caller-selected ordering cannot
        // make these intents count.
        intent.4 = link_cell_to_epoch(&mut late.context, &intent.0, late_epoch);
    }
    let tx = build_tally_shard_aggregation_tx(
        &mut late,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    );
    assert_exit_code(&verify_err(&mut late.context, tx), 5);

    let (mut missing, shard_op, before, after, intents) = aggregation_fixture(94);
    let post_deadline_epoch = missing.open_poll.deadline + 1;
    set_fixture_epoch(&mut missing, post_deadline_epoch);
    let tx = build_tally_shard_aggregation_tx(
        &mut missing,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    )
    .as_advanced_builder()
    .set_header_deps(Vec::new())
    .build();
    let _ = verify_err(&mut missing.context, tx);

    let (mut wrong, shard_op, before, after, intents) = aggregation_fixture(95);
    let post_deadline_epoch = wrong.open_poll.deadline + 1;
    set_fixture_epoch(&mut wrong, post_deadline_epoch);
    let wrong_header = insert_epoch_header(&mut wrong.context, wrong.open_poll.deadline);
    let tx = build_tally_shard_aggregation_tx(
        &mut wrong,
        shard_op,
        before,
        after,
        intents,
        Vec::new(),
        None,
    )
    .as_advanced_builder()
    .set_header_deps(vec![wrong_header])
    .build();
    let _ = verify_err(&mut wrong.context, tx);
}

#[test]
fn tally_shard_aggregation_rejects_finalized_and_mutated_shards() {
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
    let mut fixture = create_poll_fixture(100, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = fixture.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                fixture.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let valid = build_tally_shard_batch_finalization_tx(&mut fixture, lanes, None);
    verify_ok(&mut fixture.context, valid);

    let mut early = create_poll_fixture(101, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = early.open_poll.deadline;
    set_fixture_epoch(&mut early, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = early.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                early.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS),
            )
        })
        .collect();
    let early_tx = build_tally_shard_batch_finalization_tx(&mut early, lanes, None);
    assert_exit_code(&verify_err(&mut early.context, early_tx), 5);

    let mut mutated = create_poll_fixture(102, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = mutated.open_poll.deadline;
    set_fixture_epoch(&mut mutated, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = mutated.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            if index == 0 {
                after.vote_counts[0] = 1;
            }
            (
                mutated.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let mutated_tx = build_tally_shard_batch_finalization_tx(&mut mutated, lanes, None);
    assert_exit_code(&verify_err(&mut mutated.context, mutated_tx), 5);

    let mut wrong_total = create_poll_fixture(117, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = wrong_total.open_poll.deadline;
    set_fixture_epoch(&mut wrong_total, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = wrong_total.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            if index == 0 {
                after.total_voters += 1;
            }
            (
                wrong_total.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut wrong_total, lanes, None);
    assert_exit_code(&verify_err(&mut wrong_total.context, tx), 5);

    let mut wrong_shape = create_poll_fixture(118, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = wrong_shape.open_poll.deadline;
    set_fixture_epoch(&mut wrong_shape, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = wrong_shape.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            if index == 0 {
                after.vote_counts.push(0);
            }
            (
                wrong_shape.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut wrong_shape, lanes, None);
    assert_exit_code(&verify_err(&mut wrong_shape.context, tx), 5);

    let mut wrong_dep = create_poll_fixture(103, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = wrong_dep.open_poll.deadline;
    set_fixture_epoch(&mut wrong_dep, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = wrong_dep.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                wrong_dep.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let mut poll = wrong_dep.open_poll.clone();
    poll.shard_count = MAX_ACTIVE_TALLY_SHARDS - 1;
    let dep = poll_dep_from_data(&mut wrong_dep, poll);
    let wrong_dep_tx = build_tally_shard_batch_finalization_tx(&mut wrong_dep, lanes, Some(dep));
    assert_exit_code(&verify_err(&mut wrong_dep.context, wrong_dep_tx), 5);
}

#[test]
fn tally_shard_finalization_rejects_invalid_since_values_and_threshold_overflow() {
    let mut fixture = create_poll_fixture(106, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = fixture.open_poll.deadline;

    for protocol_since in invalid_since_values(deadline + FINALIZATION_GRACE_EPOCHS) {
        let lanes = (0..MAX_SHARDS_PER_FINALIZE)
            .map(|index| {
                let before = fixture.shard_data[index].clone();
                let mut after = before.clone();
                after.finalized = true;
                (
                    fixture.shard_ops[index].clone(),
                    before,
                    after,
                    protocol_since,
                )
            })
            .collect();
        let tx = build_tally_shard_batch_finalization_tx(&mut fixture, lanes, None);
        assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
    }

    let mut overflow = create_poll_fixture(107, MAX_ACTIVE_TALLY_SHARDS, false);
    overflow.open_poll.deadline = u64::MAX;
    replace_fixture_poll_input(&mut overflow);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = overflow.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                overflow.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(MAX_DEADLINE_EPOCH + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut overflow, lanes, None);
    assert_exit_code(&verify_err(&mut overflow.context, tx), 5);
}

#[test]
fn tally_shard_batch_finalization_accepts_sixteen_ordered_lanes_in_one_transaction() {
    let mut fixture = create_poll_fixture(108, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = fixture.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                fixture.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut fixture, lanes, None);
    assert_eq!(tx.inputs().len(), MAX_SHARDS_PER_FINALIZE);
    let tx_bytes = tx.data().serialized_size_in_block();
    let cycles = verify_ok(&mut fixture.context, tx);
    assert!(
        cycles <= MAX_AGGREGATION_CYCLES,
        "sixteen-lane finalization used {cycles} cycles, above the project ceiling"
    );
    println!("V2_BATCH_FINALIZE lanes=16 tx_bytes={tx_bytes} cycles={cycles}");
}

#[test]
fn tally_shard_batch_finalization_rejects_order_scope_and_batch_violations() {
    let mut wrong_order = create_poll_fixture(109, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = wrong_order.open_poll.deadline;
    set_fixture_epoch(&mut wrong_order, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = [1usize, 0]
        .into_iter()
        .chain(2..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = wrong_order.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                wrong_order.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut wrong_order, lanes, None);
    assert_exit_code(&verify_err(&mut wrong_order.context, tx), 5);

    let mut too_many = create_poll_fixture(110, MAX_ACTIVE_TALLY_SHARDS + 1, false);
    let deadline = too_many.open_poll.deadline;
    set_fixture_epoch(&mut too_many, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..=MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = too_many.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                too_many.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut too_many, lanes, None);
    assert_exit_code(&verify_err(&mut too_many.context, tx), 5);

    let mut one_lane = create_poll_fixture(119, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = one_lane.open_poll.deadline;
    set_fixture_epoch(&mut one_lane, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let before = one_lane.shard_data[0].clone();
    let mut after = before.clone();
    after.finalized = true;
    let lanes = vec![(
        one_lane.shard_ops[0].clone(),
        before,
        after,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    )];
    let tx = build_tally_shard_batch_finalization_tx(&mut one_lane, lanes, None);
    assert_exit_code(&verify_err(&mut one_lane.context, tx), 5);

    let mut incomplete = create_poll_fixture(111, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = incomplete.open_poll.deadline;
    set_fixture_epoch(&mut incomplete, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..8usize)
        .map(|index| {
            let before = incomplete.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                incomplete.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut incomplete, lanes, None);
    assert_exit_code(&verify_err(&mut incomplete.context, tx), 5);

    let mut almost_complete = create_poll_fixture(112, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = almost_complete.open_poll.deadline;
    set_fixture_epoch(
        &mut almost_complete,
        deadline + FINALIZATION_GRACE_EPOCHS + 1,
    );
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .filter(|index| *index != MAX_SHARDS_PER_FINALIZE / 2)
        .map(|index| {
            let before = almost_complete.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                almost_complete.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut almost_complete, lanes, None);
    assert_exit_code(&verify_err(&mut almost_complete.context, tx), 5);

    let mut duplicate = create_poll_fixture(121, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = duplicate.open_poll.deadline;
    set_fixture_epoch(&mut duplicate, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let mut lanes: Vec<_> = (0..(MAX_SHARDS_PER_FINALIZE - 1))
        .map(|index| {
            let before = duplicate.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                duplicate.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let duplicate_index = MAX_SHARDS_PER_FINALIZE - 2;
    let duplicate_before = duplicate.shard_data[duplicate_index].clone();
    let mut duplicate_after = duplicate_before.clone();
    duplicate_after.finalized = true;
    let duplicate_script = shard_script_for_fixture(&mut duplicate, duplicate_index as u32);
    let duplicate_op = governance_cell(
        &mut duplicate.context,
        TALLY_SHARD_MIN_SHANNONS,
        duplicate_script.clone(),
        duplicate_script,
        encode_tally_shard(&duplicate_before),
    );
    lanes.push((
        duplicate_op,
        duplicate_before,
        duplicate_after,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    ));
    let tx = build_tally_shard_batch_finalization_tx(&mut duplicate, lanes, None);
    assert_exit_code(&verify_err(&mut duplicate.context, tx), 5);

    let mut out_of_range = create_poll_fixture(122, 1, false);
    let deadline = out_of_range.open_poll.deadline;
    set_fixture_epoch(&mut out_of_range, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let before = TallyShardData {
        poll_type_hash: out_of_range.poll_type_hash,
        shard_id: 1,
        shard_count: 1,
        vote_counts: vec![0, 0],
        total_voters: 0,
        counted_voter_lock_hashes: Vec::new(),
        finalized: false,
    };
    let mut after = before.clone();
    after.finalized = true;
    let shard_script = tally_shard_script_from_parts(
        &mut out_of_range.context,
        &out_of_range.governance_op,
        &out_of_range.poll_type_hash,
        1,
    );
    let shard_op = governance_cell(
        &mut out_of_range.context,
        TALLY_SHARD_MIN_SHANNONS,
        shard_script.clone(),
        shard_script,
        encode_tally_shard(&before),
    );
    let lanes = vec![(
        shard_op,
        before,
        after,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    )];
    let tx = build_tally_shard_batch_finalization_tx(&mut out_of_range, lanes, None);
    assert_exit_code(&verify_err(&mut out_of_range.context, tx), 4);

    let mut mixed_poll = create_poll_fixture(113, 2, false);
    let deadline = mixed_poll.open_poll.deadline;
    set_fixture_epoch(&mut mixed_poll, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let normal_before = mixed_poll.shard_data[0].clone();
    let mut normal_after = normal_before.clone();
    normal_after.finalized = true;
    let foreign_hash = [0xFA; 32];
    let foreign_before = TallyShardData {
        poll_type_hash: foreign_hash,
        shard_id: 1,
        shard_count: 2,
        vote_counts: vec![0, 0],
        total_voters: 0,
        counted_voter_lock_hashes: Vec::new(),
        finalized: false,
    };
    let mut foreign_after = foreign_before.clone();
    foreign_after.finalized = true;
    let foreign_script = tally_shard_script_from_parts(
        &mut mixed_poll.context,
        &mixed_poll.governance_op,
        &foreign_hash,
        1,
    );
    let foreign_op = governance_cell(
        &mut mixed_poll.context,
        TALLY_SHARD_MIN_SHANNONS,
        foreign_script.clone(),
        foreign_script,
        encode_tally_shard(&foreign_before),
    );
    let lanes = vec![
        (
            mixed_poll.shard_ops[0].clone(),
            normal_before,
            normal_after,
            absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
        ),
        (
            foreign_op,
            foreign_before,
            foreign_after,
            absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
        ),
    ];
    let tx = build_tally_shard_batch_finalization_tx(&mut mixed_poll, lanes, None);
    assert_exit_code(&verify_err(&mut mixed_poll.context, tx), 5);
}

#[test]
fn tally_shard_batch_finalization_rejects_bad_since_root_and_extra_lane_output() {
    let mut bad_since = create_poll_fixture(114, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = bad_since.open_poll.deadline;
    set_fixture_epoch(&mut bad_since, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = bad_since.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            let since_epoch = if index == 0 {
                deadline + FINALIZATION_GRACE_EPOCHS + 1
            } else {
                deadline + FINALIZATION_GRACE_EPOCHS
            };
            (
                bad_since.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(since_epoch),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut bad_since, lanes, None);
    assert_exit_code(&verify_err(&mut bad_since.context, tx), 5);

    let mut bad_root = create_poll_fixture(115, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = bad_root.open_poll.deadline;
    set_fixture_epoch(&mut bad_root, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = bad_root.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            if index == 0 {
                after.counted_voter_lock_hashes.push([0xBB; 32]);
            }
            (
                bad_root.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut bad_root, lanes, None);
    assert_exit_code(&verify_err(&mut bad_root.context, tx), 5);

    let mut bad_capacity = create_poll_fixture(123, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = bad_capacity.open_poll.deadline;
    set_fixture_epoch(&mut bad_capacity, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = bad_capacity.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                bad_capacity.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let first_script = shard_script_for_fixture(&mut bad_capacity, 0);
    let tx = build_tally_shard_batch_finalization_tx_with_output_overrides(
        &mut bad_capacity,
        lanes,
        None,
        vec![Some((
            TALLY_SHARD_MIN_SHANNONS + 1,
            first_script.clone(),
            Some(first_script),
        ))],
    );
    assert_exit_code(&verify_err(&mut bad_capacity.context, tx), 5);

    let mut bad_lock = create_poll_fixture(124, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = bad_lock.open_poll.deadline;
    set_fixture_epoch(&mut bad_lock, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = bad_lock.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                bad_lock.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let first_script = shard_script_for_fixture(&mut bad_lock, 0);
    let wrong_lock = bad_lock
        .context
        .build_script(&bad_lock.always_success_op, Bytes::from(vec![0xF1]))
        .expect("wrong lane output lock");
    let tx = build_tally_shard_batch_finalization_tx_with_output_overrides(
        &mut bad_lock,
        lanes,
        None,
        vec![Some((
            TALLY_SHARD_MIN_SHANNONS,
            wrong_lock,
            Some(first_script),
        ))],
    );
    assert_exit_code(&verify_err(&mut bad_lock.context, tx), 5);

    let mut bad_type = create_poll_fixture(125, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = bad_type.open_poll.deadline;
    set_fixture_epoch(&mut bad_type, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = bad_type.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                bad_type.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let first_script = shard_script_for_fixture(&mut bad_type, 0);
    let wrong_type = bad_type
        .context
        .build_script(&bad_type.always_success_op, Bytes::from(vec![0xF2]))
        .expect("wrong lane output type");
    let tx = build_tally_shard_batch_finalization_tx_with_output_overrides(
        &mut bad_type,
        lanes,
        None,
        vec![Some((
            TALLY_SHARD_MIN_SHANNONS,
            first_script,
            Some(wrong_type),
        ))],
    );
    assert_exit_code(&verify_err(&mut bad_type.context, tx), 5);

    let mut extra_output = create_poll_fixture(116, MAX_ACTIVE_TALLY_SHARDS, false);
    let deadline = extra_output.open_poll.deadline;
    set_fixture_epoch(&mut extra_output, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let lanes = (0..MAX_SHARDS_PER_FINALIZE)
        .map(|index| {
            let before = extra_output.shard_data[index].clone();
            let mut after = before.clone();
            after.finalized = true;
            (
                extra_output.shard_ops[index].clone(),
                before,
                after,
                absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
            )
        })
        .collect();
    let tx = build_tally_shard_batch_finalization_tx(&mut extra_output, lanes, None);
    let hidden_script = shard_script_for_fixture(&mut extra_output, 0);
    let mut hidden_after = extra_output.shard_data[0].clone();
    hidden_after.finalized = true;
    let tx = append_output(
        tx,
        output(
            TALLY_SHARD_MIN_SHANNONS,
            hidden_script.clone(),
            Some(hidden_script),
        ),
        encode_tally_shard(&hidden_after),
    );
    assert_exit_code(&verify_err(&mut extra_output.context, tx), 5);
}

#[test]
fn direct_eight_lane_poll_close_uses_finalized_shards_and_refunds_exact_capacity() {
    let mut fixture = create_poll_fixture(120, MAX_DIRECT_CLOSE_SHARDS, false);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let shards = vec![
        finalized_shard(&mut fixture, 0, vec![2, 0], 10),
        finalized_shard(&mut fixture, 1, vec![0, 1], 30),
        finalized_shard(&mut fixture, 2, vec![1, 1], 50),
        finalized_shard(&mut fixture, 3, vec![0, 2], 70),
        finalized_shard(&mut fixture, 4, vec![3, 0], 90),
        finalized_shard(&mut fixture, 5, vec![1, 0], 110),
        finalized_shard(&mut fixture, 6, vec![0, 1], 130),
        finalized_shard(&mut fixture, 7, vec![2, 2], 150),
    ];
    let capacities = vec![
        TALLY_SHARD_MIN_SHANNONS,
        TALLY_SHARD_MIN_SHANNONS + 123,
        TALLY_SHARD_MIN_SHANNONS + 456,
        TALLY_SHARD_MIN_SHANNONS + 789,
        TALLY_SHARD_MIN_SHANNONS + 1011,
        TALLY_SHARD_MIN_SHANNONS + 1213,
        TALLY_SHARD_MIN_SHANNONS + 1415,
        TALLY_SHARD_MIN_SHANNONS + 1617,
    ];
    let mut shard_inputs = Vec::new();
    for (shard, capacity) in shards.iter().zip(capacities.iter()) {
        let (op, _) = shard_cell_with_capacity(&mut fixture, shard, *capacity);
        shard_inputs.push((op, *capacity));
    }
    let mut before_poll = fixture.open_poll.clone();
    before_poll.vote_counts = vec![9, 9];
    before_poll.total_voters = 18;
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
fn close_rejects_nonzero_reserved_pending_counter_input() {
    let mut fixture = create_poll_fixture(121, MAX_DIRECT_CLOSE_SHARDS, true);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let mut before_poll = fixture.open_poll.clone();
    before_poll.pending_intent_count = 1;
    let after_poll = closed_poll_from_result(&before_poll, vec![0, 0], 0);
    let tx = close_poll_with_inputs_tx_at_since(
        &mut fixture,
        before_poll,
        after_poll,
        true,
        Vec::new(),
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn direct_small_poll_close_rejects_bad_shard_sets_and_auth() {
    let mut unfinalized = create_poll_fixture(130, 2, false);
    let deadline = unfinalized.open_poll.deadline;
    set_fixture_epoch(&mut unfinalized, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut missing, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut duplicate, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut wrong_poll, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut no_auth, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    let tx = close_poll_with_inputs_tx_at_since(
        &mut no_auth,
        before,
        after,
        false,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
        absolute_epoch_since(deadline + FINALIZATION_GRACE_EPOCHS + 1),
    );
    assert_exit_code(&verify_err(&mut no_auth.context, tx), 5);
}

#[test]
fn direct_small_poll_close_rejects_extra_tally_inputs_and_large_poll_direct_close() {
    let mut extra = create_poll_fixture(140, 2, false);
    let deadline = extra.open_poll.deadline;
    set_fixture_epoch(&mut extra, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut large, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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

    let mut legacy = create_poll_fixture(142, MAX_ACTIVE_TALLY_SHARDS + 1, false);
    let deadline = legacy.open_poll.deadline;
    set_fixture_epoch(&mut legacy, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let mut shards = Vec::new();
    let mut inputs = Vec::new();
    for shard_id in 0..legacy.open_poll.shard_count {
        let shard = finalized_shard(&mut legacy, shard_id, vec![0, 0], shard_id as u8);
        let (op, _) = shard_cell_with_capacity(&mut legacy, &shard, TALLY_SHARD_MIN_SHANNONS);
        shards.push(shard);
        inputs.push((op, TALLY_SHARD_MIN_SHANNONS));
    }
    let before = legacy.open_poll.clone();
    let after = closed_poll_from_result(&before, summed_vote_counts(&shards), 0);
    let tx = close_poll_with_inputs_tx(
        &mut legacy,
        before,
        after,
        true,
        inputs,
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    assert_exit_code(&verify_err(&mut legacy.context, tx), 5);
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
    let mut built = 0u32;
    for shard_id in 0..shard_count {
        if built >= MAX_SHARDS_PER_MERGE as u32 {
            break;
        }
        if !shard_id_has_voter(&mut fixture, shard_id, seed.saturating_add(shard_id as u8)) {
            continue;
        }
        let shard = finalized_shard(
            &mut fixture,
            shard_id,
            vec![u64::from((built % 3) + 1), u64::from(shard_id % 2)],
            seed.saturating_add(shard_id as u8),
        );
        let capacity = TALLY_SHARD_MIN_SHANNONS + u64::from(shard_id);
        let (op, _) = shard_cell_with_capacity(&mut fixture, &shard, capacity);
        shards.push(shard);
        ops.push(op);
        total_capacity += capacity;
        built += 1;
    }
    let result = merge_result_for_shards(fixture.poll_type_hash, &shards, 1);
    (fixture, shards, ops, result, total_capacity)
}

fn merge_sixteen_shard_fixture(
    seed: u8,
) -> (
    PollFixture,
    Vec<TallyShardData>,
    Vec<OutPoint>,
    TallyMergeResultData,
    u64,
) {
    merge_fixture(seed, MAX_ACTIVE_TALLY_SHARDS)
}

fn merge_fixture_with_count(
    seed: u8,
    shard_count: u32,
) -> (PollFixture, Vec<TallyShardData>, Vec<OutPoint>, Vec<u64>) {
    let mut fixture = create_poll_fixture(400, shard_count, false);
    let mut shards = Vec::new();
    let mut ops = Vec::new();
    let mut capacities = Vec::new();
    for shard_id in 0..fixture.open_poll.shard_count {
        let vote_counts = vec![u64::from((shard_id % 3) + 1), u64::from((shard_id + 1) % 2)];
        let total_voters: u64 = vote_counts.iter().sum();
        let counted_voter_lock_hashes = (0..total_voters)
            .map(|offset| {
                let mut hash = [0u8; 32];
                hash[0] = seed;
                hash[1] = shard_id as u8;
                hash[2] = offset as u8;
                hash
            })
            .collect();
        let shard = TallyShardData {
            poll_type_hash: fixture.poll_type_hash,
            shard_id,
            shard_count: fixture.open_poll.shard_count,
            vote_counts,
            total_voters,
            counted_voter_lock_hashes,
            finalized: true,
        };
        let capacity = TALLY_SHARD_MIN_SHANNONS + u64::from(shard_id);
        let (op, _) = shard_cell_with_capacity(&mut fixture, &shard, capacity);
        shards.push(shard);
        ops.push(op);
        capacities.push(capacity);
    }
    (fixture, shards, ops, capacities)
}

#[test]
fn merge_tally_shards_happy_path_passes() {
    let (mut fixture, _, ops, result, total_capacity) = merge_sixteen_shard_fixture(10);
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
fn active_nine_lane_merge_pipeline_closes_from_complete_merge_result() {
    let (mut fixture, shards, shard_ops, capacities) =
        merge_fixture_with_count(170, MAX_DIRECT_CLOSE_SHARDS + 1);

    let partial_shards = &shards[..MAX_SHARDS_PER_MERGE];
    let partial_ops = shard_ops[..MAX_SHARDS_PER_MERGE].to_vec();
    let trailing_op = shard_ops[MAX_SHARDS_PER_MERGE].clone();
    let partial_capacity: u64 = capacities[..MAX_SHARDS_PER_MERGE].iter().sum();
    let trailing_capacity = capacities[MAX_SHARDS_PER_MERGE];

    let partial_result = merge_result_for_shards(fixture.poll_type_hash, partial_shards, 1);
    let partial_merge_tx = build_merge_tx(
        &mut fixture,
        partial_ops,
        partial_result.clone(),
        partial_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, partial_merge_tx);

    let (partial_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &partial_result, partial_capacity);
    let final_capacity = partial_capacity + trailing_capacity;
    let final_result = merge_result_for_shards(fixture.poll_type_hash, &shards, 2);
    let final_merge_tx = build_merge_tx(
        &mut fixture,
        vec![partial_result_op, trailing_op],
        final_result.clone(),
        final_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, final_merge_tx);

    let (final_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &final_result, final_capacity);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
    let before = fixture.open_poll.clone();
    let after = closed_poll_from_result(
        &before,
        final_result.vote_counts.clone(),
        final_result.total_voters,
    );
    let close_tx = close_poll_with_inputs_tx(
        &mut fixture,
        before,
        after,
        true,
        vec![(final_result_op, final_capacity)],
        Vec::new(),
        Vec::new(),
        CREATOR_DEPOSIT_SHANNONS,
    );
    verify_ok(&mut fixture.context, close_tx);
}

#[test]
fn merge_result_first_then_shard_input_still_merges() {
    let (mut fixture, shards, shard_ops, capacities) =
        merge_fixture_with_count(41, MAX_DIRECT_CLOSE_SHARDS + 1);
    let partial_shards = &shards[..MAX_SHARDS_PER_MERGE];
    let partial_ops = shard_ops[..MAX_SHARDS_PER_MERGE].to_vec();
    let trailing_op = shard_ops[MAX_SHARDS_PER_MERGE].clone();
    let partial_capacity: u64 = capacities[..MAX_SHARDS_PER_MERGE].iter().sum();
    let trailing_capacity = capacities[MAX_SHARDS_PER_MERGE];

    let partial_result = merge_result_for_shards(fixture.poll_type_hash, partial_shards, 1);
    let partial_merge_tx = build_merge_tx(
        &mut fixture,
        partial_ops,
        partial_result.clone(),
        partial_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, partial_merge_tx);

    let (partial_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &partial_result, partial_capacity);
    let final_capacity = partial_capacity + trailing_capacity;
    let final_result = merge_result_for_shards(fixture.poll_type_hash, &shards, 2);
    let final_merge_tx = build_merge_tx(
        &mut fixture,
        vec![partial_result_op, trailing_op],
        final_result.clone(),
        final_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, final_merge_tx);
}

#[test]
fn shard_first_then_merge_result_input_merges_after_lock_fix() {
    let (mut fixture, shards, shard_ops, capacities) =
        merge_fixture_with_count(72, MAX_DIRECT_CLOSE_SHARDS + 1);
    let partial_shards = &shards[..MAX_SHARDS_PER_MERGE];
    let partial_ops = shard_ops[..MAX_SHARDS_PER_MERGE].to_vec();
    let trailing_op = shard_ops[MAX_SHARDS_PER_MERGE].clone();
    let partial_capacity: u64 = capacities[..MAX_SHARDS_PER_MERGE].iter().sum();
    let trailing_capacity = capacities[MAX_SHARDS_PER_MERGE];

    let partial_result = merge_result_for_shards(fixture.poll_type_hash, partial_shards, 1);
    let partial_merge_tx = build_merge_tx(
        &mut fixture,
        partial_ops,
        partial_result.clone(),
        partial_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, partial_merge_tx);

    let (partial_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &partial_result, partial_capacity);
    let final_capacity = partial_capacity + trailing_capacity;
    let final_result = merge_result_for_shards(fixture.poll_type_hash, &shards, 2);
    let final_merge_tx = build_merge_tx(
        &mut fixture,
        vec![trailing_op, partial_result_op],
        final_result.clone(),
        final_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, final_merge_tx);
}

#[test]
fn two_partial_merge_results_compose_into_one_complete_result() {
    let (mut fixture, shards, shard_ops, capacities) =
        merge_fixture_with_count(173, MAX_ACTIVE_TALLY_SHARDS);
    let first_shards = &shards[..MAX_SHARDS_PER_MERGE];
    let second_shards = &shards[MAX_SHARDS_PER_MERGE..MAX_ACTIVE_TALLY_SHARDS as usize];
    let first_ops = shard_ops[..MAX_SHARDS_PER_MERGE].to_vec();
    let second_ops = shard_ops[MAX_SHARDS_PER_MERGE..MAX_ACTIVE_TALLY_SHARDS as usize].to_vec();
    let first_capacity: u64 = capacities[..MAX_SHARDS_PER_MERGE].iter().sum();
    let second_capacity: u64 = capacities[MAX_SHARDS_PER_MERGE..MAX_ACTIVE_TALLY_SHARDS as usize]
        .iter()
        .sum();

    let first_result = merge_result_for_shards(fixture.poll_type_hash, first_shards, 1);
    let first_merge_tx = build_merge_tx(
        &mut fixture,
        first_ops,
        first_result.clone(),
        first_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, first_merge_tx);

    let second_result = merge_result_for_shards(fixture.poll_type_hash, second_shards, 1);
    let second_merge_tx = build_merge_tx(
        &mut fixture,
        second_ops,
        second_result.clone(),
        second_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, second_merge_tx);

    let (first_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &first_result, first_capacity);
    let (second_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &second_result, second_capacity);
    let final_capacity = first_capacity + second_capacity;
    let final_result = merge_result_for_shards(fixture.poll_type_hash, &shards, 2);
    let final_merge_tx = build_merge_tx(
        &mut fixture,
        vec![first_result_op, second_result_op],
        final_result,
        final_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut fixture.context, final_merge_tx);
}

#[test]
fn merge_tally_shards_rejects_bad_shard_inputs_and_overlap() {
    let (mut unfinalized, mut shards, _ops, result, total_capacity) =
        merge_sixteen_shard_fixture(20);
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

    let (mut wrong_poll, mut shards, _ops, result, total_capacity) =
        merge_sixteen_shard_fixture(21);
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

    let (mut duplicate, shards, _ops, _result, _total_capacity) = merge_sixteen_shard_fixture(22);
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

    // Each partial result is valid on its own. Their shared lane makes the
    // combined result invalid even if its output claims only unique coverage.
    let (mut overlapping_results, shards, shard_ops, capacities) =
        merge_fixture_with_count(23, MAX_ACTIVE_TALLY_SHARDS);
    let first_shards = &shards[..MAX_SHARDS_PER_MERGE];
    let second_shards = &shards[(MAX_SHARDS_PER_MERGE - 1)..15];
    let first_capacity: u64 = capacities[..MAX_SHARDS_PER_MERGE].iter().sum();
    let second_capacity: u64 = capacities[(MAX_SHARDS_PER_MERGE - 1)..15].iter().sum();
    let first_result = merge_result_for_shards(overlapping_results.poll_type_hash, first_shards, 1);
    let second_result =
        merge_result_for_shards(overlapping_results.poll_type_hash, second_shards, 1);
    let first_tx = build_merge_tx(
        &mut overlapping_results,
        shard_ops[..MAX_SHARDS_PER_MERGE].to_vec(),
        first_result.clone(),
        first_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut overlapping_results.context, first_tx);
    let second_tx = build_merge_tx(
        &mut overlapping_results,
        shard_ops[(MAX_SHARDS_PER_MERGE - 1)..15].to_vec(),
        second_result.clone(),
        second_capacity,
        None,
        None,
        None,
        false,
    );
    verify_ok(&mut overlapping_results.context, second_tx);

    let (first_result_op, _) =
        merge_cell_with_capacity(&mut overlapping_results, &first_result, first_capacity);
    let (second_result_op, _) =
        merge_cell_with_capacity(&mut overlapping_results, &second_result, second_capacity);
    let claimed_unique_result =
        merge_result_for_shards(overlapping_results.poll_type_hash, &shards[..15], 2);
    let tx = build_merge_tx(
        &mut overlapping_results,
        vec![first_result_op, second_result_op],
        claimed_unique_result,
        first_capacity + second_capacity,
        None,
        None,
        None,
        false,
    );
    assert_exit_code(&verify_err(&mut overlapping_results.context, tx), 5);
}

#[test]
fn merge_tally_shards_rejects_wrong_result_shape_and_scripts() {
    let (mut wrong_totals, _, ops, mut result, total_capacity) = merge_sixteen_shard_fixture(30);
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

    let (mut wrong_coverage, _, ops, mut result, total_capacity) = merge_sixteen_shard_fixture(31);
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

    let (mut wrong_lock, _, ops, result, total_capacity) = merge_sixteen_shard_fixture(32);
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

    let (mut missing_input_type, _shards, _, input_result, total_capacity) =
        merge_sixteen_shard_fixture(32);
    let (good_result_op, _) =
        merge_cell_with_capacity(&mut missing_input_type, &input_result, total_capacity);
    let bad_input_lock = merge_script_for_fixture(&mut missing_input_type);
    let bad_input_op = missing_input_type.context.create_cell(
        output(total_capacity, bad_input_lock, None),
        encode_tally_merge_result(&input_result),
    );
    let mut output_result = input_result.clone();
    output_result.merge_level += 1;
    let tx = build_merge_tx(
        &mut missing_input_type,
        vec![good_result_op, bad_input_op],
        output_result,
        total_capacity * 2,
        None,
        None,
        None,
        false,
    );
    let err = verify_err(&mut missing_input_type.context, tx);
    assert_exit_code(&err, 5);
    assert!(
        err.to_string().contains("Inputs[0].Lock"),
        "missing merge input type must fail in the merge lock group: {err}"
    );

    let (mut wrong_input_type, _shards, _, input_result, total_capacity) =
        merge_sixteen_shard_fixture(35);
    let (good_result_op, _) =
        merge_cell_with_capacity(&mut wrong_input_type, &input_result, total_capacity);
    let bad_input_lock = merge_script_for_fixture(&mut wrong_input_type);
    let harmless_type = wrong_input_type
        .context
        .build_script(&wrong_input_type.always_success_op, Bytes::from(vec![0xB2]))
        .expect("harmless wrong merge input type");
    let bad_input_op = wrong_input_type.context.create_cell(
        output(total_capacity, bad_input_lock, Some(harmless_type)),
        encode_tally_merge_result(&input_result),
    );
    let mut output_result = input_result.clone();
    output_result.merge_level += 1;
    let tx = build_merge_tx(
        &mut wrong_input_type,
        vec![good_result_op, bad_input_op],
        output_result,
        total_capacity * 2,
        None,
        None,
        None,
        false,
    );
    let err = verify_err(&mut wrong_input_type.context, tx);
    assert_exit_code(&err, 5);
    assert!(
        err.to_string().contains("Inputs[0].Lock"),
        "wrong merge input type must fail in the merge lock group: {err}"
    );

    let (mut wrong_type, _, ops, result, total_capacity) = merge_sixteen_shard_fixture(33);
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

    let (mut extra_output, _, ops, result, total_capacity) = merge_sixteen_shard_fixture(34);
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
fn merge_tally_shards_rejects_singleton_shard_wrap() {
    let mut fixture = create_poll_fixture(199, 9, false);
    let shard = finalized_shard(&mut fixture, 0, vec![1, 0], 0x99);
    let (shard_op, _) = shard_cell_with_capacity(&mut fixture, &shard, TALLY_SHARD_MIN_SHANNONS);
    let result = merge_result_for_shards(fixture.poll_type_hash, &[shard], 1);
    let tx = build_merge_tx(
        &mut fixture,
        vec![shard_op],
        result,
        TALLY_SHARD_MIN_SHANNONS,
        None,
        None,
        None,
        false,
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn merge_tally_shards_rejects_singleton_result_rewrap() {
    let mut fixture = create_poll_fixture(199, 9, false);
    let partial_shards = vec![
        finalized_shard(&mut fixture, 0, vec![1, 0], 0xA0),
        finalized_shard(&mut fixture, 1, vec![0, 1], 0xA1),
    ];
    let partial_result = merge_result_for_shards(fixture.poll_type_hash, &partial_shards, 1);
    let partial_capacity = TALLY_MERGE_RESULT_MIN_SHANNONS + 123;
    let (partial_result_op, _) =
        merge_cell_with_capacity(&mut fixture, &partial_result, partial_capacity);
    let mut replacement_result = partial_result.clone();
    replacement_result.merge_level += 1;
    let tx = build_merge_tx(
        &mut fixture,
        vec![partial_result_op],
        replacement_result,
        partial_capacity,
        None,
        None,
        None,
        false,
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
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
    let mut fixture = create_poll_fixture(u64::from(seed) + 220, MAX_ACTIVE_TALLY_SHARDS, false);
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
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut incomplete, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    set_fixture_epoch(&mut wrong_poll, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
fn seventeen_lane_poll_cannot_use_hardened_merge_close_path() {
    let (mut fixture, shards, result, result_op, result_capacity) = large_close_fixture(29);
    fixture.open_poll.shard_count = MAX_ACTIVE_TALLY_SHARDS + 1;
    replace_fixture_poll_input(&mut fixture);
    let deadline = fixture.open_poll.deadline;
    set_fixture_epoch(&mut fixture, deadline + FINALIZATION_GRACE_EPOCHS + 1);
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
    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
    let _ = shards;
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
    shards: Vec<TallyShardData>,
    result: TallyMergeResultData,
    output_data: Bytes,
) -> ckb_testtool::ckb_types::core::TransactionView {
    let mut inputs = Vec::new();
    let mut locked_capacity = 0u64;
    for shard in shards {
        let (op, _) = shard_cell_with_capacity(fixture, &shard, TALLY_SHARD_MIN_SHANNONS);
        inputs.push(op);
        locked_capacity += TALLY_SHARD_MIN_SHANNONS;
    }
    build_merge_tx(
        fixture,
        inputs,
        result,
        locked_capacity,
        None,
        None,
        Some(output_data),
        false,
    )
}

#[test]
fn codec_canonicality_rejects_trailing_bytes_in_vm() {
    let mut poll_fixture = fixture(260);
    let poll_tx = create_poll_tx(
        &mut poll_fixture,
        1,
        None,
        false,
        false,
        false,
        [0u8; 32],
        None,
    );
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
    let tx = merge_tx_with_output_data(
        &mut bad_merge,
        vec![shards[0].clone(), shards[1].clone()],
        result,
        output_data,
    );
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
fn delegation_creation_requires_revocation_only_zero_expiry() {
    let mut fixture = create_poll_fixture(279, 2, false);
    let delegator_hash = script_hash(&fixture.always_success);
    let base = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: [0xD0; 32],
        poll_type_hash: fixture.poll_type_hash,
        expires_epoch: 0,
    };
    let valid = create_delegation_tx_with_output_data(&mut fixture, encode_delegation(&base));
    verify_ok(&mut fixture.context, valid);

    let mut expiring = base;
    expiring.expires_epoch = fixture.epoch + 10;
    let tx = create_delegation_tx_with_output_data(&mut fixture, encode_delegation(&expiring));
    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn delegation_creation_rejects_additional_same_or_different_scope_output() {
    let mut same_scope = create_poll_fixture(279, 2, false);
    let base = DelegationData {
        delegator_lock_hash: script_hash(&same_scope.always_success),
        delegate_lock_hash: [0xD1; 32],
        poll_type_hash: same_scope.poll_type_hash,
        expires_epoch: 0,
    };
    let tx = create_delegation_tx_with_output_data(&mut same_scope, encode_delegation(&base));
    verify_ok(&mut same_scope.context, tx.clone());
    let extra_output = tx.outputs().get(0).expect("delegation output");
    let extra_data = tx
        .outputs_data()
        .get(0)
        .expect("delegation data")
        .raw_data();
    let tx = append_output(tx, extra_output, extra_data);
    assert_exit_code(&verify_err(&mut same_scope.context, tx), 5);

    let mut different_scope = create_poll_fixture(279, 2, false);
    let base = DelegationData {
        delegator_lock_hash: script_hash(&different_scope.always_success),
        delegate_lock_hash: [0xD2; 32],
        poll_type_hash: different_scope.poll_type_hash,
        expires_epoch: 0,
    };
    let tx = create_delegation_tx_with_output_data(&mut different_scope, encode_delegation(&base));
    let other_scope = [0xAB; 32];
    let other_type = delegate_script(
        &mut different_scope.context,
        &different_scope.governance_op,
        &other_scope,
    );
    let other = DelegationData {
        poll_type_hash: other_scope,
        ..base
    };
    let tx = append_output(
        tx,
        output(
            DELEGATION_MIN_SHANNONS,
            different_scope.always_success.clone(),
            Some(other_type),
        ),
        encode_delegation(&other),
    );
    assert_exit_code(&verify_err(&mut different_scope.context, tx), 5);
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
        expires_epoch: 0,
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

    let expiring_delegation = DelegationData {
        delegator_lock_hash: delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash,
        expires_epoch: epoch + 5,
    };
    let expiring_op = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        expiring_delegation,
        DELEGATION_MIN_SHANNONS,
    );
    // Even with the old pre-deadline header still selected as HeaderDep(0), a
    // nonzero legacy expiry cannot be used in the revocation-only v1 protocol.
    insert_epoch_header(&mut fixture.context, fixture.open_poll.deadline + 1);
    let expiring = build_create_intent_tx(
        &mut fixture,
        delegate_op.clone(),
        delegate_lock.clone(),
        delegator_hash,
        delegator_lock.clone(),
        0,
        epoch,
        None,
        None,
        Some(expiring_op),
    );
    assert_exit_code(&verify_err(&mut fixture.context, expiring), 5);

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
fn delegated_vote_rejects_dep_lock_hash_mismatch() {
    let mut fixture = create_poll_fixture(281, 2, false);
    let actual_dep_lock = fixture.always_success.clone();
    let claimed_delegator_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xE1]))
        .expect("claimed delegator lock");
    let delegate_lock = fixture
        .context
        .build_script(&fixture.always_success_op, Bytes::from(vec![0xE2]))
        .expect("delegate lock");
    let claimed_delegator_hash = script_hash(&claimed_delegator_lock);
    let delegate_hash = script_hash(&delegate_lock);
    let delegate_op = plain_cell(
        &mut fixture.context,
        delegate_lock.clone(),
        2_000 * SHANNONS_PER_CKB,
    );
    let delegation = DelegationData {
        delegator_lock_hash: claimed_delegator_hash,
        delegate_lock_hash: delegate_hash,
        poll_type_hash: fixture.poll_type_hash,
        expires_epoch: 0,
    };
    let delegation_op = delegation_cell(
        &mut fixture,
        actual_dep_lock.clone(),
        delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let tx = build_create_intent_tx(
        &mut fixture,
        delegate_op,
        delegate_lock.clone(),
        claimed_delegator_hash,
        actual_dep_lock,
        0,
        0,
        None,
        None,
        Some(delegation_op),
    );

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
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

#[test]
fn delegation_revocation_rejects_additional_same_group_input() {
    let mut fixture = create_poll_fixture(286, 2, false);
    let delegator_lock = fixture.always_success.clone();
    let delegation = DelegationData {
        delegator_lock_hash: script_hash(&delegator_lock),
        delegate_lock_hash: [0x23; 32],
        poll_type_hash: fixture.poll_type_hash,
        expires_epoch: 0,
    };
    let first = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        delegation.clone(),
        DELEGATION_MIN_SHANNONS,
    );
    let second = delegation_cell(
        &mut fixture,
        delegator_lock.clone(),
        delegation,
        DELEGATION_MIN_SHANNONS,
    );
    let tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(first))
            .input(input(second))
            .output(output(DELEGATION_MIN_SHANNONS, delegator_lock, None))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack())
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();

    assert_exit_code(&verify_err(&mut fixture.context, tx), 5);
}

#[test]
fn retired_aggregate_votes_opcode_is_rejected() {
    let mut fixture = fixture(290);
    let retired_type = governance_script(&mut fixture, OP_RETIRED_AGGREGATE_VOTES, &[0x03; 32]);
    let seed_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        1_000 * SHANNONS_PER_CKB,
    );
    let tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(seed_op))
            .output(output(
                1_000 * SHANNONS_PER_CKB,
                fixture.always_success.clone(),
                Some(retired_type),
            ))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();

    assert_exit_code(&verify_err(&mut fixture.context, tx), 6);
}

#[test]
fn retired_revoke_delegation_opcode_is_rejected() {
    let mut fixture = fixture(291);
    let retired_type = governance_script(&mut fixture, OP_RETIRED_REVOKE_DELEGATION, &[0x06; 32]);
    let seed_op = plain_cell(
        &mut fixture.context,
        fixture.always_success.clone(),
        1_000 * SHANNONS_PER_CKB,
    );
    let tx = tx_with_header(
        TransactionBuilder::default()
            .input(input(seed_op))
            .output(output(
                1_000 * SHANNONS_PER_CKB,
                fixture.always_success.clone(),
                Some(retired_type),
            ))
            .output_data(Bytes::new().pack())
            .cell_dep(cell_dep(fixture.governance_op.clone()))
            .cell_dep(cell_dep(fixture.always_success_op.clone()))
            .witness(blank_witness().pack()),
        fixture.header_hash.clone(),
    )
    .build();

    assert_exit_code(&verify_err(&mut fixture.context, tx), 6);
}
