import React, { useState } from "react";
import {
  Search,
  ExternalLink,
  ShieldCheck,
  Zap,
  ArrowRight,
  Database,
  Lock,
  Layers,
  Terminal,
  Cpu,
  BarChart3,
  Bot,
} from "lucide-react";
import type { NavTab } from "../types.ts";

interface OverviewViewProps {
  onNavigate: (tab: NavTab) => void;
  buyerAddress?: string;
  totalTransactions: number;
  totalVolumeUsdc: string;
  totalServices: number;
  explorerUrl?: string;
}

export const OverviewView: React.FC<OverviewViewProps> = ({
  onNavigate,
  buyerAddress = "0xDE11519b325147B01971b9645c4F620e7821f0A0",
  totalTransactions,
  totalVolumeUsdc,
  totalServices,
  explorerUrl = "https://sepolia.basescan.org",
}) => {
  const [searchInput, setSearchInput] = useState("");

  const handleInspect = (e: React.FormEvent) => {
    e.preventDefault();
    const query = searchInput.trim();
    if (!query) return;

    if (query.startsWith("0x") && query.length === 66) {
      // Transaction hash
      window.open(`${explorerUrl}/tx/${query}`, "_blank", "noopener,noreferrer");
    } else if (query.startsWith("0x") && query.length === 42) {
      // Address
      window.open(`${explorerUrl}/address/${query}`, "_blank", "noopener,noreferrer");
    } else {
      // Navigate to transactions table and search
      onNavigate("transactions");
    }
  };

  return (
    <div className="space-y-12 pb-16 max-w-6xl mx-auto">
      {/* Hero Section (Replicating Screenshot 1) */}
      <section className="text-center pt-8 sm:pt-14 space-y-6">
        <div className="text-xs uppercase tracking-widest font-semibold text-purple-400 font-mono">
          Base Sepolia · x402 v2 Agent Economy
        </div>

        <h1 className="text-3xl sm:text-5xl font-extrabold tracking-tight text-white max-w-4xl mx-auto leading-tight">
          Autonomous Pay-Per-Call Agent Economy on{" "}
          <span className="bg-gradient-to-r from-purple-400 via-indigo-300 to-purple-500 bg-clip-text text-transparent">
            Base Sepolia
          </span>
        </h1>

        <p className="text-slate-300 text-sm sm:text-base max-w-2xl mx-auto leading-relaxed">
          Dronacharya enables buyer agent Scout to discover and hire specialized seller agents on-demand,
          paying per request in testnet USDC over HTTP x402 v2 with EIP-3009 gasless authorizations
          and verified on-chain settlements.
        </p>

        {/* Global Explorer Lookup Input */}
        <form onSubmit={handleInspect} className="max-w-2xl mx-auto pt-2">
          <div className="relative flex items-center rounded-2xl bg-[#121624] border border-[#232c40] p-1.5 shadow-2xl focus-within:border-purple-500/60 focus-within:ring-2 focus-within:ring-purple-500/20 transition-all">
            <Search className="h-5 w-5 text-slate-500 ml-3 shrink-0" />
            <input
              type="text"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              placeholder="Look up a Base Sepolia address, transaction hash, or session ID..."
              className="w-full bg-transparent px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none"
            />
            <button
              type="submit"
              className="flex items-center gap-1.5 px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white rounded-xl text-xs font-semibold shadow-lg shadow-purple-600/20 transition-all shrink-0 cursor-pointer"
            >
              <span>Inspect on Basescan</span>
              <ExternalLink className="h-3.5 w-3.5" />
            </button>
          </div>
        </form>

        {/* CTAs */}
        <div className="flex items-center justify-center gap-3 pt-2 flex-wrap">
          <button
            onClick={() => onNavigate("arena")}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-sm shadow-lg shadow-purple-600/30 transition-all cursor-pointer"
          >
            <Zap className="h-4 w-4" />
            <span>Launch Agent Arena</span>
          </button>
          <button
            onClick={() => onNavigate("console")}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#161b2b] hover:bg-[#1e253b] text-slate-200 border border-[#263147] font-semibold text-sm transition-all cursor-pointer"
          >
            <span>Buyer Console</span>
            <ArrowRight className="h-4 w-4" />
          </button>
          <button
            onClick={() => onNavigate("transactions")}
            className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-[#161b2b] hover:bg-[#1e253b] text-slate-200 border border-[#263147] font-semibold text-sm transition-all cursor-pointer"
          >
            <span>View Live Ledger</span>
          </button>
        </div>
      </section>

      {/* 4 Feature Metric Cards (Replicating Screenshot 1) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm hover:border-purple-500/40 transition-colors">
          <div className="text-2xl font-bold text-white tracking-tight font-mono">$0.001+</div>
          <div className="text-xs font-semibold text-purple-400 mt-1 uppercase tracking-wider">
            Per-Call Settlements
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Pay-per-request via EIP-3009 signed authorizations. No subscriptions or minimum deposits.
          </p>
        </div>

        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm hover:border-purple-500/40 transition-colors">
          <div className="text-2xl font-bold text-white tracking-tight font-mono">100%</div>
          <div className="text-xs font-semibold text-emerald-400 mt-1 uppercase tracking-wider">
            On-Chain Verified
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Every paid call confirms against the Base Sepolia Transfer event log before row completion.
          </p>
        </div>

        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm hover:border-purple-500/40 transition-colors">
          <div className="text-2xl font-bold text-white tracking-tight font-mono">x402 v2</div>
          <div className="text-xs font-semibold text-indigo-400 mt-1 uppercase tracking-wider">
            HTTP Standard
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Native HTTP 402 Payment Required negotiation protocol with replay and deadline protection.
          </p>
        </div>

        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm hover:border-purple-500/40 transition-colors">
          <div className="text-2xl font-bold text-white tracking-tight font-mono">&lt; 2.0s</div>
          <div className="text-xs font-semibold text-amber-400 mt-1 uppercase tracking-wider">
            Base Sepolia Finality
          </div>
          <p className="text-xs text-slate-400 mt-2 leading-relaxed">
            Near-instant settlement on Ethereum L2 with gas sponsored by the x402 facilitator.
          </p>
        </div>
      </section>

      {/* How It Works Architecture Overview */}
      <section className="rounded-2xl border border-[#222b3d] bg-[#101420] p-6 sm:p-8 space-y-6">
        <div>
          <h2 className="text-xl font-bold text-white">How the Agent Economy Operates</h2>
          <p className="text-sm text-slate-400 mt-1">
            Agents hire agents autonomously without API keys, invoices, or human approval.
          </p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <div className="p-5 rounded-xl bg-[#141926] border border-[#232c40] space-y-3">
            <div className="h-10 w-10 rounded-xl bg-purple-500/15 border border-purple-500/30 flex items-center justify-center text-purple-400">
              <Bot className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-white text-base">1. Scout Plans & Selects</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Scout parses user goals, calculates exact per-call USDC units, and filters marketplace sellers
              by price, reputation success rate, and median latency.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-[#141926] border border-[#232c40] space-y-3">
            <div className="h-10 w-10 rounded-xl bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
              <Zap className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-white text-base">2. 402 Handshake & Execution</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Sellers respond with HTTP 402 and payment parameters. Scout signs authorization with its
              server wallet. If output is invalid, the call is rejected and never settled.
            </p>
          </div>

          <div className="p-5 rounded-xl bg-[#141926] border border-[#232c40] space-y-3">
            <div className="h-10 w-10 rounded-xl bg-emerald-500/15 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
              <ShieldCheck className="h-5 w-5" />
            </div>
            <h3 className="font-semibold text-white text-base">3. Unit-Exact Reconciliation</h3>
            <p className="text-xs text-slate-400 leading-relaxed">
              Every completed call logs on-chain hash and nonce. The reconciliation engine scans Base
              Sepolia USDC Transfer logs to verify that ledger units match on-chain transfers to the micro-unit.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
};
