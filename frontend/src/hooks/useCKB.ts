/**
 * useCKB Hook
 * ===========
 * Provides wallet connection state and the CCC signer.
 * Must be wrapped in <Provider> from @ckb-ccc/connector-react.
 *
 * File: frontend/src/hooks/useCKB.ts
 * Usage:
 *   const { signer, address, isConnected, connect } = useCKB();
 */

import { useState, useEffect, useCallback } from "react";
import { ccc } from "@ckb-ccc/core";
import { useCcc, useSigner } from "@ckb-ccc/connector-react";
import { getSignerAddressObj } from "../lib/ckb";

export interface CKBState {
  signer:      ccc.Signer | null;
  address:     string | null;
  balance:     bigint;
  isConnected: boolean;
  isLoading:   boolean;
  error:       string | null;
  connect:     () => void;
  disconnect:  () => void;
  refreshBalance: () => Promise<void>;
}

export function useCKB(): CKBState {
  const { open, disconnect: cccDisconnect } = useCcc();
  const signer = useSigner() ?? null;

  const [address, setAddress]   = useState<string | null>(null);
  const [balance, setBalance]   = useState<bigint>(0n);
  const [isLoading, setLoading] = useState(false);
  const [error, setError]       = useState<string | null>(null);

  // Resolve address whenever signer changes
  useEffect(() => {
    if (!signer) {
      setAddress(null);
      setBalance(0n);
      return;
    }
    setLoading(true);
    getSignerAddressObj(signer as any)
      .then((addr) => setAddress(addr.toString()))
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [signer]);

  const refreshBalance = useCallback(async () => {
    if (!signer) return;
    try {
      const client = signer.client;
      const addr   = await getSignerAddressObj(signer as any);
      const bal    = await client.getBalanceSingle(addr.script);
      setBalance(bal);
    } catch (e) {
      setError(String(e));
    }
  }, [signer]);

  // Auto-refresh balance when address becomes available
  useEffect(() => {
    if (address) refreshBalance();
  }, [address, refreshBalance]);

  return {
    signer,
    address,
    balance,
    isConnected: !!signer && !!address,
    isLoading,
    error,
    connect:    open,
    disconnect: cccDisconnect,
    refreshBalance,
  };
}
