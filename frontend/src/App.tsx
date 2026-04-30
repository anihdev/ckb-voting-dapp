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
import { CKB_RPC_URL, getTipEpoch, shannonsToCkb, validateRuntimeConfig } from "./lib/ckb";
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
    loadError,
    txState,
    fetchPolls,
    createPoll,
    castVote,
    aggregatePoll,
    closePoll,
    forceClose,
    createDelegation,
    revokeDelegation,
  } = usePolls(signer);

  const [currentEpoch, setCurrentEpoch] = useState<bigint>(0n);
  const [lastSyncedAt, setLastSyncedAt] = useState<number>(Date.now());
  const [secondsSinceSync, setSecondsSinceSync] = useState<number>(0);

  const syncDashboard = useCallback(async () => {
    if (!signer) return;
    await fetchPolls();
    const epoch = await getTipEpoch(signer.client);
    setCurrentEpoch(epoch);
    setLastSyncedAt(Date.now());
    setSecondsSinceSync(0);
  }, [fetchPolls, signer]);

  useEffect(() => {
    if (!signer) return;
    syncDashboard().catch(console.error);

    const id = setInterval(() => {
      syncDashboard().catch(console.error);
    }, 30000);

    return () => clearInterval(id);
  }, [signer, syncDashboard]);

  useEffect(() => {
    const id = setInterval(() => {
      setSecondsSinceSync(Math.max(0, Math.floor((Date.now() - lastSyncedAt) / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, [lastSyncedAt]);

  const protocolTimeline = useMemo(() => {
    type State = "completed" | "live" | "pending";

    const hasPolls = polls.length > 0;
    const hasIntent = polls.some((poll) => poll.totalVoters > 0n || poll.pendingIntentCount > 0n);
    const hasAggregated = polls.some((poll) => poll.totalVotes > 0n);
    const hasExpiredOpen = polls.some((poll) => !poll.isClosed && currentEpoch > poll.deadline);
    const hasClosed = polls.some((poll) => poll.isClosed);
    const hasDelegation = delegations.length > 0;

    return [
      {
        op: "CREATE_POLL",
        label: "Create poll cell",
        detail: "Lock creator deposit and initialize governance state.",
        state: hasPolls ? ("completed" as State) : ("live" as State),
      },
      {
        op: "CREATE_VOTE_INTENT",
        label: "Record vote intent",
        detail: "Store independent voter intent cells.",
        state: hasIntent ? ("completed" as State) : hasPolls ? ("live" as State) : ("pending" as State),
      },
      {
        op: "AGGREGATE_VOTES",
        label: "Aggregate intents",
        detail: "Batch-consume pending intents and update tally.",
        state: hasAggregated ? ("completed" as State) : hasIntent ? ("live" as State) : ("pending" as State),
      },
      {
        op: "CLOSE_POLL",
        label: "Close or recover",
        detail: "Creator closes after deadline, then force-close after grace.",
        state: hasClosed ? ("completed" as State) : hasExpiredOpen ? ("live" as State) : ("pending" as State),
      },
      {
        op: "DELEGATE",
        label: "Delegate authority",
        detail: "Issue delegation cells globally or per poll.",
        state: hasDelegation ? ("completed" as State) : hasPolls ? ("live" as State) : ("pending" as State),
      },
      {
        op: "REVOKE_DELEGATION",
        label: "Revoke delegation",
        detail: "Consume delegation cell to revoke authority.",
        state: hasDelegation ? ("live" as State) : ("pending" as State),
      },
    ] as const;
  }, [currentEpoch, delegations, polls]);

  const sectionFallback = (
    <div className="card-shell" style={{ padding: 24 }}>
      <div className="skeleton" style={{ height: 18, width: 160, borderRadius: 6 }} />
      <div className="skeleton" style={{ height: 14, width: "80%", marginTop: 12, borderRadius: 6 }} />
      <div className="skeleton" style={{ height: 14, width: "60%", marginTop: 8, borderRadius: 6 }} />
    </div>
  );

  return (
    <div className="app-shell">
      <nav className="top-nav">
        <div className="nav-inner">
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
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
          <p className="hero-desc" style={{ marginTop: 8 }}>
            Deposits stay inside governance cells as capacity. Delegation controls authority, not
            ownership. Close paths return funds through verified spend rules.
          </p>
          <div className="hero-chips">
            <span className="chip">Testnet</span>
            <span className="chip">6 operations</span>
            <span className="chip">Intent aggregation</span>
            <span className="chip">Delegation cells</span>
            <span className="chip">Permissionless force-close</span>
          </div>
          <div className="hero-note">
            This protocol uses intent cells for voting. Aggregation is a separate on-chain step -
            aggregate before deadline to keep tally state current.
          </div>
          <div style={{ marginTop: 12, fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--ink-3)" }}>
            Last synced {secondsSinceSync}s ago | auto-refresh every 30s
          </div>
        </div>

        <div className="stats-row" style={{ padding: "0 0 40px" }}>
          <div className="status-metric">
            <div className="metric-label">Current Epoch</div>
            <div className="metric-value">{currentEpoch.toString()}</div>
            <span className="status-pill status-pill-neutral" style={{ marginTop: 8 }}>Testnet</span>
          </div>
          <div className="status-metric">
            <div className="metric-label">Indexed Polls</div>
            <div className="metric-value">{polls.length}</div>
            <span className="status-pill status-pill-ok" style={{ marginTop: 8 }}>On-chain</span>
          </div>
          <div className="status-metric">
            <div className="metric-label">Active Delegations</div>
            <div className="metric-value">{delegations.length}</div>
            <span className="status-pill status-pill-ok" style={{ marginTop: 8 }}>Cells</span>
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
            {loadError && (
              <div className="alert alert-warn">
                <strong>Indexer query warning</strong>
                <div style={{ marginTop: 4 }}>{loadError}</div>
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
            isConnected={isConnected}
            voterAddress={address}
            voterLockHash={lockScriptHash}
            txState={txState}
            currentEpoch={currentEpoch}
            onVote={(poll, optionIndex, authorityId, weightUnits) =>
              castVote({ poll, optionIndex, authorityId, weightUnits })
            }
            onAggregate={aggregatePoll}
            onClose={closePoll}
            onForceClose={forceClose}
            onRefresh={() => {
              void syncDashboard();
            }}
            onConnectWallet={connect}
          />
        </Suspense>

        {isConnected && (
          <div id="creator-tools" style={{ marginTop: 20 }}>
            <div className="kicker" style={{ marginBottom: 10 }}>Creator and Delegation Tools</div>
            <div className="action-grid">
              <Suspense fallback={sectionFallback}>
                <DelegatePower
                  delegations={delegations}
                  txState={txState}
                  onDelegate={createDelegation}
                  onRevoke={revokeDelegation}
                />
              </Suspense>
              <Suspense fallback={sectionFallback}>
                <CreatePoll onSubmit={createPoll} txState={txState} />
              </Suspense>
            </div>
          </div>
        )}

        <div className="card-shell ui-enter-delay-1" style={{ marginBottom: 20, overflow: "hidden", padding: 0 }}>
          <div style={{ padding: "16px 24px 0", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div className="card-title">Protocol Timeline</div>
            <div className="card-sub">Live operation state</div>
          </div>

          <div className="protocol-strip">
            {protocolTimeline.map((step) => (
              <div key={step.op} className={`protocol-cell ${step.state}`}>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 9,
                    textTransform: "uppercase",
                    letterSpacing: "0.14em",
                    color:
                      step.state === "completed" ? "var(--teal)" : step.state === "live" ? "var(--amber)" : "var(--ink-3)",
                    marginBottom: 5,
                  }}
                >
                  {step.state === "completed" ? "Done" : step.state === "live" ? "Live" : "Pending"}
                </div>
                <div
                  style={{
                    fontFamily: "var(--font-mono)",
                    fontSize: 10,
                    color: "var(--ink-3)",
                    marginBottom: 3,
                    letterSpacing: "0.06em",
                  }}
                >
                  {step.op}
                </div>
                <div style={{ fontSize: 12, fontWeight: 500, color: step.state === "pending" ? "var(--ink-2)" : "var(--ink)" }}>
                  {step.label}
                </div>
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
