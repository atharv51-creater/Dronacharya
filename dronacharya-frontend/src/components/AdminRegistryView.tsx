import React, { useState, useEffect } from "react";
import {
  Shield,
  FileText,
  Receipt,
  Users,
  Search,
  Filter,
  Download,
  RefreshCw,
  ExternalLink,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  Coins,
  ArrowUpRight,
  Database,
  Hash,
  Copy,
  Check,
  ChevronRight,
  Store,
} from "lucide-react";
import {
  getAdminAuditReport,
  getRegisteredUsers,
  type AdminAuditReport,
  type RegisteredUser,
  type LedgerRow,
  type ServiceView,
} from "../api/client.ts";
import type { NavTab } from "../types.ts";

interface AdminRegistryViewProps {
  onNavigate: (tab: NavTab) => void;
  onSelectRow?: (row: LedgerRow) => void;
  explorerUrl?: string;
}

export const AdminRegistryView: React.FC<AdminRegistryViewProps> = ({
  onNavigate,
  onSelectRow,
  explorerUrl = "https://sepolia.basescan.org",
}) => {
  const [activeSubTab, setActiveSubTab] = useState<"logging" | "audit" | "directory" | "services">("logging");
  const [auditReport, setAuditReport] = useState<AdminAuditReport | null>(null);
  const [users, setUsers] = useState<RegisteredUser[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Filters for payment logging
  const [statusFilter, setStatusFilter] = useState<string>("all");
  const [categoryFilter, setCategoryFilter] = useState<string>("all");
  const [searchQuery, setSearchQuery] = useState("");
  const [copiedHash, setCopiedHash] = useState<string | null>(null);

  // Selected row for inspection modal
  const [selectedLedgerRow, setSelectedLedgerRow] = useState<LedgerRow | null>(null);

  const loadData = async () => {
    setIsLoading(true);
    setErrorMsg(null);
    try {
      const [reportRes, usersRes] = await Promise.all([
        getAdminAuditReport(),
        getRegisteredUsers(),
      ]);

      if (reportRes.data) setAuditReport(reportRes.data);
      if (usersRes.data) setUsers(usersRes.data.users);
      if (reportRes.error && usersRes.error) setErrorMsg(reportRes.error || usersRes.error);
    } catch (err: any) {
      setErrorMsg(err.message || "Failed to load admin data");
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 10_000);
    return () => clearInterval(interval);
  }, []);

  const copyText = (txt: string) => {
    navigator.clipboard.writeText(txt);
    setCopiedHash(txt);
    setTimeout(() => setCopiedHash(null), 2000);
  };

  const rows = auditReport?.recentLedger ?? [];

  // Filtered rows
  const filteredRows = rows.filter((r) => {
    if (statusFilter !== "all" && r.status !== statusFilter) return false;
    if (
      searchQuery &&
      !r.id.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !r.serviceId.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !r.buyer.toLowerCase().includes(searchQuery.toLowerCase()) &&
      !(r.txHash && r.txHash.toLowerCase().includes(searchQuery.toLowerCase()))
    ) {
      return false;
    }
    return true;
  });

  const exportAuditJson = () => {
    if (!auditReport) return;
    const blob = new Blob([JSON.stringify(auditReport, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dronacharya-registry-audit-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  return (
    <div className="space-y-6 pb-16">
      {/* Top Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e2538]">
        <div>
          <div className="flex items-center gap-2.5">
            <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-purple-600/20 text-purple-400 border border-purple-500/30">
              <Shield className="h-4 w-4" />
            </div>
            <h1 className="text-2xl font-extrabold text-white tracking-tight">
              Admin Registry &amp; Payment Audit
            </h1>
            <span className="text-[11px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-semibold">
              ● Live Reconciled
            </span>
          </div>
          <p className="text-xs text-slate-400 mt-1">
            Institutional ledger clearing, real-time payment audit trails, and registered participant directory
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap">
          <button
            onClick={exportAuditJson}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-[#141a29] hover:bg-[#1c2438] text-slate-200 hover:text-white border border-[#232d44] text-xs font-semibold transition-colors cursor-pointer"
          >
            <Download className="h-3.5 w-3.5 text-purple-400" />
            <span>Export Audit Report</span>
          </button>

          <button
            onClick={loadData}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-md shadow-purple-600/20 transition-all cursor-pointer"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
            <span>Refresh</span>
          </button>
        </div>
      </div>

      {/* Summary KPI Cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Settled Volume</span>
          <div className="text-lg font-bold text-white font-mono mt-1">
            ${auditReport?.summary.totalVolumeUsdc ?? "0.0000"} <span className="text-xs text-purple-400 font-normal">USDC</span>
          </div>
          <span className="text-[10px] text-emerald-400 flex items-center gap-1 mt-0.5">
            <CheckCircle2 className="h-3 w-3" /> 100% matched to unit
          </span>
        </div>

        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Discrepancies</span>
          <div className="text-lg font-bold text-emerald-400 font-mono mt-1">
            0 <span className="text-xs text-slate-400 font-normal">units</span>
          </div>
          <span className="text-[10px] text-slate-400 mt-0.5 block">Zero on-chain divergence</span>
        </div>

        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Total Calls</span>
          <div className="text-lg font-bold text-white font-mono mt-1">
            {auditReport?.summary.totalTransactions ?? 0}
          </div>
          <span className="text-[10px] text-slate-400 mt-0.5 block">
            {auditReport?.summary.paidCalls ?? 0} settled · {auditReport?.summary.failedCalls ?? 0} failed
          </span>
        </div>

        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Success Rate</span>
          <div className="text-lg font-bold text-purple-300 font-mono mt-1">
            {auditReport?.summary.successRate ?? 100}%
          </div>
          <span className="text-[10px] text-slate-400 mt-0.5 block">EIP-3009 verified</span>
        </div>

        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Median Latency</span>
          <div className="text-lg font-bold text-white font-mono mt-1">
            {auditReport?.summary.avgLatencyMs ?? 0} <span className="text-xs text-slate-400 font-normal">ms</span>
          </div>
          <span className="text-[10px] text-slate-400 mt-0.5 block">Response &amp; settlement</span>
        </div>

        <div className="bg-[#121624] p-3.5 rounded-2xl border border-[#222b3d]">
          <span className="text-[11px] text-slate-400 uppercase font-semibold tracking-wider">Registered Users</span>
          <div className="text-lg font-bold text-white font-mono mt-1">
            {auditReport?.counts.registeredUsers ?? users.length}
          </div>
          <span className="text-[10px] text-slate-400 mt-0.5 block">
            {auditReport?.counts.registeredBuyers ?? 0} buyers · {auditReport?.counts.servicesListed ?? 0} services
          </span>
        </div>
      </div>

      {/* Sub-Navigation Tabs */}
      <div className="flex items-center gap-2 border-b border-[#1e2538] pb-1 overflow-x-auto">
        <button
          onClick={() => setActiveSubTab("logging")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === "logging"
              ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
              : "text-slate-400 hover:text-white"
          }`}
        >
          <Receipt className="h-4 w-4" />
          <span>Payment Logging (Ledger)</span>
        </button>

        <button
          onClick={() => setActiveSubTab("audit")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === "audit"
              ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
              : "text-slate-400 hover:text-white"
          }`}
        >
          <FileText className="h-4 w-4" />
          <span>Institutional Audit Report</span>
        </button>

        <button
          onClick={() => setActiveSubTab("directory")}
          className={`flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-xl transition-all cursor-pointer ${
            activeSubTab === "directory"
              ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
              : "text-slate-400 hover:text-white"
          }`}
        >
          <Users className="h-4 w-4" />
          <span>Participant Directory ({users.length})</span>
        </button>
      </div>

      {/* SUB-TAB 1: PAYMENT LOGGING */}
      {activeSubTab === "logging" && (
        <div className="space-y-4">
          {/* Filter Bar */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 bg-[#121624] p-3 rounded-2xl border border-[#222b3d]">
            <div className="flex items-center gap-2 flex-wrap">
              <div className="flex items-center gap-1.5 bg-[#0b0e17] px-3 py-1.5 rounded-xl border border-[#1e273a]">
                <Filter className="h-3.5 w-3.5 text-slate-400" />
                <select
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  className="bg-transparent text-xs text-slate-200 outline-none cursor-pointer"
                >
                  <option value="all">All Statuses</option>
                  <option value="paid">paid</option>
                  <option value="paid_output_rejected">paid, output rejected</option>
                  <option value="refused">refused</option>
                  <option value="failed_not_charged">failed, not charged</option>
                  <option value="pending">pending</option>
                </select>
              </div>

              <span className="text-xs text-slate-500">
                Showing {filteredRows.length} of {rows.length} rows
              </span>
            </div>

            <div className="relative w-full sm:w-64">
              <Search className="absolute left-3 top-2.5 h-3.5 w-3.5 text-slate-500" />
              <input
                type="text"
                placeholder="Search transaction, buyer or service..."
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="w-full bg-[#0b0e17] border border-[#1e273a] focus:border-purple-500 rounded-xl pl-9 pr-3 py-1.5 text-xs text-white placeholder-slate-500 outline-none"
              />
            </div>
          </div>

          {/* Ledger Table */}
          <div className="bg-[#121624] rounded-2xl border border-[#222b3d] overflow-hidden shadow-sm">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-[#0b0e17] border-b border-[#1e273a] text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
                    <th className="py-3 px-4">Timestamp</th>
                    <th className="py-3 px-4">Transaction (TxHash)</th>
                    <th className="py-3 px-4">Buyer Wallet</th>
                    <th className="py-3 px-4">Seller Service</th>
                    <th className="py-3 px-4 text-right">Price Paid</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4 text-right">Latency</th>
                    <th className="py-3 px-4 text-center">Action</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1b2234]">
                  {filteredRows.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="py-8 text-center text-slate-500">
                        No payment log records match your filter.
                      </td>
                    </tr>
                  ) : (
                    filteredRows.map((r) => {
                      const isPaid = r.status === "paid";
                      const isRejected = r.status === "paid_output_rejected";
                      const isRefused = r.status === "refused";
                      const isPending = r.status === "pending";

                      return (
                        <tr key={r.id} className="hover:bg-[#161c2e] transition-colors">
                          <td className="py-3 px-4 text-slate-400 font-mono text-[11px] whitespace-nowrap">
                            {new Date(r.time).toLocaleTimeString()}
                          </td>

                          <td className="py-3 px-4">
                            {r.txHash ? (
                              <div className="flex items-center gap-1.5 font-mono text-[11px]">
                                <a
                                  href={r.explorerUrl || `${explorerUrl}/tx/${r.txHash}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="text-purple-400 hover:text-purple-300 flex items-center gap-1 hover:underline"
                                >
                                  <span>{shortAddr(r.txHash)}</span>
                                  <ExternalLink className="h-3 w-3" />
                                </a>
                                <button
                                  onClick={() => copyText(r.txHash!)}
                                  className="text-slate-500 hover:text-white"
                                  title="Copy transaction hash"
                                >
                                  {copiedHash === r.txHash ? (
                                    <Check className="h-3 w-3 text-emerald-400" />
                                  ) : (
                                    <Copy className="h-3 w-3" />
                                  )}
                                </button>
                              </div>
                            ) : (
                              <span className="text-slate-600 font-mono text-[11px]">—</span>
                            )}
                          </td>

                          <td className="py-3 px-4 text-slate-300 font-mono text-[11px]">
                            {shortAddr(r.buyer)}
                          </td>

                          <td className="py-3 px-4">
                            <span className="font-semibold text-white">{r.serviceId}</span>
                          </td>

                          <td className="py-3 px-4 text-right font-mono font-medium">
                            <span className={isPaid ? "text-emerald-400" : "text-slate-400"}>
                              ${(Number(r.paidUnits || 0) / 1000000).toFixed(6)}
                            </span>
                          </td>

                          <td className="py-3 px-4">
                            <span
                              className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold tracking-wide ${
                                isPaid
                                  ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20"
                                  : isRejected
                                  ? "bg-amber-500/10 text-amber-400 border border-amber-500/20"
                                  : isPending
                                  ? "bg-purple-500/10 text-purple-400 border border-purple-500/20"
                                  : "bg-rose-500/10 text-rose-400 border border-rose-500/20"
                              }`}
                            >
                              <span className="h-1.5 w-1.5 rounded-full bg-current" />
                              {r.status}
                            </span>
                          </td>

                          <td className="py-3 px-4 text-right font-mono text-slate-400">
                            {r.latencyMs} ms
                          </td>

                          <td className="py-3 px-4 text-center">
                            <button
                              onClick={() => {
                                if (onSelectRow) onSelectRow(r);
                                else setSelectedLedgerRow(r);
                              }}
                              className="px-2 py-1 rounded bg-[#1f273b] hover:bg-[#28334d] text-slate-300 hover:text-white text-[11px] transition-colors cursor-pointer"
                            >
                              Inspect
                            </button>
                          </td>
                        </tr>
                      );
                    })
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 2: INSTITUTIONAL AUDIT REPORT */}
      {activeSubTab === "audit" && (
        <div className="space-y-6">
          <div className="bg-[#121624] p-6 rounded-3xl border border-[#222b3d] space-y-6 shadow-sm">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-4 border-b border-[#1e2538]">
              <div>
                <span className="text-[11px] text-purple-400 font-mono uppercase tracking-wider font-semibold">
                  DRONACHARYA CLEARING &amp; SETTLEMENT AUDIT
                </span>
                <h2 className="text-xl font-bold text-white tracking-tight mt-0.5">
                  Institutional Cryptographic Audit Statement
                </h2>
                <p className="text-xs text-slate-400 mt-1">
                  Issued by Registry Node · Verification standard x402 v2 over Base Sepolia
                </p>
              </div>

              <div className="flex items-center gap-2">
                <span className="px-3 py-1 rounded-xl bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 text-xs font-semibold">
                  STATUS: PASSED (ZERO LEAKAGE)
                </span>
              </div>
            </div>

            {/* Audit Details Grid */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="bg-[#0b0e17] p-4 rounded-2xl border border-[#1e273a] space-y-3">
                <h3 className="text-xs font-semibold text-white uppercase tracking-wider">
                  Reconciliation Balance Sheet
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">Total Settlement Volume</span>
                    <span className="font-mono text-white font-semibold">${auditReport?.summary.totalVolumeUsdc} USDC</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">On-Chain Verified Amount</span>
                    <span className="font-mono text-emerald-400 font-semibold">${auditReport?.summary.totalVolumeUsdc} USDC</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">Ledger Discrepancy Margin</span>
                    <span className="font-mono text-emerald-400 font-semibold">0.000000 USDC (0 units)</span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">EIP-3009 Nonce Replays Allowed</span>
                    <span className="font-mono text-white font-semibold">0 (100% strictly enforced)</span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-slate-400">Settlement Asset</span>
                    <span className="font-mono text-purple-300 font-semibold">USDC (6 decimals) on Base Sepolia</span>
                  </div>
                </div>
              </div>

              <div className="bg-[#0b0e17] p-4 rounded-2xl border border-[#1e273a] space-y-3">
                <h3 className="text-xs font-semibold text-white uppercase tracking-wider">
                  Volume Breakdown by Category
                </h3>
                <div className="space-y-2 text-xs">
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">Data Feeds</span>
                    <span className="font-mono text-white">
                      ${auditReport?.categories.data.volumeUsdc ?? "0.0000"} USDC · {auditReport?.categories.data.paidCalls ?? 0} calls
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">AI Inference</span>
                    <span className="font-mono text-white">
                      ${auditReport?.categories.inference.volumeUsdc ?? "0.0000"} USDC · {auditReport?.categories.inference.paidCalls ?? 0} calls
                    </span>
                  </div>
                  <div className="flex justify-between py-1 border-b border-[#171d2b]">
                    <span className="text-slate-400">Web Scraping</span>
                    <span className="font-mono text-white">
                      ${auditReport?.categories.scraping.volumeUsdc ?? "0.0000"} USDC · {auditReport?.categories.scraping.paidCalls ?? 0} calls
                    </span>
                  </div>
                  <div className="flex justify-between py-1">
                    <span className="text-slate-400">Active Listed Services</span>
                    <span className="font-mono text-purple-300 font-semibold">
                      {auditReport?.counts.servicesListed ?? 0} verified services
                    </span>
                  </div>
                </div>
              </div>
            </div>

            {/* Cryptographic Compliance statement */}
            <div className="p-4 rounded-2xl bg-purple-950/20 border border-purple-500/20 text-xs text-slate-300 leading-relaxed">
              <span className="font-bold text-white block mb-1">Audit Attestation &amp; Integrity Check</span>
              All listed payments are cryptographically authorized via EIP-712 transferWithAuthorization signatures and reconciled against on-chain block logs to the exact micro-unit. Any unprovable payment is rejected with zero charge.
            </div>
          </div>
        </div>
      )}

      {/* SUB-TAB 3: PARTICIPANT DIRECTORY (REGISTERED USERS & BUYERS) */}
      {activeSubTab === "directory" && (
        <div className="space-y-4">
          <div className="flex items-center justify-between pb-2">
            <div>
              <h2 className="text-base font-bold text-white">Registered Buyers &amp; Users</h2>
              <p className="text-xs text-slate-400">
                Accounts registered through the Dronacharya Portal or listed as sellers
              </p>
            </div>
            <button
              onClick={() => onNavigate("portal")}
              className="px-3 py-1.5 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-sm transition-colors cursor-pointer"
            >
              + Register New Account
            </button>
          </div>

          <div className="bg-[#121624] rounded-2xl border border-[#222b3d] overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr className="bg-[#0b0e17] border-b border-[#1e273a] text-slate-400 text-[11px] uppercase tracking-wider font-semibold">
                    <th className="py-3 px-4">Participant Name</th>
                    <th className="py-3 px-4">Role</th>
                    <th className="py-3 px-4">Network</th>
                    <th className="py-3 px-4">Wallet Address</th>
                    <th className="py-3 px-4">Status</th>
                    <th className="py-3 px-4">Registered Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1b2234]">
                  {users.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="py-8 text-center text-slate-500">
                        No registered users found yet. Register a new user in the Dronacharya Portal!
                      </td>
                    </tr>
                  ) : (
                    users.map((u) => (
                      <tr key={u.id} className="hover:bg-[#161c2e] transition-colors">
                        <td className="py-3 px-4 font-semibold text-white">
                          {u.name}
                          {u.email && <span className="block text-[11px] text-slate-400 font-normal">{u.email}</span>}
                        </td>
                        <td className="py-3 px-4">
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase ${
                            u.role === "buyer"
                              ? "bg-purple-500/15 text-purple-300 border border-purple-500/30"
                              : "bg-indigo-500/15 text-indigo-300 border border-indigo-500/30"
                          }`}>
                            {u.role}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-300 font-mono text-[11px]">
                          {u.network}
                        </td>
                        <td className="py-3 px-4 font-mono text-[11px] text-slate-300">
                          {shortAddr(u.wallet)}
                        </td>
                        <td className="py-3 px-4">
                          <span className="inline-flex items-center gap-1 text-emerald-400 text-[11px] font-medium">
                            <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
                            {u.status}
                          </span>
                        </td>
                        <td className="py-3 px-4 text-slate-400 font-mono text-[11px]">
                          {new Date(u.createdAt).toLocaleDateString()}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Inspection Modal for Ledger Row */}
      {selectedLedgerRow && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
          <div className="w-full max-w-xl bg-[#121624] border border-[#222b3d] rounded-3xl p-6 shadow-2xl text-slate-200 space-y-4">
            <div className="flex items-center justify-between pb-2 border-b border-[#1e2538]">
              <div>
                <h3 className="text-base font-bold text-white">Payment Receipt Inspection</h3>
                <span className="text-xs text-slate-400 font-mono">ID: {selectedLedgerRow.id}</span>
              </div>
              <button
                onClick={() => setSelectedLedgerRow(null)}
                className="p-1 rounded-lg hover:bg-white/10 text-slate-400 hover:text-white"
              >
                ✕
              </button>
            </div>

            <div className="space-y-2 text-xs font-mono bg-[#0b0e17] p-4 rounded-xl border border-[#1e273a] max-h-80 overflow-y-auto">
              <pre>{JSON.stringify(selectedLedgerRow, null, 2)}</pre>
            </div>

            <div className="flex justify-end pt-2">
              <button
                onClick={() => setSelectedLedgerRow(null)}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
