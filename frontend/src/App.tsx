/**
 * App.tsx
 * =======
 * Governance dashboard shell aligned to the intent-cell protocol flow.
 */

import React, { Component, Suspense, lazy, useCallback, useEffect, useMemo, useState } from "react";
import { Provider } from "@ckb-ccc/connector-react";
import { ccc } from "@ckb-ccc/core";
import { useCKB } from "./hooks/useCKB";
import { usePolls } from "./hooks/usePolls";
import {
  ChainTipStatus,
  CKB_RPC_URL,
  getChainTipStatus,
  shannonsToCkb,
  validateRuntimeConfig,
} from "./lib/ckb";
import {
  buildProtocolTimeline,
  describeIndexerQueryError,
  formatApproxWallClockDuration,
  getPollFilterCounts,
  getPollLifecycleStatus,
  selectDefaultTimelinePoll,
  sortPollsForTimeline,
} from "./lib/protocolUi";
import { WalletConnect } from "./components/WalletConnect";

const CreatePoll = lazy(() => import("./components/CreatePoll").then((module) => ({ default: module.CreatePoll })));
const DelegatePower = lazy(() => import("./components/DelegatePower").then((module) => ({ default: module.DelegatePower })));
const PollList = lazy(() => import("./components/PollList").then((module) => ({ default: module.PollList })));

const defaultClient = new ccc.ClientPublicTestnet({ url: CKB_RPC_URL });

class AppErrorBoundary extends Component<{ children: React.ReactNode }, { error: string | null }> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "Unknown error" };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="app-shell" style={{ padding: "60px 32px" }}>
          <div className="panel" style={{ maxWidth: 640, margin: "0 auto" }}>
            <div className="kicker" style={{ marginBottom: 12 }}>Runtime Error</div>
            <h1 className="section-title" style={{ marginBottom: 16 }}>The app hit a client-side error.</h1>
            <div className="alert alert-error">{this.state.error}</div>
            <p className="hint" style={{ marginTop: 12 }}>Reconnect your wallet and refresh. Error detail is visible above.</p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function InnerApp() {
  const configError = validateRuntimeConfig();
  const { signer, address, lockScriptHash, balance, isConnected, connect, error: walletError } = useCKB();
  const {
    polls,
    delegations,
    loading,
    refreshing,
    loadError,
    txState,
    actionInFlight,
    fetchPolls,
    checkFinalizationReadiness,
    createPoll,
    castVote,
    aggregatePoll,
    finalizeShards,
    finalizeAllShards,
    mergeShards,
    closePoll,
    forceClose,
    refundClosedIntent,
    refundLateIntent,
    createDelegation,
    revokeDelegation,
  } = usePolls(signer, defaultClient, lockScriptHash);

  const [chainTip, setChainTip] = useState<ChainTipStatus | null>(null);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(Date.now());
  const [secondsSinceSync, setSecondsSinceSync] = useState<number>(0);
  const [delegationScopePrefill, setDelegationScopePrefill] = useState<{ pollId: string; requestId: number } | null>(null);
  const [timelinePollId, setTimelinePollId] = useState<string | null>(null);

  const syncDashboard = useCallback(async () => {
    const client = signer?.client ?? defaultClient;
    if (!configError) {
      await fetchPolls();
    }
    const nextChainTip = await getChainTipStatus(client);
    setChainTip(nextChainTip);
    setLastSyncedAt(Date.now());
    setSecondsSinceSync(0);
  }, [configError, fetchPolls, signer]);

  useEffect(() => {
    syncDashboard().catch(console.error);

    const id = setInterval(() => {
      if (document.visibilityState === "visible") {
        syncDashboard().catch(console.error);
      }
    }, 30000);

    return () => clearInterval(id);
  }, [syncDashboard]);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsSinceSync(Math.max(0, Math.floor((Date.now() - lastSyncedAt) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  const currentEpoch = chainTip?.epoch ?? 0n;
  const indexerWarning = loadError ? describeIndexerQueryError(loadError) : null;
  const bestKnownBlock = chainTip?.bestKnownBlockNumber ?? null;
  const blocksBehind =
    chainTip && bestKnownBlock !== null && bestKnownBlock > chainTip.blockNumber
      ? bestKnownBlock - chainTip.blockNumber
      : 0n;
  const rpcSyncPercent =
    chainTip && bestKnownBlock !== null && bestKnownBlock > 0n
      ? Number(
          ((chainTip.blockNumber < bestKnownBlock ? chainTip.blockNumber : bestKnownBlock) * 10000n) /
            bestKnownBlock
        ) / 100
      : null;
  const rpcChainTimeGap =
    chainTip?.bestKnownBlockTimestamp !== null &&
    chainTip?.bestKnownBlockTimestamp !== undefined &&
    chainTip.bestKnownBlockTimestamp > chainTip.blockTimestamp
      ? formatApproxWallClockDuration(
          Number(chainTip.bestKnownBlockTimestamp - chainTip.blockTimestamp) / 3_600_000
        )
      : null;

  /**
   * The timeline describes one poll's lifecycle, so it needs a subject. The
   * default and the picker share one deterministic ordering, so the subject
   * does not depend on the order the indexer returned cells in.
   */
  const timelinePolls = useMemo(
    () => sortPollsForTimeline(polls, currentEpoch),
    [currentEpoch, polls]
  );
  const timelinePoll = useMemo(() => {
    if (timelinePollId) {
      const selected = timelinePolls.find((poll) => poll.id === timelinePollId);
      if (selected) return selected;
    }
    return selectDefaultTimelinePoll(timelinePolls, currentEpoch);
  }, [currentEpoch, timelinePollId, timelinePolls]);

  const protocolTimeline = useMemo(
    () => buildProtocolTimeline(timelinePoll, currentEpoch),
    [currentEpoch, timelinePoll]
  );
  const pollFilterCounts = useMemo(
    () => getPollFilterCounts(polls, currentEpoch),
    [currentEpoch, polls]
  );

  const sectionFallback = (
    <div className="card-shell" style={{ padding: 24 }}>
      <div className="skeleton" style={{ height: 18, width: 160, borderRadius: 6 }} />
      <div className="skeleton" style={{ height: 14, width: "80%", marginTop: 12, borderRadius: 6 }} />
      <div className="skeleton" style={{ height: 14, width: "60%", marginTop: 8, borderRadius: 6 }} />
    </div>
  );

  const handleDelegateForPoll = useCallback((pollId: string) => {
    setDelegationScopePrefill({ pollId, requestId: Date.now() });
    document.getElementById("creator-tools")?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  return (
    <div className="app-shell">
      <nav className="top-nav">
        <div className="nav-inner">
          <div className="nav-brand" style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div className="logo-mark">CG</div>
            <div>
              <div className="logo-name">CKB Governance</div>
              <div className="logo-tagline">Voting protocol | Nervos</div>
            </div>
          </div>
          <WalletConnect />
        </div>
      </nav>

      <main className="dashboard-main">
        <div className="hero" style={{ paddingLeft: 0, paddingRight: 0 }}>
          <a
            className="hero-kicker"
            href="https://github.com/anihdev/ckb-voting-dapp"
            target="_blank"
            rel="noopener noreferrer"
            title="Open repository"
            style={{ textDecoration: "none" }}
          >
            <span className="hero-kicker-dot" />
            Live | Testnet
          </a>
          <h1 className="hero-title">
            On-chain <span>governance</span>
            <br />
            control panel.
          </h1>
          <p className="hero-desc">
            Votes are recorded as independent intent cells and counted later through aggregation.
            This reduces shared-cell contention and keeps governance state explicit on-chain.
          </p>
          <p className="hero-desc hero-desc-secondary" style={{ marginTop: 8 }}>
            Deposits stay inside governance cells as capacity. Delegation controls authority, not
            ownership. Close paths return funds through verified spend rules.
          </p>
          <div className="hero-chips">
            <span className="chip">Testnet</span>
            <span className="chip">6 script families</span>
            <span className="chip">Shard aggregation</span>
            <span className="chip">Delegation cells</span>
            <span className="chip">Permissionless force-close</span>
          </div>
          <div className="hero-note">
            This protocol uses intent cells for voting. Aggregation is a separate on-chain step -
            aggregate authenticated timely intents before shard finalization.
          </div>
          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
            Last synced {secondsSinceSync}s ago | auto-refresh every 30s
          </div>
        </div>

        <div className="stats-row" style={{ padding: "0 0 40px" }}>
          <div className="status-metric">
            <div className="metric-label">RPC Node Tip</div>
            <div className="metric-value chain-tip-value">
              {chainTip ? `#${chainTip.blockNumber.toLocaleString("en-US")}` : "-"}
            </div>
            <div className="hint" style={{ marginTop: 6 }}>
              Epoch {currentEpoch.toString()}
              {blocksBehind > 0n && bestKnownBlock !== null
                ? ` | best known #${bestKnownBlock.toLocaleString("en-US")}`
                : ""}
            </div>
            {blocksBehind > 0n && (
              <div className="hint" style={{ marginTop: 4 }}>
                {blocksBehind.toLocaleString("en-US")} blocks behind
                {rpcChainTimeGap ? ` | ${rpcChainTimeGap} of chain time` : ""}
              </div>
            )}
            <span
              className={`status-pill ${blocksBehind > 0n ? "status-pill-warn" : "status-pill-neutral"}`}
              style={{ marginTop: 8 }}
              title="Synchronization status of the configured RPC node, not the connected wallet"
            >
              {rpcSyncPercent === null
                ? "RPC tip available"
                : blocksBehind > 0n
                  ? `${rpcSyncPercent.toFixed(2)}% synced`
                  : "Synced 100%"}
            </span>
          </div>
          <div className="status-metric">
            <div className="metric-label">Indexed Polls</div>
            <div className="metric-value">{polls.length}</div>
            <div className="hint" style={{ marginTop: 6 }}>
              Open {pollFilterCounts.open} | Needs close {pollFilterCounts.needsClose} | Archived {pollFilterCounts.archived}
            </div>
            <span className="status-pill status-pill-ok" style={{ marginTop: 8 }}>On-chain</span>
          </div>
          <div className="status-metric">
            <div className="metric-label">Your Delegations</div>
            <div className="metric-value">{isConnected ? delegations.length : "-"}</div>
            <span
              className={`status-pill ${isConnected ? "status-pill-ok" : "status-pill-warn"}`}
              style={{ marginTop: 8 }}
            >
              {isConnected ? "Wallet scoped" : "Disconnected"}
            </span>
          </div>
          <div className="status-metric">
            <div className="metric-label">Available Balance</div>
            {isConnected ? (
              <div className="metric-value mono">{shannonsToCkb(balance)} CKB</div>
            ) : (
              <div className="metric-value mono">-</div>
            )}
            {isConnected && address && (
              <div className="hint" style={{ marginTop: 6, fontFamily: "var(--font-mono)" }}>
                {address.slice(0, 10)}...{address.slice(-6)}
              </div>
            )}
            <span className={`status-pill ${isConnected ? "status-pill-ok" : "status-pill-warn"}`} style={{ marginTop: 8 }}>
              {isConnected ? "Connected" : "Disconnected"}
            </span>
          </div>
        </div>

        {(configError || walletError || loadError) && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 24 }}>
            {configError && (
              <div className="alert alert-error">
                <strong>Deployment config required</strong>
                <div style={{ marginTop: 4 }}>{configError}</div>
                <div style={{ marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10 }}>RPC: {CKB_RPC_URL}</div>
              </div>
            )}
            {walletError && (
              <div className="alert alert-warn">
                <strong>Wallet warning</strong>
                <div style={{ marginTop: 4 }}>{walletError}</div>
              </div>
            )}
            {indexerWarning && (
              <div className="alert alert-warn">
                <strong>CKB data connection warning</strong>
                <div style={{ marginTop: 4 }}>{indexerWarning.message}</div>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      void syncDashboard();
                    }}
                    disabled={loading || refreshing}
                    title="Retry the CKB RPC and indexer queries now"
                    className="btn-quiet px-3 py-1.5 text-xs"
                  >
                    {loading || refreshing ? "Retrying..." : "Retry data query"}
                  </button>
                  <details className="text-xs subtle">
                    <summary title="Show the underlying RPC or browser error">Technical detail</summary>
                    <div className="mt-1 font-mono" style={{ overflowWrap: "anywhere" }}>
                      {indexerWarning.detail}
                    </div>
                  </details>
                </div>
              </div>
            )}
          </div>
        )}

        {!isConnected && (
          <div className="card-shell ui-enter" style={{ padding: 32, marginBottom: 32 }}>
            <div className="kicker" style={{ marginBottom: 12 }}>Connect to continue</div>
            <h2 className="section-title" style={{ fontSize: 26, maxWidth: 500, marginBottom: 12 }}>
              Connect a CKB wallet to create polls, submit vote intents, aggregate results, and test refund flows.
            </h2>
            <p style={{ color: "var(--ink-2)", fontSize: 13, lineHeight: 1.7, maxWidth: 480 }}>
              The app runs on CKB testnet. If your wallet has no funds, use the faucet before submitting transactions.
            </p>
            <div style={{ marginTop: 20 }}>
              <a
                href="https://faucet.nervos.org/"
                target="_blank"
                rel="noopener noreferrer"
                title="Open the Nervos CKB testnet faucet"
                className="btn-primary"
                style={{ display: "inline-block", borderRadius: 9999, padding: "11px 24px", textDecoration: "none" }}
              >
                Open Testnet Faucet -&gt;
              </a>
            </div>
          </div>
        )}

        <Suspense fallback={sectionFallback}>
          <PollList
            polls={polls}
            loading={loading}
            refreshing={refreshing}
            isConnected={isConnected && !configError}
            voterAddress={configError ? null : address}
            voterLockHash={configError ? null : lockScriptHash}
            txState={txState}
            actionInFlight={actionInFlight}
            currentEpoch={currentEpoch}
            currentEpochPosition={
              chainTip
                ? {
                    epoch: chainTip.epoch,
                    index: chainTip.epochIndex,
                    length: chainTip.epochLength,
                  }
                : undefined
            }
            onVote={(poll, optionIndex, authorityId) =>
              castVote({ poll, optionIndex, authorityId })
            }
            onAggregate={aggregatePoll}
            onCheckFinalizationReadiness={checkFinalizationReadiness}
            onFinalizeShards={finalizeShards}
            onFinalizeAllShards={finalizeAllShards}
            onMergeShards={mergeShards}
            onClose={closePoll}
            onForceClose={forceClose}
            onRefundClosedIntent={refundClosedIntent}
            onRefundLateIntent={refundLateIntent}
            onRefresh={() => {
              void syncDashboard();
            }}
            onConnectWallet={connect}
            onDelegateForPoll={handleDelegateForPoll}
          />
        </Suspense>

        {isConnected && !configError && (
          <div id="creator-tools" style={{ marginTop: 20 }}>
            <div className="kicker" style={{ marginBottom: 10 }}>Creator and Delegation Tools</div>
            <div className="action-grid">
              <Suspense fallback={sectionFallback}>
                <CreatePoll
                  onSubmit={createPoll}
                  txState={txState}
                  actionInFlight={actionInFlight}
                  currentEpoch={currentEpoch}
                  currentEpochPosition={
                    chainTip
                      ? {
                          epoch: chainTip.epoch,
                          index: chainTip.epochIndex,
                          length: chainTip.epochLength,
                        }
                      : undefined
                  }
                />
              </Suspense>
              <Suspense fallback={sectionFallback}>
                <DelegatePower
                  delegations={delegations}
                  polls={polls}
                  currentEpoch={currentEpoch}
                  viewerLockHash={lockScriptHash}
                  txState={txState}
                  actionInFlight={actionInFlight}
                  onDelegate={createDelegation}
                  onRevoke={revokeDelegation}
                  prefillPollScope={delegationScopePrefill}
                />
              </Suspense>
            </div>
          </div>
        )}

        <div id="protocol-timeline" className="card-shell ui-enter-delay-1" style={{ marginBottom: 20, overflow: "hidden", padding: 0 }}>
          <div className="protocol-strip-head">
            <div>
              <div className="card-title">Protocol Timeline</div>
              <div className="card-sub">
                {timelinePoll
                  ? "Lifecycle of the selected poll. Delegation is not a poll stage and is reported in the Delegation panel."
                  : "No poll is indexed yet. Stages activate once a poll exists."}
              </div>
            </div>
            {polls.length > 0 && (
              <label className="protocol-strip-picker">
                <span className="subtle">Poll</span>
                <select
                  className="input"
                  value={timelinePoll?.id ?? ""}
                  onChange={(event) => setTimelinePollId(event.target.value || null)}
                  title="Choose which poll lifecycle to display"
                >
                  {timelinePolls.map((poll) => (
                    <option key={poll.id} value={poll.id}>
                      {getPollLifecycleStatus(poll, currentEpoch) === "archived"
                        ? "[Closed] "
                        : getPollLifecycleStatus(poll, currentEpoch) === "needsClose"
                          ? "[Needs close] "
                          : "[Open] "}
                      {poll.question.length > 56 ? `${poll.question.slice(0, 56)}...` : poll.question}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <div className="protocol-strip">
            {protocolTimeline.map((step) => (
              <div key={`${step.op}:${step.label}`} className={`protocol-cell ${step.state}`}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: 0,
                    color:
                      step.state === "completed"
                        ? "var(--teal)"
                        : step.state === "ended"
                          ? "var(--amber)"
                        : step.state === "live"
                          ? "var(--amber)"
                          : "var(--ink-3)",
                    marginBottom: 5,
                  }}
                >
                  {step.state === "completed"
                    ? "Done"
                    : step.state === "ended"
                      ? "Ended"
                    : step.state === "live"
                      ? "Live"
                      : step.state === "skipped"
                        ? "Not applicable"
                        : "Pending"}
                </div>
                <div className="protocol-op">
                  {step.op}
                </div>
                <div style={{ fontSize: 12, fontWeight: 500, color: step.state === "completed" || step.state === "live" || step.state === "ended" ? "var(--ink)" : "var(--ink-2)" }}>
                  {step.label}
                </div>
                <div className="protocol-detail">{step.detail}</div>
              </div>
            ))}
          </div>
        </div>

      </main>
    </div>
  );
}

export default function App() {
  return (
    <div className="governance-theme">
      <AppErrorBoundary>
        <Provider defaultClient={defaultClient} clientOptions={[{ client: defaultClient, name: "CKB Testnet" }]}>
          <InnerApp />
        </Provider>
      </AppErrorBoundary>
    </div>
  );
}
