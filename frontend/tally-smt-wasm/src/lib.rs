use blake2b_ref::{Blake2b, Blake2bBuilder};
use js_sys::Uint8Array;
use sparse_merkle_tree::{
    default_store::DefaultStore, traits::Hasher, H256, SparseMerkleTree,
};
use wasm_bindgen::{prelude::*, throw_str};

const PRESENT_VALUE: [u8; 32] = [1u8; 32];

struct CkbBlake2bHasher(Blake2b);

impl Default for CkbBlake2bHasher {
    fn default() -> Self {
        Self(
            Blake2bBuilder::new(32)
                .personal(b"ckb-default-hash")
                .build(),
        )
    }
}

impl Hasher for CkbBlake2bHasher {
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

type TallySmt = SparseMerkleTree<CkbBlake2bHasher, H256, DefaultStore<H256>>;

fn key_from_js(key: &Uint8Array) -> H256 {
    let bytes: [u8; 32] = key
        .to_vec()
        .try_into()
        .unwrap_or_else(|_| throw_str("tally SMT keys must be exactly 32 bytes"));
    bytes.into()
}

#[wasm_bindgen]
#[derive(Default)]
pub struct TallySmtProvider {
    tree: TallySmt,
}

#[wasm_bindgen]
impl TallySmtProvider {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self::default()
    }

    /// Insert one already-counted represented voter while reconstructing a lane.
    pub fn insert_present(&mut self, key: &Uint8Array) {
        if let Err(error) = self
            .tree
            .update(key_from_js(key), H256::from(PRESENT_VALUE))
        {
            throw_str(&format!("tally SMT update failed: {error:?}"));
        }
    }

    pub fn root(&self) -> Uint8Array {
        Uint8Array::from(self.tree.root().as_slice())
    }

    /// Build one compiled non-membership/update multiproof for the pending keys.
    /// The CKB contract replays it against zero old leaves and present new leaves.
    pub fn compile_transition_proof(&self, keys: Vec<Uint8Array>) -> Uint8Array {
        let keys: Vec<H256> = keys.iter().map(key_from_js).collect();
        let proof = self
            .tree
            .merkle_proof(keys.clone())
            .and_then(|proof| proof.compile(keys))
            .unwrap_or_else(|error| throw_str(&format!("tally SMT proof failed: {error:?}")));
        Uint8Array::from(proof.0.as_slice())
    }
}
