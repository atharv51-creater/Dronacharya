import React, { useState } from "react";
import {
  X,
  ExternalLink,
  ShieldCheck,
  Check,
  Copy,
  Clock,
  Coins,
  CheckCircle2,
  AlertTriangle,
  XCircle,
} from "lucide-react";
import type { LedgerRow } from "../api/client.ts";

interface TransactionModalProps {
  row: LedgerRow | null;
  onClose: () => void;
  explorerUrl?: string;
  isSimulatedReplay?: boolean;
}

export const TransactionModal: React.FC<TransactionModalProps> = ({
  row,
  onClose,
  explorerUrl = "https://sepolia.basescan.org",
  isSimulatedReplay = false,
}) => {
  const [copiedField, setCopiedField] = useState<string | null>(null);

  if (!row) return null;

  const copyToClipboard = (text: string, field: string) => {
    navigator.clipboard.writeText(text);
    setCopiedField(field);
    setTimeout(() => setCopiedField(null), 2000);
  };

  const isSimulated = row.isSimulated || isSimulatedReplay;
  const txUrl = row.txHash && !isSimulated ? `${explorerUrl}/tx/${row.txHash}` : null;

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

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200">
      <div className="w-full max-w-2xl rounded-2xl border border-[#222b3d] bg-[#121624] p-6 shadow-2xl space-y-6 max-h-[90vh] flex flex-col">
        {/* Modal Header */}
        <div className="flex items-start justify-between pb-3 border-b border-[#1e2538]">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="text-xs font-mono text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">
                x402 Audit Proof
              </span>
              {row.onchainConfirmed && (
                <span className="inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">
                  <ShieldCheck className="h-3.5 w-3.5" />
                  <span>On-Chain Verified</span>
                </span>
              )}
              {isSimulated && (
                <span className="text-[11px] font-semibold text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                  Simulated Record
                </span>
              )}
            </div>
            <h2 className="text-lg font-bold text-white tracking-tight">
              Payment Record: {row.id}
            </h2>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5 transition-colors cursor-pointer"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Modal Body */}
        <div className="overflow-y-auto space-y-5 pr-1 text-xs">
          {/* Status summary */}
          <div className="p-4 rounded-xl bg-[#0a0d14] border border-[#1e2538] flex items-center justify-between">
            <div>
              <div className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
                Settlement Status
              </div>
              <div className="text-sm font-bold text-white capitalize mt-0.5">
                {row.status.replace(/_/g, " ")}
              </div>
              {row.reason && (
                <div className="text-[11px] text-slate-300 mt-1 leading-relaxed">
                  Reason: {row.reason}
                </div>
              )}
            </div>

            <div className="text-right">
              <div className="text-[11px] text-slate-400 uppercase tracking-wider font-semibold">
                Paid Amount
              </div>
              <div className="text-base font-extrabold text-white font-mono mt-0.5">
                {formatUsdc(row.paidUnits)} USDC
              </div>
              <div className="text-[11px] text-slate-400 font-mono">
                {row.paidUnits} micro-units
              </div>
            </div>
          </div>

          {/* Cryptographic Fields */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              On-Chain Cryptographic Parameters
            </h3>

            <div className="space-y-2 font-mono">
              {/* Transaction Hash */}
              <div className="p-3 rounded-xl bg-[#0a0d14] border border-[#1e2538] flex items-center justify-between">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase">Transaction Hash</span>
                  {isSimulated ? (
                    <span className="text-amber-400 text-xs cursor-not-allowed" title="Simulated sample — not on chain">
                      {row.txHash || "Simulated (no on-chain hash)"}
                    </span>
                  ) : txUrl ? (
                    <a
                      href={txUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-purple-400 hover:text-purple-300 hover:underline flex items-center gap-1.5 text-xs"
                      title="Inspect on Base Sepolia Basescan"
                    >
                      <span>{row.txHash}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <span className="text-slate-400 italic">Not settled on-chain</span>
                  )}
                </div>
                {row.txHash && !isSimulated && (
                  <button
                    onClick={() => copyToClipboard(row.txHash!, "txHash")}
                    className="p-1 text-slate-400 hover:text-white rounded"
                    title="Copy transaction hash"
                  >
                    {copiedField === "txHash" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                )}
              </div>

              {/* Nonce */}
              {row.nonce && (
                <div className="p-3 rounded-xl bg-[#0a0d14] border border-[#1e2538] flex items-center justify-between">
                  <div>
                    <span className="text-slate-400 block text-[10px] uppercase">EIP-3009 Nonce</span>
                    <span className="text-slate-200 text-xs break-all">{row.nonce}</span>
                  </div>
                  <button
                    onClick={() => copyToClipboard(row.nonce!, "nonce")}
                    className="p-1 text-slate-400 hover:text-white rounded"
                    title="Copy nonce"
                  >
                    {copiedField === "nonce" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                  </button>
                </div>
              )}

              {/* Payer (Buyer) */}
              <div className="p-3 rounded-xl bg-[#0a0d14] border border-[#1e2538] flex items-center justify-between">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase">Buyer (Authorizer)</span>
                  <span className="text-slate-200 text-xs">{row.buyer}</span>
                </div>
                <button
                  onClick={() => copyToClipboard(row.buyer, "buyer")}
                  className="p-1 text-slate-400 hover:text-white rounded"
                  title="Copy buyer address"
                >
                  {copiedField === "buyer" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>

              {/* PayTo (Seller) */}
              <div className="p-3 rounded-xl bg-[#0a0d14] border border-[#1e2538] flex items-center justify-between">
                <div>
                  <span className="text-slate-400 block text-[10px] uppercase">Seller (payTo Recipient)</span>
                  <span className="text-slate-200 text-xs">{row.payTo}</span>
                </div>
                <button
                  onClick={() => copyToClipboard(row.payTo, "payTo")}
                  className="p-1 text-slate-400 hover:text-white rounded"
                  title="Copy payTo address"
                >
                  {copiedField === "payTo" ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                </button>
              </div>
            </div>
          </div>

          {/* Call Metadata */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-slate-300">
              Execution Details
            </h3>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-center font-mono">
              <div className="p-2.5 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                <div className="text-[10px] text-slate-400">Listed Price</div>
                <div className="text-xs font-bold text-white mt-0.5">{formatUsdc(row.listedUnits)}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                <div className="text-[10px] text-slate-400">Asked Price</div>
                <div className="text-xs font-bold text-white mt-0.5">{formatUsdc(row.askedUnits)}</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                <div className="text-[10px] text-slate-400">Latency</div>
                <div className="text-xs font-bold text-white mt-0.5">{row.latencyMs} ms</div>
              </div>
              <div className="p-2.5 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                <div className="text-[10px] text-slate-400">HTTP Status</div>
                <div className="text-xs font-bold text-white mt-0.5">{row.httpStatus || 200}</div>
              </div>
            </div>

            <div className="p-3 rounded-xl bg-[#0a0d14] border border-[#1e2538] space-y-1">
              <div className="text-[10px] text-slate-400 uppercase font-mono">Endpoint Called</div>
              <div className="text-xs text-purple-300 font-mono break-all">{row.endpoint}</div>
            </div>
          </div>
        </div>

        {/* Modal Footer */}
        <div className="pt-3 border-t border-[#1e2538] flex items-center justify-between">
          <span className="text-[11px] text-slate-400 font-mono">
            Time: {new Date(row.time).toLocaleString()}
          </span>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-colors cursor-pointer"
          >
            Close Audit
          </button>
        </div>
      </div>
    </div>
  );
};
