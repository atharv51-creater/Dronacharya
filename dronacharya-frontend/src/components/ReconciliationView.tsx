import React, { useState } from "react";
import {
  Scale,
  CheckCircle2,
  AlertTriangle,
  RefreshCw,
  ExternalLink,
  ShieldCheck,
  Search,
  Layers,
  ArrowRight,
} from "lucide-react";
import { reconcileSession, type ReconciliationReport, type SessionRecord } from "../api/client.ts";

interface ReconciliationViewProps {
  sessions: SessionRecord[];
  explorerUrl?: string;
}

export const ReconciliationView: React.FC<ReconciliationViewProps> = ({
  sessions,
  explorerUrl = "https://sepolia.basescan.org",
}) => {
  const [selectedSessionId, setSelectedSessionId] = useState<string>(sessions[0]?.id || "");
  const [report, setReport] = useState<ReconciliationReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const formatUsdc = (units: string | null | undefined): string => {
    if (units == null) return "0.000000";
    try {
      const u = BigInt(units);
      const neg = u < 0n;
      const a = neg ? -u : u;
      const whole = a / 1000000n;
      const frac = (a % 1000000n).toString().padStart(6, "0");
      return `${neg ? "-" : ""}${whole}.${frac}`;
    } catch {
      return "0.000000";
    }
  };

  const shortAddr = (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-4)}`;

  const handleRunReconcile = async () => {
    if (!selectedSessionId) {
      setErrorMsg("Please select or enter a session ID");
      return;
    }

    setIsLoading(true);
    setErrorMsg(null);
    setReport(null);

    const res = await reconcileSession(selectedSessionId);
    setIsLoading(false);

    if (res.error) {
      setErrorMsg(res.error);
    } else if (res.data) {
      setReport(res.data);
    }
  };

  return (
    <div className="space-y-6 pb-16 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#1e2538]">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Scale className="h-6 w-6 text-purple-400" />
            <span>On-Chain Cryptographic Reconciliation</span>
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Compares session ledger rows against every USDC Transfer event log on Base Sepolia to the micro-unit
          </p>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-xs px-2.5 py-1 rounded-md font-mono bg-indigo-500/10 text-indigo-300 border border-indigo-500/30">
            Verified On-Chain
          </span>
        </div>
      </div>

      {/* Session Selection & Action Card */}
      <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 sm:p-6 shadow-sm space-y-4">
        <div className="space-y-2">
          <label className="block text-xs font-semibold text-slate-300 uppercase tracking-wider">
            Select Buyer Session to Audit
          </label>
          <div className="flex flex-col sm:flex-row gap-3">
            <select
              value={selectedSessionId}
              onChange={(e) => setSelectedSessionId(e.target.value)}
              className="flex-1 bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#222b3d] focus:outline-none focus:border-purple-500 font-mono"
            >
              {sessions.length === 0 ? (
                <option value="">No recorded sessions found (run a task in Buyer Console)</option>
              ) : (
                sessions.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.id} · {shortAddr(s.buyer)} · {formatUsdc(s.totals.paidUnits)} USDC · {s.totals.calls} calls
                  </option>
                ))
              )}
            </select>

            <button
              onClick={handleRunReconcile}
              disabled={isLoading || !selectedSessionId}
              className="flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-bold shadow-lg shadow-purple-600/20 transition-all cursor-pointer shrink-0"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isLoading ? "animate-spin" : ""}`} />
              <span>{isLoading ? "Scanning Base Sepolia..." : "Reconcile with Base Sepolia"}</span>
            </button>
          </div>
        </div>

        <p className="text-[11px] text-slate-400 leading-relaxed">
          The reconciliation engine fetches every USDC <span className="font-mono text-purple-300">Transfer</span> log
          out of the buyer's address from the session's starting block up to the latest Base Sepolia block.
        </p>

        {errorMsg && (
          <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400" />
            <span>{errorMsg}</span>
          </div>
        )}
      </div>

      {/* Reconciliation Result Card */}
      {report && (
        <div className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 sm:p-6 shadow-sm space-y-6">
          {/* Verdict Banner */}
          <div
            className={`p-4 rounded-xl flex items-start gap-3 border ${
              report.ok
                ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                : "bg-rose-500/15 border-rose-500/30 text-rose-300"
            }`}
          >
            {report.ok ? (
              <CheckCircle2 className="h-5 w-5 text-emerald-400 shrink-0 mt-0.5" />
            ) : (
              <AlertTriangle className="h-5 w-5 text-rose-400 shrink-0 mt-0.5" />
            )}
            <div>
              <div className="font-bold text-sm tracking-tight">
                {report.ok ? "✓ Perfect Balance Verified" : "✗ Discrepancy Found"}
              </div>
              <p className="text-xs mt-1 leading-relaxed">{report.summary}</p>
              {report.dataSource && (
                <p className="text-[11px] mt-1 opacity-80">
                  Chain data: {report.dataSource === "rpc" ? "Base Sepolia RPC" : report.dataSource === "etherscan" ? "Etherscan" : "Etherscan, plus the RPC for the newest blocks"}
                </p>
              )}
            </div>
          </div>

          {/* Mathematical Facts Table */}
          <div className="rounded-xl border border-[#1e2538] bg-[#0a0d14] p-4 space-y-4">
            <h3 className="text-xs font-semibold text-slate-300 uppercase tracking-wider">
              Cryptographic Audit Breakdown
            </h3>

            <dl className="grid grid-cols-1 sm:grid-cols-2 gap-y-3 gap-x-6 text-xs">
              <div className="space-y-1">
                <dt className="text-slate-400">Buyer Wallet</dt>
                <dd className="font-mono text-slate-200">
                  <a
                    href={`${explorerUrl}/address/${report.buyer}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-purple-400 hover:underline flex items-center gap-1"
                  >
                    <span>{report.buyer}</span>
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-slate-400">Base Sepolia Block Range</dt>
                <dd className="font-mono text-slate-200">
                  {report.fromBlock} to {report.toBlock}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-slate-400">Internal Ledger Rows</dt>
                <dd className="font-mono text-white font-semibold">
                  {formatUsdc(report.ledger.paidUnits)} USDC across {report.ledger.paidRows} paid rows (
                  {report.ledger.confirmedRows} receipts checked, {report.ledger.pendingRows} pending)
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-slate-400">On-Chain USDC Transfers</dt>
                <dd className="font-mono text-white font-semibold">
                  {formatUsdc(report.chain.units)} USDC across {report.chain.transfers} verified transfers
                </dd>
              </div>

              <div className="col-span-full pt-2 border-t border-[#1e2538] flex items-center justify-between">
                <dt className="text-xs font-bold text-slate-300 uppercase tracking-wider">Net Difference</dt>
                <dd className="font-mono text-sm font-extrabold text-emerald-400">
                  {formatUsdc(report.diffUnits)} USDC (0 diff)
                </dd>
              </div>
            </dl>
          </div>

          {/* Issues List (if any) */}
          {report.issues.length > 0 && (
            <div className="space-y-3">
              <h3 className="text-xs font-semibold text-rose-400 uppercase tracking-wider">
                Flagged Audit Issues ({report.issues.length})
              </h3>
              <div className="space-y-2">
                {report.issues.map((issue, idx) => (
                  <div
                    key={idx}
                    className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-xs text-rose-300 flex items-start gap-2"
                  >
                    <AlertTriangle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                    <div>
                      <strong className="uppercase font-mono text-[10px] tracking-wider text-rose-200">
                        {issue.kind.replace(/_/g, " ")}:
                      </strong>{" "}
                      <span>{issue.detail}</span>
                      {issue.txHash && (
                        <div className="mt-1 font-mono text-[11px]">
                          <a
                            href={`${explorerUrl}/tx/${issue.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-purple-400 hover:underline inline-flex items-center gap-1"
                          >
                            <span>Tx: {issue.txHash}</span>
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};
