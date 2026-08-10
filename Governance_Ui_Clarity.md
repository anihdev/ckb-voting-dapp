# Governance UI Clarity Pass

This note records a UI/UX pass on the governance dashboard driven by real testnet
use, what each change was meant to fix, and what we concluded along the way.

It is written for other builders, future implementation sessions, and models
picking up this repo. It is not a protocol spec. For protocol behavior see
`README.md`, `SHARDED_AGGREGATION_EXPLAINED.md`, and the contract code.

Original pass: 2026-08-03. Latest follow-up: 2026-08-10.

**Implementation follow-up:** the capacity and multi-transaction finalization
analysis in this note led to an approved v2 implementation later on August 5.
The active worktree now uses a fixed per-lane sparse-Merkle counted-voter root
and finalizes up to eight ordered same-poll lanes in one transaction. Sections
below that say the codec is unchanged, call the SMT verifier isolated, or say
one approval is required per lane describe the pre-v2 review point and are kept
as decision history. The current implementation keeps a fixed sparse-Merkle
counted-voter root per lane and finalizes up to eight ordered lanes in one
transaction. The v2 binary is deployed on CKB testnet; the complete multi-actor
lifecycle rehearsal remains pending.

## Why This Pass Happened

After a full lifecycle run on testnet (create -> vote -> aggregate -> finalize ->
close), the dashboard was technically correct but hard to read. Six specific
complaints came out of that session, and every one of them was a case of the UI
describing protocol mechanics without describing intent.

The unifying theme: the UI was reporting *cell state* where the user needed
*progress*, and it was showing global state where the user was looking at one
thing.

## The Six Issues And What We Did

### 1. "Finalize 8 times for one vote?"

**Symptom.** One vote intent was recorded, yet the UI required 8 separate
finalize transactions before Close appeared. The 7 empty lanes felt like a bug.

**It is not a bug.** The contract pins the finalized lane at global input 0 and
reads the epoch `since` bound from that index
([entry.rs:1109-1155](backend/contracts-rust/contracts/governance/src/entry.rs#L1109-L1155)),
rejecting a second cell in the same type group. Two lanes cannot both be input 0,
so N lanes genuinely require N transactions and N signatures. Every lane must be
frozen before close because close reads the complete lane set; an unfinalized
lane could still accept a timely but unaggregated intent and change the result
after the fact. (The intent itself was submitted before the deadline — what is
late is its aggregation, not the vote.)

Batching lanes into one transaction is a contract change, which
`AGENTS.md` §6 puts behind a reviewed design. Out of scope here.

**What we did instead.** Kept the per-lane transaction model and made the cost
legible:

- Added `finalizeAllShards` in [usePolls.ts](frontend/src/hooks/usePolls.ts), a
  sequential batch runner. It captures the lane cells once up front (finalizing
  one lane never consumes another, and the poll cell is only a dep, so the
  references stay valid), then runs one transaction per lane, awaiting each
  confirmation before building the next so the wallet's fee/change cell is never
  spent by two in-flight transactions.
- Added a "Finalize All N Lanes" button whose confirmation states plainly that
  the contract pins each lane at input 0, that the wallet will prompt N times,
  and that a mid-run failure keeps earlier lanes finalized so a rerun continues.
- Added `TxBatchProgress` to `TxState` so the card reports "3 of 8 confirmed"
  instead of going quiet between signatures.
- Renamed "shard" to "lane" in user-facing copy. "Shard" is an implementation
  word; "lane" reads as a parallel slot, which is what it is.

### 2. Protocol Timeline showed delegation as "live" with no poll open

**Symptom.** The Delegation steps read "live" even when no poll existed, and the
strip never corresponded to any particular poll.

**Root cause.** `buildProtocolTimeline(polls, delegations, currentEpoch)` reduced
*all* polls to one strip with `polls.some(...)` predicates. A lifecycle is a
property of one poll, so this could not be made correct by adjusting states — a
strip mixing three polls at different stages describes none of them. The
delegation steps were worse: they keyed off `hasPolls`, so any poll at all made
"Delegate authority" read live.

**What we did.** Rewrote it as `buildProtocolTimeline(poll | null, currentEpoch)`:

- Scoped to one poll, chosen by a picker that defaults to the newest poll the
  user can still act on. Selection and picker order share one deterministic
  ordering helper (`sortPollsForTimeline` / `selectDefaultTimelinePoll`):
  open first, then needs-close, then archived, and within a group by
  `createdEpoch` descending, then `deadline` descending, then id. An earlier
  version read the raw `polls` array from `usePolls`, which is in indexer order —
  `PollList` sorts its own copy and does not affect the array `App` holds — so
  "newest open" was whichever open poll the indexer happened to return first.
- Dropped both DELEGATE steps. Delegation is not a stage of a poll's lifecycle —
  it is an optional authority grant that may happen zero or many times. It is now
  reported in the Delegation panel, which is where it belongs.
- Added a per-step `detail` line so each stage says what it is waiting on
  ("0/8 lanes finalized. Each lane is a separate transaction.").
- Added a terminal `skipped` step state, distinct from `pending`. Weighted polls
  are recovery-only, so their voting and aggregation stages are marked `skipped`
  rather than `pending`: a disabled path is not unfinished work waiting on the
  user. A closed poll that counted nothing is likewise `skipped` at those
  stages — its close transaction already consumed the lane cells, so nothing can
  still be aggregated.
- Added a terminal `ended` state for the distinct case where all lanes are
  finalized while indexed timely intents remain pending. Aggregation cannot run
  after that point; the intents are uncounted and become refundable after close.

### 3. Archive was unscannable

**Symptom.** Every poll rendered its full lifecycle detail, so a closed poll
occupied as much space as an active one and the list was long and ambiguous.

**What we did.** Collapsed the card to header plus outcome, with everything else
behind "View details". Open polls default expanded (you are there to vote),
closed polls default collapsed (you are there to read the result). The collapsed
closed card carries a result line: the leading option, its vote count, and the
total.

Result semantics were reworked here. **The Rust contract defines no winner, no
quorum, no pass/fail policy, and no tie-break** — `grep winner` over the contract
returns nothing. The frontend's `winnerIndex` was a presentation field, and the
tie branch that consumed it was unreachable: `deriveWinnerIndex` returned `null`
on every tie while the tie check required a non-null index, so a real 2-2 tie
rendered as "Closed with no counted votes."

`winnerIndex` has been removed from `Poll` entirely so no caller and no test can
inject a reading the counts do not support. A pure `derivePollOutcome(voteCounts)`
now returns `no-votes`, `leader`, or `tie`, where a tie carries every joint-leading
option index. Ties across more than two options are reported as such. The card
says "Finalized tally leader" or "Tied finalized tally" — never "winner", and it
invents no lowest-index tie-break, because attributing a UI convention to
consensus is exactly the error this note is about.

Removing the registry table would have cost two useful affordances (Copy Poll ID,
Delegate for this poll), so both moved onto the card header rather than being
dropped. "Delegate for this poll" is now gated to match what the hook will
actually accept: a connected wallet, a poll open before its deadline, and a
viewer who is not the poll creator.

### 4. Duplicate transaction lifecycle in two places

**Symptom.** The same transaction status rendered at the bottom of the poll block
and the Delegation block at once.

**Root cause.** `usePolls` held one global `TxState` and every surface rendered it
unconditionally. Any transaction appeared everywhere.

**What we did.** Added `TxScope` to `TxState` (`poll` with its id, `delegation`,
or `createPoll`). All 40 `setTxState` call sites now carry a scope; the
"building" calls set it explicitly and later transitions use functional updates so
the scope survives the async lifecycle. Each surface renders status only when
`txState.scope` matches it. The poll card, the delegation panel, and the poll
builder can no longer show each other's transactions.

**What scoping broke, and the fix.** A single global `TxState` had been providing
an accidental global lock: every surface disabled its controls on any in-flight
transaction. Scoping the status removed that lock along with the duplicate
rendering, which would have allowed a second transaction to start while one was
in flight — double-spending the wallet change cell and overwriting
`trackedTxHashRef` mid-monitor.

Status rendering and control disabling are now separate concerns:

- Rendering stays scoped. A delegation transaction never appears in a poll card.
- Disabling is deliberately scope-blind (`areTransactionControlsLocked`). Every
  state-changing control locks on any in-flight transaction. Read-only controls
  (View details, Copy Poll ID, the timeline picker) do not consult it.
- Underneath, `usePolls` holds a real mutual-exclusion guard
  (`createTransactionExclusionGuard`), applied once at the hook boundary so all
  twelve exported actions are guarded by construction. It is a closure-held flag
  rather than React state because the check must be atomic within one tick — two
  clicks in the same frame would both read a stale `false` from state that has
  not re-rendered. A second action attempted while one is running rejects with
  `ConcurrentTransactionError` rather than silently queueing.
- The guard is held for the whole of a multi-transaction run, so no other action
  can start between the signatures of a `Finalize All N Lanes` batch. It is
  released on every exit path — success, rejection, confirmation timeout, and
  thrown builder or signing errors — so a canceled wallet prompt is recoverable.

### 5. Block order

Swapped so Create Poll precedes Delegation in the creator tools grid. Creating a
poll is the common path; delegating is the optional one.

### 6. Delegation details always expanded

Collapsed the Delegation block to the summary text and an active "Create
Delegation" button, mirroring the existing CreatePoll pattern. The collapsed
state adds one line when delegation cells exist so the panel is not silent about
state it knows about.

The initial expanded state is derived from `prefillPollScope` rather than set in
an effect, so an arriving "Delegate for this poll" request renders open
immediately instead of flashing collapsed first.

**A live cell is not usable authority.** The panel previously called every
indexed cell an "active delegation", which told delegators they held authority
they could not exercise: the scoped poll may have closed or passed its deadline,
and a cell scoped to a poll this wallet cannot see indexes with no poll at all.
`getDelegationLifecycle` now resolves each cell against the indexed polls into
one of five states:

| state | meaning | delegator action |
| --- | --- | --- |
| `usable` | scoped poll indexed, open, before deadline | can authorize an intent; revocable |
| `expired` | deadline passed, poll not closed | revocation only |
| `closed` | scoped poll is closed | revocation only |
| `unknown` | scoped poll not in the indexed set | usability undetermined |
| `legacy-global` | historical testnet v1 cell, zero poll scope | revocation only |

The collapsed summary now separates usable authorities from recovery- or
revocation-only cells rather than reporting one undifferentiated count.
Revocation stays available to the delegator on expired and closed scoped cells —
recovering the locked capacity is the only remaining action once authority is
unusable. Delegates see no revoke action at any state; they hold authority, not
ownership. New global delegations remain disabled in the builder, and existing
zero-scope cells are labeled as testnet legacy rather than presented as current.

When no indexed poll can accept a new delegation, creation is disabled while
management and revocation stay available.

## Found While Verifying

Driving the built UI against live testnet data surfaced a defect the unit tests
did not: a closed poll's timeline read **"0/8 lanes finalized"** next to a
**Done** state, and the card's detail row said "Indexed: 0/8; finalized: 0/8".

Both were true readings of indexed state and both were misleading. The close
transaction consumes the lane cells, so a closed poll indexes zero of them.
Reporting a live count for a poll whose cells no longer exist describes the
absence of data as an absence of work. Both surfaces now describe the outcome
("Every lane was finalized before this poll closed").

This is the general lesson from this pass, and it is worth stating directly:
**a UI that renders indexed cell state faithfully can still be wrong, because
consumed cells read as zero rather than as done.** Any new surface that counts
cells should ask what that count means after the cells are spent.

## Follow-Up: Lane Capacity Ceiling And Review-Gated Design

Not fixed here, and it needs a decision before the next deploy.

`counted_voter_lock_hashes` grows 32 bytes per aggregated voter
([entry.rs:1284-1307](backend/contracts-rust/contracts/governance/src/entry.rs#L1284-L1307))
while [entry.rs:1143](backend/contracts-rust/contracts/governance/src/entry.rs#L1143)
freezes lane capacity with `output_capacity == input_capacity`. A 2-option poll
assigns 293 CKB per lane against 221 bytes occupied at zero voters, leaving 72
bytes of headroom:

| voters in lane | occupied | assigned | valid |
| --- | --- | --- | --- |
| 1 | 253 | 293 | yes |
| 2 | 285 | 293 | yes |
| 3 | 317 | 293 | no |

**Two voters per lane, maximum.** A third voter hashing into the same lane can
never be aggregated: the intent stays pending, is omitted from the tally, and is
recoverable only by post-close refund. `MAX_INTENTS_PER_AGG = 50` is unreachable
by 25x. The headroom that does exist is accidental — `estimateOutputCapacity`
measures molecule length (90 bytes) rather than CKB occupied length (70) and adds
a further 32 bytes the occupied-capacity rule has no term for.

### Evidence, and why it is not a VM test

[lane-capacity.test.ts](frontend/src/lib/lane-capacity.test.ts) characterizes
this host-side using CCC's occupied-size APIs (`CellOutput.occupiedSize`,
`Script.occupiedSize`), which model the same quantity CKB's `CapacityVerifier`
enforces. It measures the assigned capacity of a builder-created empty lane
(293 CKB), the occupied capacity at zero/one/two/three voter hashes
(221/253/285/317), that two fit and three exceed, and that the 72-byte surplus is
fixed — identical across 2, 3, 5, and 10 options and across voter counts, because
it comes entirely from measuring two scripts 20 bytes too large plus the flat 32.

**It is deliberately not a `ckb-testtool` VM test, and one must not be added.**
`Context::verify_tx` runs the script and `OutputsDataVerifier`; it never runs
`CapacityVerifier`. A VM test asserting "an under-capacity lane is rejected"
would fail — the VM layer does not check capacity — and a test asserting
acceptance would pass for the wrong reason and keep passing if the capacity rule
were removed from consensus entirely. **Script execution is not transaction
admission.** The two are separate layers, and only the frontend/host layer can
give evidence about the second one.

The earlier claim in this note that "no test covers this: every VM lane fixture
uses `counted_voter_lock_hashes: Vec::new()`" was wrong on both counts. Four
fixtures use an empty list, but populated fixtures do exist
([governance_vm.rs:1371](backend/contracts-rust/integration-tests/tests/governance_vm.rs#L1371),
2488, 2577, 2781). They do not cover the ceiling because ckb-testtool does not
enforce occupied-capacity admission, not because the voter lists are empty.

### Design facts recorded for the redesign

Recorded, not implemented — the redesign is out of scope for this pass:

1. Live lane cells cannot be topped up. A lane update must preserve capacity
   exactly, so added capacity is not a migration path for lanes already on chain.
2. The current contract does accept an over-provisioned initial lane, so a larger
   reserve would be builder-only and therefore advisory: another builder can
   still create a thin lane. It also raises the CKB a creator must lock per poll
   by the reserve times the lane count.
3. Reducing to one lane would fit more voters per cell but reintroduce poll-wide
   aggregation contention — every aggregation would compete for one cell.
   Multiple lanes are the aggregation-concurrency control, not an accident.
4. Average voters-per-lane is not a sufficient guarantee. Shard assignment is
   deterministic from the voter lock hash, so a real voter set can concentrate in
   one lane while others stay empty.
5. The planned one-shot represented-principal authority design may remove the
   growing `counted_voter_lock_hashes` list entirely, changing what a lane must
   store. It should be settled before any capacity sizing is frozen.
6. Batching several lane finalizations into one transaction is a separate
   contract design question — the finalized lane is pinned at global input 0 and
   the epoch `since` is read from that index — and must not be folded into a
   capacity redesign.

This also reverses the instinct to reduce lane count to make finalize cheaper.
Dropping to 1 lane would cut the ceiling from ~16 voters to 2.

The earlier proposed direction was to reserve capacity from a declared voter
count. That direction is superseded: it introduces a public participation preset,
locks capacity across every lane for a worst-case distribution, and remains only
a builder convention unless the contract also enforces it.

The reviewed candidate at that point was a constant-size sparse-Merkle
counted-voter root per lane plus bounded multi-lane finalization. That review
gate was later completed and the active codec and validator were migrated as a
versioned testnet deployment.

## Verification

`make check`, `make test`, and `make build` pass for the current review-gate
worktree.

- 58 current-governance CKB-VM tests pass. The added test records the existing
  50-intent cycle baseline and explicitly does not claim full-node capacity
  admission.
- 2 isolated sparse-Merkle CKB-VM benchmark tests pass. They verify valid
  old-root/new-root transitions and reject wrong roots and truncated proofs;
  they do not change governance consensus behavior.
- At the end of the original UI pass, 123 TypeScript/React tests passed.
  Coverage added across that pass included closed-poll
  collapse; leader/tie/no-votes outcomes derived from raw counts, including ties
  across three and four options; zero-vote close; cross-surface status isolation
  with globally locked controls; the exclusion guard's rejection, release, and
  hold across a batch run; poll-scoped timeline; deterministic timeline selection
  under randomized input order; per-lane finalize reporting; consumed-lane
  reporting; the five delegation lifecycle states in
  [DelegatePower.test.ts](frontend/src/components/DelegatePower.test.ts); and the
  lane-capacity characterization in
  [lane-capacity.test.ts](frontend/src/lib/lane-capacity.test.ts).
- Result and delegation tests drive the real helpers from raw poll and cell data.
  None of them inject an outcome or lifecycle state that production cannot
  derive, which is what let the unreachable tie branch survive previously.

**Browser verification.** The built app was reviewed at 1440px desktop, 720px
split-screen, and 390px mobile widths against live public testnet/indexer reads.
The only document-wide horizontal overflow was the intentionally scrollable
lifecycle-filter control. The pass found and fixed one mobile regression: poll
status/actions had squeezed the proposal question into a narrow column. The
question now occupies its own full-width row and the status/actions sit below it.

**Not verified by the original UI pass.** No wallet signing was automated or
claimed. Delegation submission/revocation and the later v2 one-transaction
finalization of up to eight lanes still need a manual connected-wallet testnet
pass before the deployment can be treated as a completed lifecycle rehearsal.

## Files Touched

| File | Change |
| --- | --- |
| [types.ts](frontend/src/lib/types.ts) | `TxScope`, `TxBatchProgress`; added `PollOutcome`, removed `winnerIndex` from `Poll` |
| [usePolls.ts](frontend/src/hooks/usePolls.ts) | Scoped all 40 `setTxState` sites; added `finalizeAllShards`; hook-level exclusion guard over all twelve actions |
| [txLifecycle.ts](frontend/src/lib/txLifecycle.ts) | `areTransactionControlsLocked`, `createTransactionExclusionGuard`, `ConcurrentTransactionError` |
| [protocolUi.ts](frontend/src/lib/protocolUi.ts) | `getPollTallyProgress`; poll-scoped `buildProtocolTimeline` with a `skipped` state; `derivePollOutcome`; delegation lifecycle helpers; `sortPollsForTimeline` |
| [VoteOnPoll.tsx](frontend/src/components/VoteOnPoll.tsx) | Collapse, outcome line, scoped status with global locking, batch finalize, gated delegate action |
| [PollList.tsx](frontend/src/components/PollList.tsx) | Removed the registry table |
| [DelegatePower.tsx](frontend/src/components/DelegatePower.tsx) | Collapse pattern, scoped status, per-cell lifecycle labels, gated creation |
| [CreatePoll.tsx](frontend/src/components/CreatePoll.tsx) | Scoped status, global locking |
| [App.tsx](frontend/src/App.tsx) | Deterministic timeline selection and picker, block order swap |
| [governance.css](frontend/src/governance.css) | Result line, card actions, timeline head/detail/terminal states, auto-fit strip, responsive poll header |
| [lane-capacity.test.ts](frontend/src/lib/lane-capacity.test.ts) | Host-side capacity characterization (evidence only) |
| [.gitignore](.gitignore) | Allowlisted this note; the repo ignores `*.md` by default |

## Follow-Up: Compact Poll Entry And Duration Controls

The poll creation and collapsed-card entry points received a focused responsive
follow-up. This is presentation and navigation only; it does not change contract
validation, transaction layouts, voting authority, or intent finality.

### Duration selector

- `Hour(s)`, `Day(s)`, and `Epoch(s)` occupy three equal grid tracks.
- The active background fills its complete track instead of wrapping tightly
  around the label.
- The numeric duration input and unit selector always stack at full width. This
  follows the tool card's actual width instead of a viewport breakpoint, so a
  split-screen card cannot push the selector outside its clipped boundary.
- Labels remain on one line and cannot expand a segment beyond the selector.

### Collapsed poll entry

- Every poll card now starts collapsed, including active polls. This keeps a
  multi-poll list scannable and avoids presenting every lifecycle table at once.
- The collapsed header retains the proposal question, state, compact metadata,
  `Copy Poll ID`, and the existing `View details` control.
- A connected, non-creator participant with an unused eligible authority sees
  `Vote now`. The control selects that authority, expands the existing details,
  and moves the vote form into view.
- `Vote now` is an entry shortcut only. The participant must still review the
  finality warning, choose an option, confirm the action, and approve the wallet
  transaction. It never creates or submits an intent directly.
- The shortcut is hidden for disconnected users, creators, closed or expired
  polls, unsupported weighted polls, and authorities that already have an
  intent. `Delegate for this poll` keeps its separate role and lifecycle gates.
- Connected-wallet authority is re-derived immediately from already-indexed
  intents when the viewer lock changes. If an anonymous index scan is still in
  progress, a signer-aware scan is queued instead of being discarded, so the
  shortcut does not depend on the next 30-second refresh. Account changes clear
  the prior wallet identity while the new lock resolves.

### Follow-up verification

Focused component coverage now checks default collapse, shortcut ordering, and
the disconnected, creator, expired, closed, and existing-intent exclusions. The
rendered states were also reviewed at desktop, split-screen, and 390px mobile
widths. The duration segments fill evenly, compact actions wrap without horizontal
overflow, and expanding through `Vote now` reveals the existing authority and
option-selection flow.

Expanded poll cards also fold when the user presses outside the card. Pointer
actions inside the card or its confirmation dialog do not fold it, and folding
preserves the selected authority and option so an accidental outside press does
not discard work. The explicit `Hide details` control remains available for
keyboard and deliberate disclosure control.

The expanded poll-creation and delegation tools follow the same interaction
rule. Pressing outside either panel folds it, while pressing inside does not.
Question, option, duration, delegate, and poll-scope drafts remain in React
memory for the current page session and reappear when the panel is reopened.
Outside folding is disabled during signing, broadcasting, and confirmation so
transaction feedback cannot be hidden. A successful transaction retains the
existing form-reset behavior. Drafts are deliberately not persisted to browser
storage, where stale poll scope or wallet-specific data could survive a reload.

## Follow-Up: Live Poll Status Motion

The `Active` status on a live poll now uses a restrained animated halo and
status dot. The label itself remains fully opaque and fixed in place, so the
motion signals that voting is live without changing the badge dimensions or
reducing readability.

The animation is poll-specific. Expired and closed poll states, delegation
statuses, and other uses of the active status color remain static. Browsers
with reduced-motion enabled receive a static highlighted outline instead.

The live status was reviewed at desktop, split-screen, and 390px mobile widths.
It remains contained within the poll header without overlap or layout shift.

## Follow-Up: Vote Feedback, Tally Visibility, And Maintenance Actions

Real testnet use showed that the active poll card still mixed three different
concerns: selecting a vote, observing the transaction, and reading detailed
lifecycle state. It also displayed live option totals even though a participant
mainly needs confirmation of their own recorded choice while voting remains
open.

The expanded card now follows this order:

1. voting authority, options, and state-changing actions;
2. transaction progress or a local action error;
3. lifecycle and tally details, always last.

After a vote intent commits, the selected represented authority's option is
highlighted as `Your recorded choice`. The durable label is derived from
indexed intent data. A local committed-choice fallback makes the confirmation
visible immediately while the refreshed index is being rendered. If the
indexer finds conflicting live choices for the same represented voter, the UI
does not invent one recorded choice; it reports the conflict instead.

Open and expired-but-unclosed polls no longer render per-option counts,
percentage bars, or percentage labels. Closed polls render those final result
details. Overall participation and pending-intent metadata may remain visible
because they do not identify the currently leading option. This is a display
policy, not cryptographic privacy: vote-intent and tally cells remain public on
CKB and can be inspected outside this frontend.

### Aggregation wording

One aggregation transaction updates exactly one deterministic tally lane and
includes at most `MAX_INTENTS_PER_AGG` (50) timely intents. Intents assigned to
different lanes cannot share one transaction even when both lanes are below
the limit. The UI therefore estimates remaining transactions per lane and sums
`ceil(pending_in_lane / 50)` across unfinalized lanes:

- before any indexed tally progress: `Aggregate`, regardless of how many
  lane-bound transactions are estimated;
- after tally state has advanced and timely work remains: `Aggregate Next
  Batch`;
- active operation: `Aggregating...` with a fixed-size spinner.

Indexed tally totals provide the durable progress signal, with a just-confirmed
local aggregation as a short refresh fallback. The estimate only selects
wording and visibility. The builder still chooses one actual lane and up to 50
intents, and the Rust contract remains the source of truth for acceptance.
Finalization has its own `Finalizing...` state and continues to use the reviewed
bounded multi-lane transaction flow.

### Finalization readiness handshake

Clicking a finalization action now performs a fresh exact-scope indexer scan for
that poll's live intent cells before opening the confirmation dialog. The scan
classifies unaggregated intents by authenticated creation-header epoch:

- timely pending intents still need aggregation and trigger `Finalize Anyway`;
- late intents cannot count and remain refundable, so they are reported but do
  not make the readiness result cautionary;
- missing creation headers or unreadable matching cells make the result
  inconclusive and trigger `Finalize Anyway`.

The scan is a UI handshake rather than a blocker. To keep the confirmation
compact, the dialog shows one readiness result: the timely pending count, an
inconclusive warning, or confirmation that no indexed timely work remains. A
failed or cautionary check permits an explicit `Finalize Anyway`, preserving
the protocol's liveness policy. Public protocol documentation separately states
that indexer discovery is not proof of complete vote coverage. Independently,
the Rust aggregation validator loads each intent input's creation header through
`Source::Input` and rejects an epoch after the poll deadline, so a stale or
incorrect frontend classification cannot make a late intent count.

### Connection failures and control hints

A browser `Failed to fetch` error means the app could not reach its configured
CKB RPC/indexer endpoint; it is not a contract rejection. The warning now says
that indexed data may be stale, offers an explicit retry, and preserves the raw
error under a technical-detail disclosure.

App-owned buttons, links, selectors, and disclosure controls now carry concise
native hover descriptions. Visible labels and accessibility names remain the
primary interaction text, so mobile and keyboard use do not depend on hover.
Poll cards also stay expanded while a state-changing transaction is active so
their transaction feedback cannot disappear on an outside pointer press.

### Latest verification

`make validate` passes with 63 CKB-VM tests and 151 focused
TypeScript/React/deploy tests. Browser checks covered 1440px desktop, 720px
split-screen, and 390px mobile layouts, including an expanded active poll. The
option grid, warning copy, horizontal lifecycle filters, poll metadata, and
lifecycle table remained contained without incoherent overlap.

The first browser run also caught a disconnected-view regression that static
fixtures had missed: both the submitted choice and selected authority were
null, and comparing their optional ids entered a branch that dereferenced the
null submitted choice. The condition now requires an actual submitted choice,
and a disconnected/no-authority component test protects startup rendering.

Wallet signing was not automated by this visual pass. Operation-specific
spinners and the transaction track are covered by component logic and should
still be exercised during the next connected-wallet testnet rehearsal.
