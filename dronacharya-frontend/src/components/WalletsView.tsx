import React, { useState } from "react";
import {
  Wallet,
  ExternalLink,
  Copy,
  Check,
  RefreshCw,
  ShieldCheck,
  Coins,
  ArrowUpRight,
  ArrowDownLeft,
  ChevronDown,
  ChevronRight,
  Loader2,
  History,
} from "lucide-react";
import { getWalletTransfers, type WalletInfo, type WalletTransfer } from "../api/client.ts";

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;

const TransferHistory: React.FC<{ address: string; labelOf: (a: string) => string | undefined }> = ({ address, labelOf }) => {
  const [state, setState] = useState<{ loading: boolean; error: string | null; rows: WalletTransfer[] }>({ loading: true, error: null, rows: [] });
  React.useEffect(() => {
    let live = true;
    void getWalletTransfers(address).then((res) => {
      if (live) setState({ loading: false, error: res.error, rows: res.data?.transfers ?? [] });
    });
    return () => {
      live = false;
    };
  }, [address]);

  if (state.loading)
    return (
      <div className="flex items-center gap-2 text-slate-400 py-3">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading USDC transfers from Etherscan…
      </div>
    );
  if (state.error) return <div className="text-amber-300 py-3">{state.error}</div>;
  if (state.rows.length === 0) return <div className="text-slate-500 py-3">No USDC transfers yet for this wallet.</div>;
  return (
    <table className="w-full text-left text-[11px]">
      <thead className="text-slate-500">
        <tr>
          <th className="py-1.5 pr-3 font-medium">When</th>
          <th className="py-1.5 pr-3 font-medium">Direction</th>
          <th className="py-1.5 pr-3 font-medium">Counterparty</th>
          <th className="py-1.5 pr-3 font-medium text-right">USDC</th>
          <th className="py-1.5 font-medium">Tx</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-[#1e2538]">
        {state.rows.map((t) => (
          <tr key={`${t.txHash}-${t.direction}-${t.counterparty}`}>
            <td className="py-1.5 pr-3 text-slate-400 whitespace-nowrap">{new Date(t.time).toLocaleString()}</td>
            <td className="py-1.5 pr-3">
              {t.direction === "out" ? (
                <span className="inline-flex items-center gap-1 text-rose-300"><ArrowUpRight className="h-3 w-3" /> sent</span>
              ) : t.direction === "in" ? (
                <span className="inline-flex items-center gap-1 text-emerald-300"><ArrowDownLeft className="h-3 w-3" /> received</span>
              ) : (
                <span className="text-slate-400">self</span>
              )}
            </td>
            <td className="py-1.5 pr-3 font-mono text-slate-300">
              {short(t.counterparty)}
              {labelOf(t.counterparty) && <span className="ml-1.5 font-sans text-purple-300">{labelOf(t.counterparty)}</span>}
            </td>
            <td className={`py-1.5 pr-3 text-right font-mono ${t.direction === "out" ? "text-rose-200" : "text-emerald-200"}`}>
              {t.direction === "out" ? "−" : "+"}
              {t.usdc}
            </td>
            <td className="py-1.5 font-mono">
              <a href={t.explorerUrl} target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:underline inline-flex items-center gap-1">
                {t.txHash.slice(0, 10)}… <ExternalLink className="h-3 w-3" />
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
};

interface WalletsViewProps {
  wallets: WalletInfo[];
  isLoading: boolean;
  onRefresh: () => void;
  explorerUrl?: string;
}

export const WalletsView: React.FC<WalletsViewProps> = ({
  wallets,
  isLoading,
  onRefresh,
  explorerUrl = "https://sepolia.basescan.org",
}) => {
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const labelOf = (a: string) => {
    const w = wallets.find((x) => x.address.toLowerCase() === a.toLowerCase());
    return w ? w.roles.map((r) => r.replace(/^payTo of /, "")).join(", ") : undefined;
  };

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 2000);
  };

  return (
    <div className="space-y-6 pb-16 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#1e2538]">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Wallet className="h-6 w-6 text-purple-400" />
            <span>Economy Wallets</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Participant addresses, roles, and live Base Sepolia testnet USDC balances
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={onRefresh}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[#121624] hover:bg-[#1a2030] text-slate-300 text-xs font-semibold border border-[#222b3d] transition-colors cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin text-purple-400" : ""}`} />
            <span>Refresh Balances</span>
          </button>
        </div>
      </div>

      {/* Info card */}
      <div className="p-4 rounded-2xl bg-[#121624] border border-[#222b3d] space-y-2 text-xs">
        <div className="flex items-center gap-2 text-purple-300 font-semibold">
          <ShieldCheck className="h-4 w-4" />
          <span>Server-Signed Micro-Payments on Base Sepolia</span>
        </div>
        <p className="text-slate-400 leading-relaxed">
          The Buyer Agent (Scout) holds a server-side testnet private key to sign EIP-3009 authorizations.
          Sellers hold no private keys on this server — they are public recipient addresses (<span className="font-mono text-purple-300">payTo</span>)
          that receive settled USDC on-chain. Faucet funds can be acquired from Circle's official Base Sepolia faucet.
        </p>
      </div>

      {/* Wallets Table */}
      <div className="rounded-2xl border border-[#222b3d] bg-[#121624] overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#1e2538] bg-[#0d101a] text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                <th className="py-3.5 px-4">Role</th>
                <th className="py-3.5 px-4">Address</th>
                <th className="py-3.5 px-4 text-right">USDC Balance</th>
                <th className="py-3.5 px-4 text-center">Explorer</th>
                <th className="py-3.5 px-4 text-center">History</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2538]">
              {wallets.length === 0 ? (
                <tr>
                  <td colSpan={5} className="py-8 text-center text-slate-400">
                    Loading wallet balances from Base Sepolia...
                  </td>
                </tr>
              ) : (
                wallets.map((w) => {
                  const isBuyer = w.roles.includes("buyer");
                  const isOpen = open === w.address;
                  return (
                    <React.Fragment key={w.address}>
                    <tr className="hover:bg-[#181f30] transition-colors">
                      {/* Role */}
                      <td className="py-3.5 px-4">
                        <div className="flex items-center gap-2">
                          <span
                            className={`px-2 py-0.5 rounded-md text-[11px] font-semibold uppercase tracking-wider border ${
                              isBuyer
                                ? "bg-purple-500/15 border-purple-500/30 text-purple-300 font-bold"
                                : "bg-indigo-500/10 border-indigo-500/20 text-indigo-300"
                            }`}
                          >
                            {w.roles.join(", ")}
                          </span>
                        </div>
                      </td>

                      {/* Address */}
                      <td className="py-3.5 px-4 font-mono text-slate-200">
                        <div className="flex items-center gap-2">
                          <span>{w.address}</span>
                          <button
                            onClick={() => copyAddress(w.address)}
                            className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/5 transition-colors cursor-pointer"
                            title="Copy full address"
                          >
                            {copiedAddr === w.address ? (
                              <Check className="h-3.5 w-3.5 text-emerald-400" />
                            ) : (
                              <Copy className="h-3.5 w-3.5" />
                            )}
                          </button>
                        </div>
                      </td>

                      {/* USDC Balance */}
                      <td className="py-3.5 px-4 text-right font-mono font-bold text-white text-xs">
                        {w.usdc ?? "0.000000"} USDC
                      </td>

                      {/* Explorer Link */}
                      <td className="py-3.5 px-4 text-center">
                        <a
                          href={w.explorerUrl || `${explorerUrl}/address/${w.address}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-flex items-center gap-1 text-purple-400 hover:text-purple-300 hover:underline font-mono text-xs"
                          title="View on Base Sepolia Basescan"
                        >
                          <span>Basescan</span>
                          <ExternalLink className="h-3 w-3" />
                        </a>
                      </td>

                      {/* Transfer history (Etherscan, server-side) */}
                      <td className="py-3.5 px-4 text-center">
                        <button
                          type="button"
                          onClick={() => setOpen(isOpen ? null : w.address)}
                          aria-expanded={isOpen}
                          className="inline-flex items-center gap-1 px-2 py-1 rounded-lg text-slate-300 hover:text-white hover:bg-white/5 transition-colors cursor-pointer"
                        >
                          {isOpen ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                          <History className="h-3.5 w-3.5" />
                          <span>Transfers</span>
                        </button>
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="bg-[#0d101a]">
                        <td colSpan={5} className="px-6 py-3">
                          <TransferHistory address={w.address} labelOf={labelOf} />
                        </td>
                      </tr>
                    )}
                    </React.Fragment>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
