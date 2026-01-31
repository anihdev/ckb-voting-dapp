# CKB Voting dApp

A full-stack decentralized voting application built on Nervos CKB, demonstrating on-chain vote storage, transparent counting, and immutable results.

## Overview

This project teaches core CKB development concepts through a production-like voting system:

- **Type Scripts** for enforcing voting rules
- **Cell Model** for state management
- **Time-based Access Control** for poll deadlines
- **On-chain Vote Aggregation** for transparent counting

## Features

### Core Functionality
- Create Poll - Binary Yes/No voting
- Cast Vote - One vote per user per poll
- View Results - Real-time vote counting
- Close Poll - Creator-triggered finalization
- Immutable History - All votes on-chain

## Architecture

```
┌─────────────────────────────────────────────────────┐
│            Frontend (Next.js + CCC SDK)             │
│  Poll Creation • Voting • Results Display           │
└──────────────────┬──────────────────────────────────┘
                   │ CCC SDK
                   │
┌──────────────────▼──────────────────────────────────┐
│           CKB Blockchain Layer                      │
│                                                      │
│  Poll Cell → Type Script Validation                │
│  Vote Cell → Vote Recording & Counting             │
│  voting_script → Core Business Logic               │
└───────────────────────────────────────────────────────┘
```

## Prerequisites

- Node.js ≥ 18.0.0
- pnpm ≥ 8.0.0
- OffCKB ≥ 0.4.0 (local devnet)
- Basic TypeScript/JavaScript knowledge
- Familiarity with CKB cell model


### Clone
```bash
git clone https://github.com/anihdev/ckb-voting-dapp.git
cd ckb-voting-dapp
pnpm install
```

## Cell Structure

### Poll Cell
```typescript
{
  capacity: "200 CKB",
  lock: {...},           // Creator's lock
  type: {
    codeHash: "...",     // voting_script
    args: "0x..."        // Poll ID
  },
  data: {
    poll_id: Byte32,
    question: Bytes,
    deadline: Uint64,
    status: byte,        // 0=active, 1=closed
    yes_count: Uint32,
    no_count: Uint32,
    creator: Bytes
  }
}
```

### Vote Cell
```typescript
{
  capacity: "150 CKB",
  lock: {...},           // Voter's lock
  type: {
    codeHash: "...",     // voting_script
    args: "0x..."        // Same Poll ID
  },
  data: {
    poll_id: Byte32,
    voter: Bytes,
    vote: byte,          // 0=no, 1=yes
    timestamp: Uint64
  }
}
```

## Script Validation

The voting script validates three operations:

**1. Create Poll**
- Validate poll structure and metadata
- Check deadline is in future
- Initialize vote counts to 0

**2. Cast Vote**
- Verify poll is active
- Check deadline not passed
- Prevent double voting
- Increment vote count

**3. Close Poll**
- Verify deadline passed or creator initiates
- Only creator can close
- Preserve vote counts
- Change status to closed

## License

MIT License

## Acknowledgments

- Nervos Foundation for CKB
- OffCKB team for developer tools
- CCC SDK contributors
