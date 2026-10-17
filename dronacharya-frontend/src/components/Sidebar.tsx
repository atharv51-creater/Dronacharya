import React, { useState } from "react";
import {
  LayoutDashboard,
  Bot,
  Receipt,
  Store,
  Scale,
  Wallet,
  Copy,
  Check,
  ExternalLink,
  ChevronRight,
  Shield,
  Sparkles,
  UserPlus,
} from "lucide-react";
import type { NavTab } from "../types.ts";

interface SidebarProps {
  currentTab: NavTab;
  onTabChange: (tab: NavTab) => void;
  buyerAddress?: string;
  explorerUrl?: string;
}

export const Sidebar: React.FC<SidebarProps> = ({
  currentTab,
  onTabChange,
  buyerAddress = "0xDE11519b325147B01971b9645c4F620e7821f0A0",
  explorerUrl = "https://sepolia.basescan.org",
}) => {
  const [copied, setCopied] = useState(false);

  const copyAddress = () => {
    if (!buyerAddress) return;
    navigator.clipboard.writeText(buyerAddress);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const navItems: Array<{ id: NavTab; label: string; icon: React.FC<{ className?: string }>; desc: string }> = [
    {
      id: "overview",
      label: "Overview",
      icon: LayoutDashboard,
      desc: "System metrics & search",
    },
    {
      id: "arena",
      label: "Agent Arena",
      icon: Sparkles,
      desc: "Live coordination visualizer",
    },
    {
      id: "console",
      label: "Buyer Console",
      icon: Bot,
      desc: "Scout agent task executor",
    },
    {
      id: "transactions",
      label: "Transactions",
      icon: Receipt,
      desc: "Live verifiable ledger",
    },
    {
      id: "marketplace",
      label: "Marketplace",
      icon: Store,
      desc: "Registered x402 services",
    },
    {
      id: "reconcile",
      label: "Reconciliation",
      icon: Scale,
      desc: "Unit-exact on-chain audit",
    },
    {
      id: "wallets",
      label: "Wallets",
      icon: Wallet,
      desc: "Agent & seller balances",
    },
    {
      id: "portal",
      label: "Dronacharya Portal",
      icon: UserPlus,
      desc: "Registration & Sign-In",
    },
    {
      id: "admin",
      label: "Admin Registry",
      icon: Shield,
      desc: "Payment logs & audit report",
    },
  ];

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <aside className="w-64 shrink-0 flex flex-col justify-between border-r border-[#1e2536] bg-[#0c0f17] min-h-[calc(100vh-61px)] p-4 select-none">
      <div className="space-y-6">
        {/* Agent Wallet Card (Server-managed, strictly read-only, NO login / NO connect) */}
        <div className="rounded-xl border border-[#232c40] bg-[#121624] p-3.5 shadow-sm">
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-purple-400 flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-sm bg-purple-400" />
              Scout Agent Wallet
            </span>
            <span className="text-[10px] text-slate-400 font-mono bg-purple-500/10 px-1.5 py-0.5 rounded border border-purple-500/20">
              Backend
            </span>
          </div>

          <div className="flex items-center justify-between bg-[#0a0d14] rounded-lg p-2 border border-[#1b2233] mb-2 font-mono text-xs">
            <span className="text-slate-300 font-medium truncate" title={buyerAddress}>
              {shortAddr(buyerAddress)}
            </span>
            <div className="flex items-center gap-1">
              <button
                onClick={copyAddress}
                className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/5 transition-colors"
                title="Copy address"
              >
                {copied ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
              </button>
              <a
                href={`${explorerUrl}/address/${buyerAddress}`}
                target="_blank"
                rel="noopener noreferrer"
                className="p-1 text-slate-400 hover:text-white rounded hover:bg-white/5 transition-colors"
                title="View on Base Sepolia Basescan"
              >
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </div>

          <p className="text-[11px] text-slate-400 leading-relaxed">
            Signs EIP-3009 payment authorizations server-side. No browser wallet or key entry needed.
          </p>
        </div>

        {/* Navigation Links */}
        <nav className="space-y-1">
          <div className="px-3 pb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Navigation
          </div>
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentTab === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onTabChange(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-xl text-left transition-all group ${
                  isActive
                    ? "bg-purple-600/15 text-purple-300 border border-purple-500/30 font-semibold shadow-sm"
                    : "text-slate-400 hover:text-slate-200 hover:bg-[#141926] border border-transparent"
                }`}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <Icon
                    className={`h-4 w-4 shrink-0 transition-colors ${
                      isActive ? "text-purple-400" : "text-slate-400 group-hover:text-slate-200"
                    }`}
                  />
                  <div className="truncate">
                    <div className="text-sm leading-snug">{item.label}</div>
                    <div className="text-[11px] text-slate-400 truncate">{item.desc}</div>
                  </div>
                </div>
                {isActive && <ChevronRight className="h-4 w-4 text-purple-400 shrink-0" />}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Footer Info */}
      <div className="pt-4 border-t border-[#1e2536] space-y-2">
        <div className="flex items-center gap-2 text-xs text-slate-400">
          <Shield className="h-3.5 w-3.5 text-purple-400" />
          <span className="font-medium text-slate-300">Base Sepolia Only</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-snug">
          Chain ID 84532 · EIP-3009 USDC transferWithAuthorization over HTTP 402.
        </p>
      </div>
    </aside>
  );
};
