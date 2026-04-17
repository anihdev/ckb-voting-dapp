/**
 * App.tsx
 * =======
 * Root component. Wires CCC with an explicit testnet client, adds a runtime
 * error boundary, and renders a more intentional production shell.
 */

import React, { Component, Suspense, lazy, useEffect, useState } from "react";
import { Provider } from "@ckb-ccc/connector-react";
import { ccc } from "@ckb-ccc/core";
import { useCKB } from "./hooks/useCKB";
import { usePolls } from "./hooks/usePolls";
import { CKB_RPC_URL, getTipEpoch, validateRuntimeConfig } from "./lib/ckb";
import { WalletConnect } from "./components/WalletConnect";

const CreatePoll = lazy(() =>
  import("./components/CreatePoll").then((module) => ({ default: module.CreatePoll }))
);
const DelegatePower = lazy(() =>
  import("./components/DelegatePower").then((module) => ({ default: module.DelegatePower }))
);
const PollList = lazy(() =>
  import("./components/PollList").then((module) => ({ default: module.PollList }))
);

const defaultClient = new ccc.ClientPublicTestnet({ url: CKB_RPC_URL });

class AppErrorBoundary extends Component<
  { children: React.ReactNode },
  { error: string | null }
> {
  state = { error: null as string | null };

  static getDerivedStateFromError(error: Error) {
    return { error: error.message || "Unknown runtime error" };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-screen bg-[radial-gradient(circle_at_top,_#f6e8d8,_#efe9df_40%,_#d7d4cb_100%)] px-4 py-10">
          <div className="mx-auto max-w-3xl rounded-[28px] border border-stone-300/70 bg-white/85 p-8 shadow-[0_24px_70px_rgba(63,49,35,0.14)] backdrop-blur">
            <div className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-rose-700">
              Runtime Error
            </div>
            <h1 className="font-['Iowan_Old_Style','Palatino_Linotype','Book_Antiqua',Georgia,serif] text-3xl text-stone-900">
              The app hit a client-side error instead of rendering a blank page.
            </h1>
            <p className="mt-4 rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
              {this.state.error}
            </p>
            <p className="mt-4 text-sm text-stone-600">
              Refresh after reconnecting the wallet. If this persists, the current message is now visible for debugging.
            </p>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}

function InnerApp() {
  const configError = validateRuntimeConfig();
  const { signer, address, isConnected, error: walletError } = useCKB();
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
    createDelegation,
    revokeDelegation,
  } = usePolls(signer);

  const [currentEpoch, setCurrentEpoch] = useState<bigint>(0n);

  useEffect(() => {
    if (signer) {
      fetchPolls().catch(console.error);
      getTipEpoch(signer.client).then(setCurrentEpoch).catch(console.error);
    }
  }, [signer, fetchPolls]);

  const sectionFallback = (
    <div className="rounded-[24px] border border-stone-300/60 bg-white/80 px-5 py-6 text-sm text-stone-500 shadow-[0_14px_40px_rgba(68,55,40,0.08)] backdrop-blur">
      Loading interface...
    </div>
  );

  return (
    <div className="min-h-screen overflow-x-hidden bg-[radial-gradient(circle_at_top,_#f5ead8,_#efe8dc_32%,_#e5e1d8_58%,_#d6d1c9_100%)] text-stone-900">
      <div className="pointer-events-none fixed inset-0 bg-[linear-gradient(120deg,rgba(104,72,41,0.06),transparent_40%,rgba(28,65,67,0.06))]" />

      <nav className="sticky top-0 z-50 border-b border-stone-300/50 bg-white/70 backdrop-blur-xl">
        <div className="mx-auto flex h-20 max-w-6xl items-center justify-between px-5">
          <div className="flex items-center gap-4">
            <div className="grid h-12 w-12 place-items-center rounded-2xl border border-stone-300/70 bg-stone-900 text-lg text-stone-50 shadow-[0_10px_24px_rgba(41,31,24,0.25)]">
              CG
            </div>
            <div>
              <div className="font-['Iowan_Old_Style','Palatino_Linotype','Book_Antiqua',Georgia,serif] text-2xl leading-tight text-stone-900">
                CKB Governance
              </div>
              <div className="text-xs uppercase tracking-[0.24em] text-stone-500">
                Intent-cell protocol on Nervos
              </div>
            </div>
          </div>
          <WalletConnect />
        </div>
      </nav>

      <main className="relative mx-auto max-w-6xl px-5 py-10">
        <section className="grid gap-6 lg:grid-cols-[1.4fr,0.9fr]">
          <div className="rounded-[34px] border border-stone-300/60 bg-white/78 p-7 shadow-[0_30px_80px_rgba(52,39,28,0.13)] backdrop-blur">
            <div className="mb-4 text-xs font-semibold uppercase tracking-[0.28em] text-amber-800">
              Live Testnet Deployment
            </div>
            <h1 className="max-w-3xl font-['Iowan_Old_Style','Palatino_Linotype','Book_Antiqua',Georgia,serif] text-4xl leading-tight text-stone-900 sm:text-5xl">
              Deposit-backed governance with independent vote intents, delegation, and close-time refunds.
            </h1>
            <p className="mt-4 max-w-2xl text-sm leading-7 text-stone-600 sm:text-base">
              This app is designed around the CKB cell model. Votes are recorded as separate intent cells, aggregation updates shared tally state in batches, and refunds follow verified spend paths.
            </p>
            <div className="mt-6 flex flex-wrap gap-3 text-xs font-medium uppercase tracking-[0.18em] text-stone-600">
              <span className="rounded-full border border-stone-300/70 bg-stone-50 px-4 py-2">Testnet</span>
              <span className="rounded-full border border-stone-300/70 bg-stone-50 px-4 py-2">6 operations</span>
              <span className="rounded-full border border-stone-300/70 bg-stone-50 px-4 py-2">Intent aggregation</span>
              <span className="rounded-full border border-stone-300/70 bg-stone-50 px-4 py-2">Delegation cells</span>
            </div>
          </div>

          <div className="rounded-[34px] border border-stone-300/60 bg-stone-900 p-7 text-stone-100 shadow-[0_30px_80px_rgba(31,25,21,0.24)]">
            <div className="mb-4 text-xs font-semibold uppercase tracking-[0.28em] text-stone-300">
              Network Status
            </div>
            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-1">
              <div className="rounded-2xl border border-stone-700 bg-stone-800/80 px-4 py-4">
                <div className="text-xs uppercase tracking-[0.2em] text-stone-400">Current Epoch</div>
                <div className="mt-2 text-2xl font-semibold">{currentEpoch.toString()}</div>
              </div>
              <div className="rounded-2xl border border-stone-700 bg-stone-800/80 px-4 py-4">
                <div className="text-xs uppercase tracking-[0.2em] text-stone-400">Indexed Polls</div>
                <div className="mt-2 text-2xl font-semibold">{polls.length}</div>
              </div>
              <div className="rounded-2xl border border-stone-700 bg-stone-800/80 px-4 py-4">
                <div className="text-xs uppercase tracking-[0.2em] text-stone-400">Active Delegations</div>
                <div className="mt-2 text-2xl font-semibold">{delegations.length}</div>
              </div>
              <div className="rounded-2xl border border-stone-700 bg-stone-800/80 px-4 py-4">
                <div className="text-xs uppercase tracking-[0.2em] text-stone-400">Wallet</div>
                <div className="mt-2 text-sm text-stone-300">
                  {isConnected && address ? `${address.slice(0, 16)}...${address.slice(-10)}` : "Not connected"}
                </div>
              </div>
            </div>
          </div>
        </section>

        <div className="mt-8 space-y-5">
          {configError && (
            <div className="rounded-2xl border border-rose-200 bg-rose-50 px-5 py-4 text-sm text-rose-700 shadow-sm">
              <div className="font-semibold">Deployment config required</div>
              <div className="mt-1">{configError}</div>
              <div className="mt-2 text-xs text-rose-600">Current RPC: {CKB_RPC_URL}</div>
            </div>
          )}

          {walletError && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 shadow-sm">
              <div className="font-semibold">Wallet connection warning</div>
              <div className="mt-1">{walletError}</div>
            </div>
          )}

          {loadError && (
            <div className="rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-800 shadow-sm">
              <div className="font-semibold">Indexer query warning</div>
              <div className="mt-1">{loadError}</div>
            </div>
          )}
        </div>

        {!isConnected && (
          <section className="mt-8 rounded-[32px] border border-stone-300/60 bg-white/75 p-8 shadow-[0_24px_60px_rgba(63,49,35,0.12)] backdrop-blur">
            <div className="max-w-3xl">
              <div className="mb-3 text-xs font-semibold uppercase tracking-[0.28em] text-stone-500">
                Connect To Continue
              </div>
              <h2 className="font-['Iowan_Old_Style','Palatino_Linotype','Book_Antiqua',Georgia,serif] text-3xl text-stone-900">
                Connect a CKB wallet to create polls, vote with intents, aggregate results, and test the live refund flow.
              </h2>
              <p className="mt-4 text-sm leading-7 text-stone-600">
                The hosted app uses CKB testnet. If your wallet has no funds yet, use the faucet below before submitting transactions.
              </p>
              <div className="mt-5">
                <a
                  href="https://faucet.nervos.org/"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex rounded-full border border-stone-300 bg-stone-900 px-5 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
                >
                  Open Testnet Faucet
                </a>
              </div>
            </div>
          </section>
        )}

        <div className="mt-8 grid gap-6 xl:grid-cols-[1fr,1fr]">
          {isConnected && (
            <Suspense fallback={sectionFallback}>
              <CreatePoll onSubmit={createPoll} txState={txState} />
            </Suspense>
          )}

          {isConnected && (
            <Suspense fallback={sectionFallback}>
              <DelegatePower
                delegations={delegations}
                txState={txState}
                onDelegate={createDelegation}
                onRevoke={revokeDelegation}
              />
            </Suspense>
          )}
        </div>

        <div className="mt-8">
          <Suspense fallback={sectionFallback}>
            <PollList
              polls={polls}
              loading={loading}
              voterAddress={address}
              txState={txState}
              currentEpoch={currentEpoch}
              onVote={(poll, optionIndex, authorityId) => castVote({ poll, optionIndex, authorityId })}
              onAggregate={aggregatePoll}
              onClose={closePoll}
              onRefresh={fetchPolls}
            />
          </Suspense>
        </div>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AppErrorBoundary>
      <Provider
        defaultClient={defaultClient}
        clientOptions={[
          {
            client: defaultClient,
            name: "CKB Testnet",
          },
        ]}
      >
        <InnerApp />
      </Provider>
    </AppErrorBoundary>
  );
}
