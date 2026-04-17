# CKB Governance Protocol

Deposit-backed on-chain governance on Nervos CKB with intent-cell voting, permissionless aggregation, delegation, and deterministic refunds.

This repository is built around the CKB cell model rather than an account-style voting app:

- polls are cells with locked creator deposits
- votes are independent intent cells
- aggregation updates shared tally state in batches
- delegation is encoded as a first-class cell
- close returns locked deposits through verified refund paths

The canonical protocol source is:

- [backend/contract/src/index.ts](/home/anihdev/ckb-voting-dapp/backend/contract/src/index.ts)
- [backend/contract/src/molecule.ts](/home/anihdev/ckb-voting-dapp/backend/contract/src/molecule.ts)

Everything else in the repo is expected to align to those two files.

## Verified Status

Current verified state:

- contract codec and protocol model tests pass
- frontend codec tests pass
- frontend production build passes
- delegated vote refunds use an embedded `refund_lock` script
- the UI supports poll creation, vote intents, aggregation, close, delegation, and revocation
- the frontend now performs off-chain duplicate-intent checks for the voting authorities the connected wallet controls

Verified commands:

```bash
pnpm --filter ckb-voting-contract test
pnpm --filter ckb-voting-frontend test
pnpm --filter ckb-voting-frontend build
```

## Protocol

The contract currently models six operations:

1. `CREATE_POLL`
2. `CREATE_VOTE_INTENT`
3. `AGGREGATE_VOTES`
4. `CLOSE_POLL`
5. `DELEGATE`
6. `REVOKE_DELEGATION`

### Polls

Poll cells store:

- question
- options
- per-option vote counts
- deadline
- creator lock hash
- creator deposit
- pending intent count
- token-weighting fields reserved for a later xUDT upgrade

### Vote Intents

Vote intents store:

- poll type hash
- voter lock hash
- selected option
- vote epoch
- aggregated flag
- full refund lock script

The refund lock script is important because close must be able to return deposits to the exact voter lock even when the vote was created through delegation.

### Delegation

Delegation cells store:

- delegator lock hash
- delegate lock hash
- optional poll scope
- optional expiry epoch

## Why CKB

This design uses properties that matter specifically on CKB:

- deposits live in cell capacity, not in an app-level balance table
- voting can happen without every voter fighting over the same shared cell
- the lifecycle of a vote is visible as cell creation, aggregation, and final consumption
- authority transfer is explicit through delegation cells

The main architectural move is the vote-intent pattern:

- voters create their own intent cells
- an aggregator batches those intents into the poll tally later

That removes voter-vs-voter shared-cell contention from the main voting path.

## Repository Layout

```text
ckb-voting-dapp/
├── AGENTS.md
├── README.md
├── package.json
├── pnpm-workspace.yaml
├── vercel.json
├── backend/
│   ├── contract/
│   └── deploy/
├── frontend/
│   └── src/
└── tests/
```

## Prerequisites

- Node.js 20+
- pnpm 10+
- OffCKB if you want a local CKB devnet

Install:

```bash
corepack enable
corepack prepare pnpm@latest --activate
pnpm install
pnpm approve-builds
```

Approve `esbuild` when prompted.

## Workspace Commands

From the repository root:

```bash
pnpm test
pnpm build
pnpm dev:frontend
pnpm build:contract
pnpm build:frontend
pnpm deploy:contract
```

## Environment Variables

Use [.env.example](/home/anihdev/ckb-voting-dapp/.env.example) as the base template.

### Frontend

```env
VITE_GOVERNANCE_CODE_HASH=0x...
VITE_GOVERNANCE_SCRIPT_TX_HASH=0x...
VITE_CKB_RPC_URL=https://testnet.ckb.dev/rpc
```

What each value is for:

- `VITE_GOVERNANCE_CODE_HASH`: the deployed governance script code hash; the frontend uses this to discover protocol cells and build matching type scripts
- `VITE_GOVERNANCE_SCRIPT_TX_HASH`: the transaction hash that created the script cell; useful for explorer links and deployment bookkeeping
- `VITE_CKB_RPC_URL`: the public CKB RPC endpoint used by the hosted dApp

Without the correct `VITE_GOVERNANCE_CODE_HASH`, the frontend cannot find your live polls, intents, or delegations.

### Backend Deploy

```env
CKB_PRIVATE_KEY=0x...
```

This is only for deployment or seeding scripts. Do not expose it in Vercel.

## Contract Deployment

Build and deploy the contract:

```bash
pnpm build:contract
CKB_PRIVATE_KEY=0x... pnpm deploy:contract
```

The deploy script prints the resulting code hash and transaction hash. Put those values into your frontend environment.

Relevant files:

- [backend/deploy/deploy.ts](/home/anihdev/ckb-voting-dapp/backend/deploy/deploy.ts)
- [backend/deploy/config.ts](/home/anihdev/ckb-voting-dapp/backend/deploy/config.ts)

## Vercel Hosting

The repo now includes [vercel.json](/home/anihdev/ckb-voting-dapp/vercel.json), so Vercel can build the frontend from the monorepo root without guessing paths.

Current Vercel settings encoded in the repo:

- install command: `pnpm install --frozen-lockfile`
- build command: `pnpm build:frontend`
- output directory: `frontend/src/dist`
- SPA rewrite to `index.html`

### Deploy To Vercel

1. Push the repository to GitHub.
2. Import the repo into Vercel.
3. Keep the project root as the repository root.
4. Add the frontend env vars from `.env.example`.
5. Deploy.

### Required Vercel Environment Variables

Add these in the Vercel dashboard:

```env
VITE_GOVERNANCE_CODE_HASH=0x...
VITE_GOVERNANCE_SCRIPT_TX_HASH=0x...
VITE_CKB_RPC_URL=https://testnet.ckb.dev/rpc
```

Full deployment steps are in [DEPLOYMENT.md](/home/anihdev/ckb-voting-dapp/DEPLOYMENT.md).

## Testing Live

To test the hosted app live:

1. Deploy the contract to CKB testnet.
2. Copy the emitted code hash and script transaction hash into Vercel env vars.
3. Redeploy the frontend.
4. Open the Vercel URL.
5. Connect a CCC-compatible wallet on testnet.
6. Fund the wallet from the Nervos faucet.
7. Create a poll, create vote intents, aggregate, delegate, revoke, and close.

Useful testnet tools:

- Faucet: https://faucet.nervos.org/
- Explorer: https://pudge.explorer.nervos.org/
- RPC: https://testnet.ckb.dev/rpc

## Local Development

Frontend only:

```bash
pnpm dev:frontend
```

Contract and frontend verification:

```bash
pnpm test
pnpm build
```

## Current Guarantees

What is implemented now:

- intent-cell voting path
- permissionless aggregation
- creator deposit handling
- voter deposit handling
- delegated voting with verified refund locks
- off-chain duplicate-intent prevention for controlled authorities
- poll, intent, and delegation indexing in the frontend

## Next Protocol Extensions

These are natural next upgrades, but they are not yet enforced by the current contract:

- xUDT-weighted voting
- force-close or abandoned-poll recovery
- richer proposal metadata
- stronger on-chain uniqueness schemes

## Tests

Passing test suites:

- [tests/contract.test.ts](/home/anihdev/ckb-voting-dapp/tests/contract.test.ts)
- [tests/molecule.test.ts](/home/anihdev/ckb-voting-dapp/tests/molecule.test.ts)

## License

MIT
