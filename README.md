# CKB Governance Protocol

**On-chain governance with economic skin-in-the-game, vote delegation, and full UTXO lifecycle**

Built on Nervos CKB using ckb-js-vm type scripts. Demonstrates how CKB's cell model enables governance mechanics that are native to UTXO architecture — deposit locking, vote receipt cells, delegation, and atomic multi-party deposit returns — without any separate escrow or auxiliary contracts.

---

## Why CKB Specifically

Most governance protocols on EVM work like databases — a contract stores vote counts in a mapping and emits events. CKB works differently: **every vote is a cell with locked value**. This has real consequences:

| Property | EVM Governance | CKB Governance (this protocol) |
|---|---|---|
| Spam prevention | Gas cost only | Creator locks 500 CKB deposit |
| Vote records | Mapping in contract storage | Individual UTXO cells per vote |
| Deposit return | Requires separate withdraw call | Atomic at poll close — one transaction |
| Vote weight | Address equality or token balance | Lock hash identity or xUDT balance |
| Delegation | Separate contract or off-chain sig | First-class delegation cell on-chain |
| State verification | Trust the contract mapping | Read cell data directly, verify yourself |

The deposit return is the key insight. When a poll closes, the creator's 500 CKB deposit and every voter's 61 CKB deposit are returned **in the same closing transaction**. The type script verifies this atomically. No second step, no withdrawal queue.

This is not possible on EVM without a separate escrow contract. On CKB, the deposit **is** the cell capacity — the mechanism is native.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    CKB BLOCKCHAIN (TESTNET)                       │
│                                                                    │
│  Poll Cell                Vote Receipt Cells        Delegation     │
│  ──────────               ─────────────────        Cells          │
│  capacity: 561+ CKB       capacity: 61 CKB each    ──────────     │
│  type: governance         type: governance          capacity: 61CKB│
│  data: PollData           data: VoteData            data: Delegat- │
│    question               voter_lock_hash           ionData        │
│    options[]              option_index              delegator_hash │
│    vote_counts[]          voted_at_epoch            delegate_hash  │
│    deadline               poll_type_hash            expires_epoch  │
│    creator (lock hash)                                             │
│    creator_deposit                                                 │
│    is_closed                                                       │
│    total_voters                                                    │
└────────────────────────────┬─────────────────────────────────────┘
                             │ @ckb-ccc/core  (findCells + transactions)
┌────────────────────────────▼─────────────────────────────────────┐
│                    FRONTEND (Vite + React + CCC)                  │
│  Poll creation · Voting · Delegation · Live results              │
└──────────────────────────────────────────────────────────────────┘
```

---

## Cell Lifecycle

This is the complete state machine every poll goes through:

```
CREATE_POLL
  └─→ Poll Cell created (creator deposit locked in capacity)
      Poll Cell: is_closed=false, vote_counts=[0,0,...], total_voters=0

CAST_VOTE (repeats per voter)
  └─→ Poll Cell consumed → updated Poll Cell (vote_counts incremented)
      Vote Receipt Cell created (voter deposit locked in capacity)
      [Optional] Delegation Cell consumed as proof of voting authority

CLOSE_POLL
  └─→ Poll Cell (open) consumed → Poll Cell (closed) created
      Creator auth cell consumed
      All Vote Receipt Cells consumed
      Creator deposit returned to creator's lock
      Each voter deposit returned to voter's lock hash
      Everything in ONE atomic transaction
```

The closing transaction is the moment CKB's UTXO model shines: multiple cells consumed, multiple deposits returned, verified by the type script in a single atomic operation. No loops, no second transactions, no trust required.

---

## Operations

### CREATE_POLL (`0x01`)

Creates a governance poll with a mandatory creator deposit.

**Transaction layout:**
```
Inputs:  [creator_cell, ...]
Outputs: [poll_cell(0), change_cell?]
```

**Type script enforces:**
- Question: 1–256 bytes
- Options: 2–10, each 1–64 bytes
- `vote_counts`: all zero at creation
- `total_voters`: zero at creation
- `is_closed`: false
- `deadline`: must be a future epoch, within 1–1000 epoch range
- `creator_deposit` in cell data ≥ 500 CKB (50,000,000,000 shannons)
- Cell `capacity` ≥ creator_deposit + data overhead

The deposit is embedded in the cell's own capacity. No escrow contract. No external trust.

---

### CAST_VOTE (`0x02`)

Casts a vote on an active poll. Supports direct votes and delegated votes.

**Transaction layout (direct):**
```
Inputs:  [poll_cell(0), voter_cell(1)]
Outputs: [updated_poll(0), vote_receipt(1), change?]
```

**Transaction layout (via delegation):**
```
Inputs:  [poll_cell(0), signer_cell(1), delegation_cell(2)]
Outputs: [updated_poll(0), vote_receipt(1), change?]
```

**Type script enforces:**
- Poll not closed, not past deadline
- `option_index` from witness: must be valid index
- If delegation cell present at input 2: signer must be the registered delegate, vote is recorded under delegator's lock hash
- Vote receipt capacity ≥ 61 CKB (voter deposit)
- Poll state transition: only `vote_counts[optionIndex]` and `total_voters` increment — all other fields frozen

---

### CLOSE_POLL (`0x03`)

Closes the poll and returns all deposits atomically.

**Transaction layout:**
```
Inputs:  [poll_cell(0), creator_auth(1), vote_receipt_0?, vote_receipt_1?, ...]
Outputs: [closed_poll(0), creator_return(1), voter_return_0?, voter_return_1?, ...]
```

**Type script enforces:**
- Creator auth lock hash == `poll.creator`
- Output poll has `is_closed = true`, all other fields frozen
- Creator return output ≥ `creator_deposit` shannons, sent to creator's lock hash
- For each vote receipt input consumed: a corresponding output returns ≥ 61 CKB to the voter's `lock_hash`

Any participant can initiate the closing transaction (it is permissioned to creator only for the authority check). The deposit returns are verified by the script — they cannot be skipped or redirected.

---

### DELEGATE (`0x04`)

Creates a scoped delegation cell assigning voting authority to another address.

**Transaction layout:**
```
Inputs:  [delegator_cell(0), ...]
Outputs: [delegation_cell(0), change?]
```

**Delegation cell data:**
```typescript
{
  delegator_lock_hash: Uint8Array  // 32 bytes — who delegates
  delegate_lock_hash:  Uint8Array  // 32 bytes — who receives voting power
  poll_type_hash:      Uint8Array  // 32 bytes — 0x00...00 = applies to all polls
  expires_epoch:       bigint      // 0 = no expiry
}
```

**Type script enforces:**
- `delegator_lock_hash` must match the signing input cell's lock hash (self-authenticated)
- Cannot delegate to yourself
- If `expires_epoch > 0`: must be a future epoch

Delegations are scoped per poll (`poll_type_hash`) or global (`0x00...`). A delegate can vote on any poll the delegation covers by including the delegation cell as input 2 in a CAST_VOTE transaction.

---

## Cell Data Encoding

All cell data uses a custom binary encoding with little-endian u64 values (same pattern as CKB Position Guardian's collateral cells):

```typescript
// PollData layout
encodeString(question)       // uint32_LE(len) || utf8_bytes
encodeStringVec(options)     // uint32_LE(count) || (uint32_LE(len) || bytes)*
encodeUint64Vec(vote_counts) // uint32_LE(count) || uint64_LE*
encodeUint64(deadline)       // uint64_LE (epoch number)
creator                      // bytes32 (lock hash)
uint8(is_closed)             // 0x00 | 0x01
encodeUint64(total_voters)
encodeUint64(creator_deposit) // shannons
uint8(token_weighted)
udt_type_hash                // bytes32 (zero if address-based)

// VoteData layout (73 bytes fixed)
poll_type_hash               // bytes32
voter_lock_hash              // bytes32
uint8(option_index)
encodeUint64(voted_at_epoch)

// DelegationData layout (104 bytes fixed)
delegator_lock_hash          // bytes32
delegate_lock_hash           // bytes32
poll_type_hash               // bytes32
encodeUint64(expires_epoch)
```

---

## Project Structure

```
ckb-voting-dapp/
├── backend/
│   ├── contract/
│   │   └── src/
│   │       ├── index.ts       # Contract: 4 operations + validation logic
│   │       ├── molecule.ts    # Encode/decode: PollData, VoteData, DelegationData
│   │       ├── types.ts       # CKB-VM type definitions
│   │       └── utils.ts       # CKB syscall wrappers
│   └── deploy/
│       ├── deploy.ts          # Deploy contract via @ckb-ccc/core
│       └── config.ts
│
├── frontend/
│   └── src/
│       ├── App.tsx
│       ├── components/
│       │   ├── CreatePoll.tsx  # Poll creation with deposit display
│       │   ├── PollList.tsx    # Off-chain indexer query via findCells
│       │   ├── VoteOnPoll.tsx  # Direct vote + delegation support
│       │   ├── DelegatePower.tsx # Create delegation cells
│       │   └── WalletConnect.tsx
│       ├── hooks/
│       │   ├── useCKB.ts      # CCC client + signer
│       │   └── usePolls.ts    # findCells indexer queries
│       └── lib/
│           ├── ckb.ts         # Transaction builders
│           ├── molecule.ts    # Shared encode/decode (mirrors contract)
│           └── types.ts
│
└── tests/
    ├── contract.test.ts       # All 4 operations, deposit enforcement, delegation
    └── molecule.test.ts       # Round-trip encode/decode tests
```

---

## Setup and Development

### Prerequisites

- Node.js ≥ 18
- pnpm ≥ 8
- OffCKB ≥ 0.4.0 (local devnet)

### Install

```bash
git clone https://github.com/anihdev/ckb-voting-dapp.git
cd ckb-voting-dapp
pnpm install
```

### Local devnet

```bash
offckb start
```

This spins up a local CKB node with 1-second block times and pre-funded accounts. Much faster iteration than testnet.

### Deploy contract

```bash
cd backend/deploy
pnpm ts-node deploy.ts
# Copies contract TX hash to .env automatically
```

### Run frontend

```bash
cd frontend
pnpm dev
# Opens at http://localhost:5173
```

### Run tests

```bash
pnpm test
```

---

## Off-Chain Indexer Queries

The frontend uses `@ckb-ccc/core`'s `findCells` to discover polls without running a full node — the same pattern used in CKB Position Guardian's position fetcher:

```typescript
// Find all active polls by type script prefix
for await (const cell of client.findCells({
  script: {
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: "data1",
    args: "0x",          // prefix scan — all polls
  },
  scriptType: "type",
  scriptSearchMode: "prefix",
})) {
  const poll = decodePollData(ccc.bytesFrom(cell.outputData));
  if (!poll.is_closed) activePolls.push(poll);
}

// Find vote receipts for a specific poll
for await (const cell of client.findCells({
  script: {
    codeHash: GOVERNANCE_CODE_HASH,
    hashType: "data1",
    args: pollTypeHash,   // exact poll — all votes for this poll
  },
  scriptType: "type",
  scriptSearchMode: "exact",
})) {
  const vote = decodeVoteData(ccc.bytesFrom(cell.outputData));
  votes.push(vote);
}
```

This query is the CKB-native way to read protocol state. It scans the UTXO set by type script, not a contract mapping.

---

## Economic Model

| Action | CKB Locked | Returned When |
|---|---|---|
| Create poll | 500 CKB (creator deposit) | Poll closed |
| Cast vote | 61 CKB (voter deposit) | Poll closed, vote cell consumed |
| Create delegation | 61 CKB (cell minimum) | Delegation cell spent |

Deposits are enforced by the type script — the contract rejects any transaction that does not meet the capacity requirements. This makes spam economically irrational without any off-chain gatekeeping.

---

## Deployed Contracts

| Network | TX Hash |
|---|---|
| CKB Testnet (Pudge) | Pending deployment |
| OffCKB (local devnet) | Generated on first `offckb start` |

---

## Stack

| Layer | Technology |
|---|---|
| On-chain contract | TypeScript on ckb-js-vm (RISC-V) |
| Cell encoding | Custom Molecule-compatible binary format |
| Frontend | Vite + React + TypeScript |
| CKB SDK | @ckb-ccc/core |
| Local devnet | OffCKB |
| Tests | Jest |

---

## Roadmap

- **Token-weighted voting** — when `token_weighted = true` in PollData, vote weight = voter's xUDT balance at vote time, read via a companion UDT balance oracle cell
- **Quadratic voting** — vote weight = sqrt(token balance), enforced in contract with integer approximation
- **Fiber Network micropayment polls** — pay-per-vote polls using Fiber payment channels for instant sub-threshold fee settlement (same pattern as CKB Position Guardian's fee architecture)
- **Cross-chain governance** — RGB++ asset holders on Bitcoin voting on CKB polls via isomorphic binding

---

## Related Projects

- [CKB Position Guardian](https://github.com/anihdev/ckb-agent) — Autonomous DeFi risk agent on CKB.
---

## License

MIT