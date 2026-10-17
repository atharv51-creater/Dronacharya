import React, { useState, useMemo } from "react";
import {
  Search,
  Filter,
  ArrowUpDown,
  Download,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  Clock,
  ChevronRight,
  Eye,
} from "lucide-react";
import type { LedgerRow } from "../api/client.ts";

interface TransactionsViewProps {
  rows: LedgerRow[];
  isLoading: boolean;
  onRefresh: () => void;
  onSelectRow: (row: LedgerRow) => void;
  explorerUrl?: string;
  isSimulatedReplay?: boolean;
}

export const TransactionsView: React.FC<TransactionsViewProps> = ({
  rows,
  isLoading,
  onRefresh,
  onSelectRow,
  explorerUrl = "https://sepolia.basescan.org",
  isSimulatedReplay = false,
}) => {
  const [searchTerm, setSearchTerm] = useState("");
  const [selectedEndpoint, setSelectedEndpoint] = useState<string>("all");
  const [selectedStatus, setSelectedStatus] = useState<string>("all");
  const [sortBy, setSortBy] = useState<"newest" | "oldest" | "amount_desc" | "latency">("newest");

  // Format USDC from units
  const formatUsdc = (units: string | null | undefined): string => {
    if (units == null) return "0.000000";
    try {
      const u = BigInt(units);
      const whole = u / 1000000n;
      const frac = (u % 1000000n).toString().padStart(6, "0");
      return `${whole}.${frac}`;
    } catch {
      return "0.000000";
    }
  };

  const shortHash = (hash: string | null): string => {
    if (!hash) return "-";
    if (hash.length <= 14) return hash;
    return `${hash.slice(0, 8)}...${hash.slice(-6)}`;
  };

  // Distinct endpoints for the filter dropdown
  const distinctEndpoints = useMemo(() => {
    const set = new Set<string>();
    rows.forEach((r) => {
      if (r.serviceId) set.add(r.serviceId);
      else if (r.endpoint) set.add(r.endpoint);
    });
    return Array.from(set);
  }, [rows]);

  // Filtered rows
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      const matchesSearch =
        !searchTerm ||
        r.id.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (r.txHash && r.txHash.toLowerCase().includes(searchTerm.toLowerCase())) ||
        r.serviceId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.sellerId.toLowerCase().includes(searchTerm.toLowerCase()) ||
        r.endpoint.toLowerCase().includes(searchTerm.toLowerCase()) ||
        (r.reason && r.reason.toLowerCase().includes(searchTerm.toLowerCase()));

      const matchesEndpoint =
        selectedEndpoint === "all" || r.serviceId === selectedEndpoint || r.endpoint === selectedEndpoint;

      const matchesStatus = selectedStatus === "all" || r.status === selectedStatus;

      return matchesSearch && matchesEndpoint && matchesStatus;
    });
  }, [rows, searchTerm, selectedEndpoint, selectedStatus]);

  // Sorted rows
  const sortedRows = useMemo(() => {
    return [...filteredRows].sort((a, b) => {
      if (sortBy === "newest") return b.time.localeCompare(a.time);
      if (sortBy === "oldest") return a.time.localeCompare(b.time);
      if (sortBy === "amount_desc") {
        const amtA = BigInt(a.paidUnits || 0);
        const amtB = BigInt(b.paidUnits || 0);
        return amtA < amtB ? 1 : -1;
      }
      if (sortBy === "latency") return b.latencyMs - a.latencyMs;
      return 0;
    });
  }, [filteredRows, sortBy]);

  // Metric cards calculations (matching Screenshot 3)
  const metrics = useMemo(() => {
    let totalVerified = 0;
    let volumeUnits = 0n;
    let rejectedAttempts = 0;

    rows.forEach((r) => {
      if (r.status === "paid" || r.status === "paid_output_rejected") {
        totalVerified++;
        volumeUnits += BigInt(r.paidUnits || 0);
      }
      if (r.status === "refused" || r.status === "paid_output_rejected" || r.status === "failed_not_charged") {
        rejectedAttempts++;
      }
    });

    return {
      totalVerified,
      volumeUsdc: formatUsdc(volumeUnits.toString()),
      shownOnPage: sortedRows.length,
      distinctEndpointsCount: distinctEndpoints.length,
      rejectedAttempts,
    };
  }, [rows, sortedRows, distinctEndpoints]);

  // Export functions
  const exportCsv = () => {
    const headers = [
      "ID",
      "Time",
      "SessionId",
      "Service",
      "Seller",
      "Endpoint",
      "Status",
      "PaidUnits",
      "PaidUSDC",
      "TxHash",
      "LatencyMs",
      "OnchainConfirmed",
    ];
    const lines = sortedRows.map((r) => [
      r.id,
      r.time,
      r.sessionId,
      r.serviceId,
      r.sellerId,
      r.endpoint,
      r.status,
      r.paidUnits,
      formatUsdc(r.paidUnits),
      r.txHash || "",
      r.latencyMs,
      r.onchainConfirmed ? "true" : "false",
    ]);

    const csvContent =
      "data:text/csv;charset=utf-8," +
      [headers.join(","), ...lines.map((l) => l.map((v) => `"${v}"`).join(","))].join("\n");
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement("a");
    link.setAttribute("href", encodedUri);
    link.setAttribute("download", `dronacharya-ledger-${new Date().toISOString().slice(0, 10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const getStatusBadge = (status: LedgerRow["status"]) => {
    switch (status) {
      case "paid":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">
            <CheckCircle2 className="h-3 w-3 text-emerald-400" />
            <span>paid</span>
          </span>
        );
      case "paid_output_rejected":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-rose-500/15 text-rose-300 border border-rose-500/30">
            <AlertTriangle className="h-3 w-3 text-rose-400" />
            <span>paid, output rejected</span>
          </span>
        );
      case "refused":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-amber-500/15 text-amber-300 border border-amber-500/30">
            <XCircle className="h-3 w-3 text-amber-400" />
            <span>refused</span>
          </span>
        );
      case "failed_not_charged":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-slate-500/15 text-slate-300 border border-slate-500/30">
            <Clock className="h-3 w-3 text-slate-400" />
            <span>failed, not charged</span>
          </span>
        );
      case "pending":
      default:
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-md text-xs font-semibold bg-sky-500/15 text-sky-300 border border-sky-500/30">
            <Clock className="h-3 w-3 text-sky-400 animate-spin" />
            <span>pending</span>
          </span>
        );
    }
  };

  return (
    <div className="space-y-6 pb-12">
      {/* 4 Metric Summary Cards (Replicating Screenshot 3) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Verified Transactions */}
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Verified Transactions
          </div>
          <div className="text-3xl font-extrabold text-white mt-1.5 tracking-tight font-mono">
            {metrics.totalVerified}
          </div>
          <div className="text-xs text-purple-400 font-mono mt-1">
            {metrics.volumeUsdc} USDC loaded volume
          </div>
        </div>

        {/* Card 2: Shown On This Page */}
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Shown On This Page
          </div>
          <div className="text-3xl font-extrabold text-white mt-1.5 tracking-tight font-mono">
            {metrics.shownOnPage}
          </div>
          <div className="text-xs text-slate-400 mt-1">Most recent, loaded from server</div>
        </div>

        {/* Card 3: Distinct Endpoints */}
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Distinct Endpoints
          </div>
          <div className="text-3xl font-extrabold text-white mt-1.5 tracking-tight font-mono">
            {metrics.distinctEndpointsCount}
          </div>
          <div className="text-xs text-slate-400 mt-1">Routes logged under this service</div>
        </div>

        {/* Card 4: Rejected Attempts */}
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm">
          <div className="text-xs font-medium text-slate-400 uppercase tracking-wider">
            Rejected Attempts
          </div>
          <div className="text-3xl font-extrabold text-rose-400 mt-1.5 tracking-tight font-mono">
            {metrics.rejectedAttempts}
          </div>
          <div className="text-xs text-rose-400/80 mt-1">Unsettled or output violation</div>
        </div>
      </div>

      {/* Filter and Control Bar (Replicating Screenshot 3) */}
      <div className="flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-3 bg-[#121624] p-3 rounded-2xl border border-[#222b3d]">
        <div className="flex items-center gap-2 flex-1 min-w-0">
          <div className="relative flex-1">
            <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Search Tx ID, endpoint, service, reason..."
              className="w-full bg-[#0a0d14] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 border border-[#1e2638] focus:outline-none focus:border-purple-500"
            />
          </div>

          {/* Endpoint Filter */}
          <select
            value={selectedEndpoint}
            onChange={(e) => setSelectedEndpoint(e.target.value)}
            className="bg-[#0a0d14] text-xs text-slate-300 rounded-xl px-3 py-2 border border-[#1e2638] focus:outline-none focus:border-purple-500 cursor-pointer shrink-0"
          >
            <option value="all">All Endpoints</option>
            {distinctEndpoints.map((ep) => (
              <option key={ep} value={ep}>
                {ep}
              </option>
            ))}
          </select>

          {/* Status Filter */}
          <select
            value={selectedStatus}
            onChange={(e) => setSelectedStatus(e.target.value)}
            className="bg-[#0a0d14] text-xs text-slate-300 rounded-xl px-3 py-2 border border-[#1e2638] focus:outline-none focus:border-purple-500 cursor-pointer shrink-0"
          >
            <option value="all">All Statuses</option>
            <option value="paid">paid</option>
            <option value="paid_output_rejected">paid, output rejected</option>
            <option value="refused">refused</option>
            <option value="failed_not_charged">failed, not charged</option>
            <option value="pending">pending</option>
          </select>

          {/* Sort order */}
          <select
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as any)}
            className="bg-[#0a0d14] text-xs text-slate-300 rounded-xl px-3 py-2 border border-[#1e2638] focus:outline-none focus:border-purple-500 cursor-pointer shrink-0 hidden md:block"
          >
            <option value="newest">newest first</option>
            <option value="oldest">oldest first</option>
            <option value="amount_desc">highest amount</option>
            <option value="latency">highest latency</option>
          </select>
        </div>

        {/* Action buttons */}
        <div className="flex items-center gap-2 self-end sm:self-auto">
          <button
            onClick={exportCsv}
            disabled={sortedRows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-semibold shadow-sm transition-all cursor-pointer"
          >
            <Download className="h-3.5 w-3.5" />
            <span>Export CSV</span>
          </button>
          <button
            onClick={onRefresh}
            className="p-2 rounded-xl bg-[#0a0d14] hover:bg-[#1a2030] text-slate-400 hover:text-white border border-[#1e2638] transition-colors cursor-pointer"
            title="Refresh transactions from backend"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? "animate-spin text-purple-400" : ""}`} />
          </button>
        </div>
      </div>

      {/* Main Table (Replicating Screenshot 3) */}
      <div className="rounded-2xl border border-[#222b3d] bg-[#121624] overflow-hidden shadow-sm">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[#1e2638] bg-[#0d101a] text-slate-400 font-semibold uppercase tracking-wider text-[11px]">
                <th className="py-3 px-4">TRANSACTION_ID</th>
                <th className="py-3 px-4">ENDPOINT</th>
                <th className="py-3 px-4 text-right">AMOUNT</th>
                <th className="py-3 px-4">DATE &amp; TIME</th>
                <th className="py-3 px-4">STATUS</th>
                <th className="py-3 px-4 text-right">LATENCY</th>
                <th className="py-3 px-4 text-center">PROOF</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2638]">
              {sortedRows.length === 0 ? (
                <tr>
                  <td colSpan={7} className="py-12 text-center text-slate-400">
                    <div className="flex flex-col items-center justify-center space-y-2">
                      <div className="h-10 w-10 rounded-xl bg-[#181f2f] flex items-center justify-center text-slate-400">
                        <Search className="h-5 w-5" />
                      </div>
                      <p className="font-medium text-slate-300">No transactions found matching criteria.</p>
                      <p className="text-xs text-slate-400">
                        Run a task from the Buyer Console or clear filters to view live settlement events.
                      </p>
                    </div>
                  </td>
                </tr>
              ) : (
                sortedRows.map((row) => {
                  const isSimulated = row.isSimulated || isSimulatedReplay;
                  const txUrl = row.txHash ? `${explorerUrl}/tx/${row.txHash}` : null;

                  return (
                    <tr
                      key={row.id}
                      onClick={() => onSelectRow(row)}
                      className="hover:bg-[#181f30] transition-colors cursor-pointer group"
                    >
                      {/* TRANSACTION_ID */}
                      <td className="py-3.5 px-4 font-mono text-slate-200">
                        <div className="flex items-center gap-1.5">
                          {isSimulated ? (
                            <span
                              className="text-amber-400/80 cursor-not-allowed"
                              title="Simulated sample — not on chain"
                            >
                              {shortHash(row.txHash)}
                            </span>
                          ) : txUrl ? (
                            <a
                              href={txUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-purple-400 hover:text-purple-300 hover:underline flex items-center gap-1"
                              title={`View ${row.txHash} on Base Sepolia Basescan`}
                            >
                              <span>{shortHash(row.txHash)}</span>
                              <ExternalLink className="h-3 w-3 shrink-0" />
                            </a>
                          ) : (
                            <span className="text-slate-400 font-sans italic">Not settled</span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 truncate max-w-[120px]">
                          {row.id}
                        </div>
                      </td>

                      {/* ENDPOINT */}
                      <td className="py-3.5 px-4">
                        <div className="font-semibold text-white group-hover:text-purple-300 transition-colors">
                          {row.serviceId}
                        </div>
                        <div className="text-[11px] text-slate-400 truncate max-w-[200px] font-mono">
                          {row.endpoint.replace(/https?:\/\/[^/]+/, "")}
                        </div>
                      </td>

                      {/* AMOUNT */}
                      <td className="py-3.5 px-4 text-right font-mono">
                        <div className="font-bold text-white text-xs">
                          {formatUsdc(row.paidUnits)} USDC
                        </div>
                        <div className="text-[10px] text-slate-400">
                          {row.paidUnits} units
                        </div>
                      </td>

                      {/* DATE & TIME */}
                      <td className="py-3.5 px-4 text-slate-300 whitespace-nowrap">
                        <div className="font-mono text-xs">
                          {new Date(row.time).toLocaleTimeString()}
                        </div>
                        <div className="text-[10px] text-slate-400 font-mono">
                          {new Date(row.time).toLocaleDateString()}
                        </div>
                      </td>

                      {/* STATUS */}
                      <td className="py-3.5 px-4">
                        {getStatusBadge(row.status)}
                        {row.reason && (
                          <div className="text-[10px] text-slate-400 truncate max-w-[180px] mt-0.5">
                            {row.reason}
                          </div>
                        )}
                      </td>

                      {/* LATENCY */}
                      <td className="py-3.5 px-4 text-right font-mono text-slate-300">
                        {row.latencyMs} ms
                      </td>

                      {/* PROOF CHECK */}
                      <td className="py-3.5 px-4 text-center">
                        {row.onchainConfirmed ? (
                          <span
                            className="inline-flex items-center text-emerald-400 text-xs font-medium"
                            title="On-chain Transfer receipt verified"
                          >
                            <ShieldCheck className="h-4 w-4" />
                          </span>
                        ) : isSimulated ? (
                          <span
                            className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20"
                            title="Simulated sample — not on chain"
                          >
                            simulated
                          </span>
                        ) : (
                          <span className="text-slate-400 text-[11px]">—</span>
                        )}
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
  );
};
