import React, { useState, useEffect, useRef } from "react";
import {
  Play,
  Pause,
  RotateCcw,
  Bot,
  Zap,
  ShieldAlert,
  ArrowRight,
  ExternalLink,
  Code2,
  CheckCircle,
  Clock,
  Coins,
  Cpu,
  Layers,
  Sparkles,
  Info,
  ChevronRight,
  Activity,
} from "lucide-react";
import type { LedgerRow, ServiceView } from "../api/client.ts";
import type { ActivityLine } from "./ConsoleView.tsx";
import type { NavTab } from "../types.ts";

interface AgentArenaProps {
  buyerAddress?: string;
  services?: ServiceView[];
  recentLedgerRows?: LedgerRow[];
  /** Real, live lines from the Scout run the Buyer Console is watching. */
  liveFeed?: ActivityLine[];
  onNavigateToConsole: () => void;
  explorerUrl?: string;
}

interface Packet {
  id: string;
  source: "scout" | "scraper" | "fx" | "hindi" | "chaos";
  target: "scout" | "scraper" | "fx" | "hindi" | "chaos";
  type: "request" | "402_challenge" | "eip3009_auth" | "settlement_200" | "strike_refusal";
  label: string;
  progress: number; // 0 to 1
  color: string;
  payload?: any;
}

export const AgentArena: React.FC<AgentArenaProps> = ({
  buyerAddress = "0xDE11519b325147B01971b9645c4F620e7821f0A0",
  services = [],
  recentLedgerRows = [],
  liveFeed = [],
  onNavigateToConsole,
}) => {
  // Scripted mode: nothing here is on chain, so it shows no explorer links and no real-looking hashes.
  const [isPlaying, setIsPlaying] = useState(true);
  const [speed, setSpeed] = useState<number>(1);
  const [activeStepIndex, setActiveStepIndex] = useState<number>(0);
  const [selectedNode, setSelectedNode] = useState<string>("scout");
  const [packets, setPackets] = useState<Packet[]>([]);
  const [activeInspectorPacket, setActiveInspectorPacket] = useState<Packet | null>(null);

  // Simulation Timeline Steps
  const simulationSteps = [
    {
      title: "Task Intake & Spec Planning",
      description: "Scout parses user prompt with rules/Gemini: finds needs for books, currency conversion, and Hindi summary.",
      actor: "scout",
      status: "PLANNING",
      packet: null,
    },
    {
      title: "Call Shelf-Scraper (Books Catalogue)",
      description: "Scout dispatches GET /scrape?page=1 to shelf-scraper.",
      actor: "scraper",
      status: "REQUEST_SENT",
      packet: {
        id: "p1",
        source: "scout",
        target: "scraper",
        type: "request",
        label: "GET /scrape?page=1",
        color: "#38bdf8",
        payload: { method: "GET", path: "/scrape", page: 1, limit: 20 },
      },
    },
    {
      title: "HTTP 402 Payment Required Challenge",
      description: "Shelf-scraper replies HTTP 402 with x402 challenge: 0.005 USDC (5000 units), Base Sepolia.",
      actor: "scraper",
      status: "402_CHALLENGE",
      packet: {
        id: "p2",
        source: "scraper",
        target: "scout",
        type: "402_challenge",
        label: "HTTP 402: 5,000 units USDC",
        color: "#f59e0b",
        payload: {
          status: 402,
          scheme: "eip3009",
          network: "eip155:84532",
          priceUnits: "5000",
          priceUsdc: "0.005",
          asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
          payTo: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
        },
      },
    },
    {
      title: "Scout Signs EIP-3009 Gasless Payment",
      description: "Scout validates against registry listing, checks budget, and signs TransferWithAuthorization.",
      actor: "scout",
      status: "EIP3009_SIGNING",
      packet: {
        id: "p3",
        source: "scout",
        target: "scraper",
        type: "eip3009_auth",
        label: "EIP-3009 TransferWithAuth",
        color: "#c084fc",
        payload: {
          from: buyerAddress,
          to: "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
          value: "5000",
          validAfter: Math.floor(Date.now() / 1000) - 60,
          validBefore: Math.floor(Date.now() / 1000) + 120,
          nonce: "0xSIMULATED_NONCE_1",
          signature: "0x89ab...712c",
        },
      },
    },
    {
      title: "On-Chain Settle & Verified Delivery",
      description: "Shelf-scraper verifies signature, fulfills catalogue data, settles on Base Sepolia.",
      actor: "scraper",
      status: "SETTLED",
      packet: {
        id: "p4",
        source: "scraper",
        target: "scout",
        type: "settlement_200",
        label: "200 OK + 20 Books + TxHash",
        color: "#34d399",
        payload: {
          status: 200,
          booksReturned: 20,
          txHash: "0xSIMULATED_TX_1",
          settledUnits: "5000",
          latencyMs: 142,
        },
      },
    },
    {
      title: "Call FX-Rates (ECB Reference Currency)",
      description: "Scout buys GBP to INR exchange rate from fx-rates seller for 0.001 USDC.",
      actor: "fx",
      status: "SETTLED",
      packet: {
        id: "p5",
        source: "scout",
        target: "fx",
        type: "eip3009_auth",
        label: "EIP-3009: 1,000 units (GBP->INR)",
        color: "#38bdf8",
        payload: {
          pair: "GBP/INR",
          priceUnits: "1000",
          rate: "105.42",
          txHash: "0xSIMULATED_TX_2",
        },
      },
    },
    {
      title: "Call Hindi-Summary (Gemini LLM Inference)",
      description: "Scout requests Devanagari summary for 3 books at 0.010 USDC.",
      actor: "hindi",
      status: "SETTLED",
      packet: {
        id: "p6",
        source: "scout",
        target: "hindi",
        type: "settlement_200",
        label: "200 OK: Hindi Summary + Gemini Check",
        color: "#f472b6",
        payload: {
          language: "Hindi (Devanagari)",
          devanagariCheckPassed: true,
          priceUnits: "10000",
          txHash: "0xSIMULATED_TX_3",
        },
      },
    },
    {
      title: "Chaos Defense: Misbehaving Seller Struck",
      description: "Scout encounters cheap-scraper (overprice) demanding 0.020 vs 0.002 listing: strike logged, fallback engaged.",
      actor: "chaos",
      status: "STRUCK",
      packet: {
        id: "p7",
        source: "chaos",
        target: "scout",
        type: "strike_refusal",
        label: "STRIKE: Overprice 402 Rejected",
        color: "#f87171",
        payload: {
          reasonCode: "price_above_listing",
          listedUnits: "2000",
          demandedUnits: "20000",
          action: "Excluded from task; strike incremented in registry",
        },
      },
    },
  ];

  // Animation Loop for Timeline
  useEffect(() => {
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setActiveStepIndex((prev) => {
        const next = (prev + 1) % simulationSteps.length;
        const currentPacket = simulationSteps[next]?.packet;
        if (currentPacket) {
          setPackets([{ ...currentPacket, progress: 0 } as Packet]);
          setActiveInspectorPacket(currentPacket as Packet);
        } else {
          setPackets([]);
        }
        return next;
      });
    }, 3800 / speed);

    return () => clearInterval(interval);
  }, [isPlaying, speed]);

  const currentStep = simulationSteps[activeStepIndex] ?? simulationSteps[0]!;
  const scoutCoords = { x: 50, y: 50 };

  // Node Positions in SVG (Percentages)
  const nodeCoordinates: Record<string, { x: number; y: number }> = {
    scout: scoutCoords,
    scraper: { x: 20, y: 22 },
    fx: { x: 80, y: 22 },
    hindi: { x: 80, y: 78 },
    chaos: { x: 20, y: 78 },
  };

  const handleStepSelect = (idx: number) => {
    setActiveStepIndex(idx);
    const p = simulationSteps[idx]?.packet;
    if (p) {
      setPackets([{ ...p, progress: 0 } as Packet]);
      setActiveInspectorPacket(p as Packet);
    } else {
      setPackets([]);
    }
  };

  return (
    <div className="space-y-8 pb-16 max-w-6xl mx-auto">
      <div role="status" className="sticky top-0 z-20 rounded-xl border border-amber-500/40 bg-amber-500/10 px-4 py-2 text-xs font-semibold text-amber-200">
        Simulated — not on chain. This arena replays a scripted session; its hashes are placeholders and no USDC moves.
      </div>
      {liveFeed.length > 0 && (
        <section className="rounded-2xl border border-emerald-500/30 bg-emerald-500/[0.05] p-4 space-y-2">
          <div className="flex items-center justify-between">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-emerald-200 flex items-center gap-2">
              <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> Live Scout run (real, on Base Sepolia) · {liveFeed[0]!.taskId}
            </h2>
            <button type="button" onClick={onNavigateToConsole} className="text-xs text-emerald-200 hover:text-white cursor-pointer">
              Open in console →
            </button>
          </div>
          <div className="max-h-48 overflow-y-auto space-y-1 font-mono text-[11px]">
            {liveFeed.slice(-12).map((l) => (
              <div key={l.key} className={`flex gap-2 ${l.kind === "ok" ? "text-emerald-300" : l.kind === "warn" ? "text-amber-300" : l.kind === "bad" ? "text-rose-300" : "text-slate-300"}`}>
                <span className="text-slate-500 shrink-0">{l.time}</span>
                <span className="min-w-0 break-words">
                  {l.text}
                  {l.href && (
                    <a href={l.href} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-purple-300 hover:underline">
                      tx ↗
                    </a>
                  )}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
      {/* Top Banner */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#1e2538]">
        <div>
          <h1 className="text-2xl sm:text-3xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Sparkles className="h-7 w-7 text-purple-400" />
            <span>Agent Arena</span>
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 mt-1 max-w-2xl leading-relaxed">
            Watch Scout orchestrate multi-agent workflows, negotiate HTTP 402 payment requirements, sign EIP-3009 authorizations, and settle micro-USDC payments on Base Sepolia.
          </p>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <span className="text-xs px-2.5 py-1 rounded-lg font-mono text-slate-400 bg-[#141b2a] border border-[#212c42]">
            Base Sepolia (84532)
          </span>
          <button
            onClick={onNavigateToConsole}
            className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs shadow-lg shadow-purple-600/20 transition-all cursor-pointer"
          >
            <span>Launch Live Console</span>
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Arena Canvas & Control Deck */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Visualizer (2 Cols) */}
        <div className="lg:col-span-2 rounded-2xl border border-[#232c40] bg-[#0c101c] p-4 sm:p-6 shadow-2xl relative overflow-hidden flex flex-col justify-between min-h-[460px]">
          {/* Subtle Ambient Grid Background */}
          <div className="absolute inset-0 bg-[linear-gradient(to_right,#1f293d15_1px,transparent_1px),linear-gradient(to_bottom,#1f293d15_1px,transparent_1px)] bg-[size:24px_24px] pointer-events-none" />

          {/* Top Control Bar inside canvas */}
          <div className="relative z-10 flex items-center justify-between gap-2 border-b border-[#1b2336] pb-3">
            <div className="flex items-center gap-2">
              <span className="h-2 w-2 rounded-sm bg-emerald-400" />
              <span className="text-xs font-bold text-slate-200">
                Step {activeStepIndex + 1} of {simulationSteps.length}: {currentStep.title}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                onClick={() => setIsPlaying(!isPlaying)}
                className="p-1.5 rounded-lg bg-[#182033] hover:bg-[#222d48] text-white border border-[#263552] transition-colors cursor-pointer"
                title={isPlaying ? "Pause" : "Play"}
              >
                {isPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5 fill-current" />}
              </button>
              <button
                onClick={() => handleStepSelect(0)}
                className="p-1.5 rounded-lg bg-[#182033] hover:bg-[#222d48] text-slate-300 hover:text-white border border-[#263552] transition-colors cursor-pointer"
                title="Restart"
              >
                <RotateCcw className="h-3.5 w-3.5" />
              </button>
              <div className="flex items-center bg-[#131a2a] rounded-lg p-0.5 border border-[#222d44] text-[11px] font-mono">
                {[0.5, 1, 2].map((s) => (
                  <button
                    key={s}
                    onClick={() => setSpeed(s)}
                    className={`px-2 py-0.5 rounded cursor-pointer ${
                      speed === s ? "bg-purple-600 text-white font-bold" : "text-slate-400 hover:text-white"
                    }`}
                  >
                    {s}x
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Vector Network Graph */}
          <div className="relative z-10 my-6 flex-1 min-h-[300px] flex items-center justify-center">
            {/* SVG Connecting Lines & Animated Particles */}
            <svg className="absolute inset-0 w-full h-full pointer-events-none">
              {/* Lines from Scout to each Seller Node */}
              {Object.entries(nodeCoordinates).map(([nodeId, coords]) => {
                if (nodeId === "scout") return null;
                const isTargeted = currentStep.actor === nodeId;
                return (
                  <g key={nodeId}>
                    <line
                      x1={`${scoutCoords.x}%`}
                      y1={`${scoutCoords.y}%`}
                      x2={`${coords.x}%`}
                      y2={`${coords.y}%`}
                      stroke={isTargeted ? "#8b5cf6" : "#1e293b"}
                      strokeWidth={isTargeted ? "2.5" : "1.5"}
                      strokeDasharray={isTargeted ? "5 3" : "none"}
                      className={isTargeted ? "animate-pulse" : ""}
                    />
                    {isTargeted && (
                      <circle
                        cx={`${(scoutCoords.x + coords.x) / 2}%`}
                        cy={`${(scoutCoords.y + coords.y) / 2}%`}
                        r="3.5"
                        fill="#c084fc"
                        className="animate-ping"
                      />
                    )}
                  </g>
                );
              })}
            </svg>

            {/* Central Node: Scout Buyer Agent */}
            <div
              onClick={() => setSelectedNode("scout")}
              style={{ left: "50%", top: "50%", transform: "translate(-50%, -50%)" }}
              className={`absolute z-20 flex flex-col items-center cursor-pointer group transition-transform ${
                selectedNode === "scout" ? "scale-105" : "hover:scale-102"
              }`}
            >
              <div className="relative">
                <div className="relative h-16 w-16 sm:h-20 sm:w-20 rounded-2xl bg-[#14192b] border-2 border-purple-500/60 flex flex-col items-center justify-center shadow-2xl p-2 text-center">
                  <Bot className="h-7 w-7 text-purple-300" />
                  <span className="text-[10px] font-bold text-white tracking-wider mt-1">SCOUT</span>
                </div>
              </div>
              <div className="mt-2 text-center">
                <span className="text-[10px] font-mono px-2 py-0.5 rounded-md bg-purple-500/20 text-purple-300 border border-purple-500/40">
                  Buyer Orchestrator
                </span>
                <p className="text-[10px] font-mono text-slate-400 mt-0.5">{buyerAddress.slice(0, 6)}...{buyerAddress.slice(-4)}</p>
              </div>
            </div>

            {/* Satellite Node 1: Shelf Scraper */}
            <div
              onClick={() => setSelectedNode("scraper")}
              style={{ left: "20%", top: "22%", transform: "translate(-50%, -50%)" }}
              className={`absolute z-20 flex flex-col items-center cursor-pointer transition-transform ${
                selectedNode === "scraper" ? "scale-105" : "hover:scale-102"
              }`}
            >
              <div
                className={`h-12 w-12 sm:h-14 sm:w-14 rounded-xl border flex items-center justify-center shadow-lg transition-all ${
                  currentStep.actor === "scraper"
                    ? "bg-sky-500/20 border-sky-400 text-sky-300 ring-4 ring-sky-500/20"
                    : "bg-[#111726] border-[#222e47] text-slate-400"
                }`}
              >
                <Layers className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-bold text-white mt-1.5">shelf-scraper</span>
              <span className="text-[9px] font-mono text-sky-400">0.005 USDC · scrape</span>
            </div>

            {/* Satellite Node 2: FX Rates */}
            <div
              onClick={() => setSelectedNode("fx")}
              style={{ left: "80%", top: "22%", transform: "translate(-50%, -50%)" }}
              className={`absolute z-20 flex flex-col items-center cursor-pointer transition-transform ${
                selectedNode === "fx" ? "scale-105" : "hover:scale-102"
              }`}
            >
              <div
                className={`h-12 w-12 sm:h-14 sm:w-14 rounded-xl border flex items-center justify-center shadow-lg transition-all ${
                  currentStep.actor === "fx"
                    ? "bg-emerald-500/20 border-emerald-400 text-emerald-300 ring-4 ring-emerald-500/20"
                    : "bg-[#111726] border-[#222e47] text-slate-400"
                }`}
              >
                <Coins className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-bold text-white mt-1.5">fx-rates</span>
              <span className="text-[9px] font-mono text-emerald-400">0.001 USDC · data</span>
            </div>

            {/* Satellite Node 3: Hindi Summary */}
            <div
              onClick={() => setSelectedNode("hindi")}
              style={{ left: "80%", top: "78%", transform: "translate(-50%, -50%)" }}
              className={`absolute z-20 flex flex-col items-center cursor-pointer transition-transform ${
                selectedNode === "hindi" ? "scale-105" : "hover:scale-102"
              }`}
            >
              <div
                className={`h-12 w-12 sm:h-14 sm:w-14 rounded-xl border flex items-center justify-center shadow-lg transition-all ${
                  currentStep.actor === "hindi"
                    ? "bg-pink-500/20 border-pink-400 text-pink-300 ring-4 ring-pink-500/20"
                    : "bg-[#111726] border-[#222e47] text-slate-400"
                }`}
              >
                <Cpu className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-bold text-white mt-1.5">hindi-summary</span>
              <span className="text-[9px] font-mono text-pink-400">0.010 USDC · Gemini</span>
            </div>

            {/* Satellite Node 4: Chaos Shield / Adversarial Trap */}
            <div
              onClick={() => setSelectedNode("chaos")}
              style={{ left: "20%", top: "78%", transform: "translate(-50%, -50%)" }}
              className={`absolute z-20 flex flex-col items-center cursor-pointer transition-transform ${
                selectedNode === "chaos" ? "scale-105" : "hover:scale-102"
              }`}
            >
              <div
                className={`h-12 w-12 sm:h-14 sm:w-14 rounded-xl border flex items-center justify-center shadow-lg transition-all ${
                  currentStep.actor === "chaos"
                    ? "bg-rose-500/20 border-rose-400 text-rose-300 ring-4 ring-rose-500/20"
                    : "bg-[#111726] border-[#222e47] text-slate-400"
                }`}
              >
                <ShieldAlert className="h-5 w-5" />
              </div>
              <span className="text-[11px] font-bold text-white mt-1.5">cheap-scraper</span>
              <span className="text-[9px] font-mono text-rose-400">chaos fixture · strike</span>
            </div>
          </div>

          {/* Bottom Live Telemetry Pill */}
          <div className="relative z-10 flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-3 border-t border-[#1b2336] text-xs">
            <div className="flex items-center gap-2">
              <span className="text-slate-400">Current Action:</span>
              <span className="text-purple-300 font-medium">{currentStep.description}</span>
            </div>
            {currentStep.packet && (
              <span
                style={{ backgroundColor: `${currentStep.packet.color}20`, borderColor: `${currentStep.packet.color}40`, color: currentStep.packet.color }}
                className="px-2.5 py-1 rounded-lg border font-mono text-[11px] flex items-center gap-1.5 self-start sm:self-auto"
              >
                <Activity className="h-3 w-3" />
                <span>{currentStep.packet.label}</span>
              </span>
            )}
          </div>
        </div>

        {/* Right Inspector Drawer (1 Col) */}
        <div className="rounded-2xl border border-[#232c40] bg-[#0f1424] p-5 shadow-2xl flex flex-col justify-between space-y-4">
          <div>
            <div className="flex items-center justify-between pb-3 border-b border-[#1f293d]">
              <div className="flex items-center gap-2">
                <Code2 className="h-4 w-4 text-purple-400" />
                <h3 className="text-sm font-bold text-white">Cryptographic Protocol Inspector</h3>
              </div>
              <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-purple-500/10 text-purple-300 border border-purple-500/20">
                x402 v2
              </span>
            </div>

            {/* Selected Node or Step Detail */}
            <div className="mt-4 space-y-3">
              <div className="p-3 rounded-xl bg-[#090d16] border border-[#1b2438]">
                <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                  Active Simulation Step
                </div>
                <div className="text-xs font-bold text-white">{currentStep.title}</div>
                <p className="text-[11px] text-slate-300 mt-1 leading-relaxed">{currentStep.description}</p>
              </div>

              {/* Decoded Packet Breakdown */}
              {activeInspectorPacket?.payload ? (
                <div className="space-y-2">
                  <div className="text-[11px] font-bold text-slate-400 uppercase tracking-wider flex items-center justify-between">
                    <span>Packet Data ({activeInspectorPacket.type})</span>
                    <span className="font-mono text-purple-400 text-[10px]">
                      {activeInspectorPacket.source} -&gt; {activeInspectorPacket.target}
                    </span>
                  </div>
                  <div className="rounded-xl bg-[#080b12] border border-[#1b2336] p-3 text-[11px] font-mono text-slate-200 overflow-x-auto max-h-56">
                    <pre>{JSON.stringify(activeInspectorPacket.payload, null, 2)}</pre>
                  </div>
                </div>
              ) : (
                <div className="p-4 rounded-xl bg-[#090d16] border border-[#1b2438] text-center text-slate-400 text-xs">
                  Awaiting next packet transmission...
                </div>
              )}
            </div>
          </div>

          {/* Quick Step Buttons */}
          <div className="space-y-2 pt-2 border-t border-[#1f293d]">
            <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
              Simulation Timeline
            </div>
            <div className="grid grid-cols-4 gap-1.5">
              {simulationSteps.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => handleStepSelect(idx)}
                  className={`py-1.5 text-[10px] font-mono rounded-lg transition-colors cursor-pointer border ${
                    activeStepIndex === idx
                      ? "bg-purple-600 text-white font-bold border-purple-500 shadow-md shadow-purple-600/30"
                      : "bg-[#141a2a] text-slate-400 hover:text-white border-[#212c44]"
                  }`}
                >
                  Step {idx + 1}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Protocol Architecture & Features (Matching Landing Page from Screenshots) */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-5 pt-4">
        <div className="rounded-2xl border border-[#222b3d] bg-[#101422] p-5 space-y-3">
          <div className="h-10 w-10 rounded-xl bg-purple-500/10 border border-purple-500/30 flex items-center justify-center text-purple-400">
            <Coins className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">EIP-3009 Gasless Payments</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Buyer signs an off-chain authorization (`receiveWithAuthorization`). The seller agent or facilitator submits it, incurring zero gas overhead for the buyer agent.
          </p>
        </div>

        <div className="rounded-2xl border border-[#222b3d] bg-[#101422] p-5 space-y-3">
          <div className="h-10 w-10 rounded-xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400">
            <CheckCircle className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Settle-After-Validate Sellers</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            Sellers validate client payloads and compute responses before submitting on-chain settlements, ensuring buyers only pay for valid, usable results.
          </p>
        </div>

        <div className="rounded-2xl border border-[#222b3d] bg-[#101422] p-5 space-y-3">
          <div className="h-10 w-10 rounded-xl bg-sky-500/10 border border-sky-500/30 flex items-center justify-center text-sky-400">
            <ShieldAlert className="h-5 w-5" />
          </div>
          <h3 className="text-sm font-bold text-white">Automatic Strike & Fallback Ladder</h3>
          <p className="text-xs text-slate-400 leading-relaxed">
            If any seller violates listed price, payTo address, or delivery specifications, Scout instantly excludes the rogue agent and falls back to honest alternatives.
          </p>
        </div>
      </div>
    </div>
  );
};
