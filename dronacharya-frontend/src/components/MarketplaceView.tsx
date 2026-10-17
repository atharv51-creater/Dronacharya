import React, { useState } from "react";
import {
  Search,
  Filter,
  Plus,
  ExternalLink,
  ShieldCheck,
  Code2,
  Clock,
  Coins,
  Copy,
  Check,
  CheckCircle2,
  X,
  AlertCircle,
  Key,
  Shield,
  Sparkles,
} from "lucide-react";
import { registerService, registerWalletProofService, requestWalletChallenge, type ServiceView } from "../api/client.ts";

type Eip1193 = { request(args: { method: string; params?: unknown[] }): Promise<unknown> };
const injectedWallet = (): Eip1193 | undefined => (window as unknown as { ethereum?: Eip1193 }).ethereum;

interface MarketplaceViewProps {
  services: ServiceView[];
  isLoading: boolean;
  onRefresh: () => void;
  explorerUrl?: string;
  onNavigateToPortal?: () => void;
}

export const MarketplaceView: React.FC<MarketplaceViewProps> = ({
  services,
  isLoading,
  onRefresh,
  explorerUrl = "https://sepolia.basescan.org",
  onNavigateToPortal,
}) => {
  const [selectedCategory, setSelectedCategory] = useState<string>("all");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [minSuccess, setMinSuccess] = useState<string>("all");
  const [sortOption, setSortOption] = useState<"score" | "price" | "latency" | "successRate" | "name">("score");
  const [searchQuery, setSearchQuery] = useState("");
  const [showFixtures, setShowFixtures] = useState(false);

  // Modals state
  const [inspectedService, setInspectedService] = useState<ServiceView | null>(null);
  const [isRegisterOpen, setIsRegisterOpen] = useState(false);
  const [copiedAddr, setCopiedAddr] = useState<string | null>(null);

  // Registration form
  const [regForm, setRegForm] = useState({
    id: "",
    name: "",
    category: "scraping",
    method: "GET",
    endpoint: "",
    price: "0.005",
    payTo: "",
    description: "",
    inputSchema: '{\n  "type": "object"\n}',
    outputSchema: '{\n  "type": "object"\n}',
  });
  const [useWalletProof, setUseWalletProof] = useState(true);
  const [proofSignature, setProofSignature] = useState("");
  const [proofMessage, setProofMessage] = useState("");
  const [isGeneratingProof, setIsGeneratingProof] = useState(false);
  const [proofFor, setProofFor] = useState("");
  const [proofError, setProofError] = useState<string | null>(null);
  const [regStatus, setRegStatus] = useState<{ ok: boolean; msg: string } | null>(null);
  const [isRegistering, setIsRegistering] = useState(false);

  const copyAddress = (addr: string) => {
    navigator.clipboard.writeText(addr);
    setCopiedAddr(addr);
    setTimeout(() => setCopiedAddr(null), 2000);
  };

  // Wallet proof: the server issues a one-time challenge (service, wallet, email, chain, nonce) and the
  // seller signs it with their own payTo wallet (browser wallet via personal_sign). No keys are made here.
  const generateProof = async () => {
    setProofError(null);
    const serviceId = regForm.id.trim();
    if (!serviceId) {
      setProofError("Enter the Service ID first");
      return;
    }
    const wallet = injectedWallet();
    if (!wallet) {
      setProofError("No browser wallet found. Install MetaMask (or similar) to sign with your payTo wallet.");
      return;
    }
    setIsGeneratingProof(true);
    try {
      const accounts = (await wallet.request({ method: "eth_requestAccounts" })) as string[];
      const typed = regForm.payTo.trim();
      const addr = typed || accounts?.[0] || "";
      if (!addr) throw new Error("The wallet returned no account");
      if (!accounts?.some((a) => a.toLowerCase() === addr.toLowerCase())) {
        throw new Error(`Switch your wallet to ${addr} (the payTo address) and try again`);
      }
      const challenge = await requestWalletChallenge(serviceId, addr);
      if (!challenge.data) throw new Error(challenge.error || "Could not get a challenge");
      const sig = (await wallet.request({ method: "personal_sign", params: [challenge.data.message, addr] })) as string;
      setRegForm((prev) => ({ ...prev, payTo: addr }));
      setProofMessage(challenge.data.message);
      setProofSignature(sig);
      setProofFor(`${serviceId}|${addr.toLowerCase()}`);
    } catch (err: any) {
      setProofSignature("");
      setProofMessage("");
      setProofError(err?.message || "Signing was cancelled");
    } finally {
      setIsGeneratingProof(false);
    }
  };

  // Filter and sort services
  const filteredServices = services
    .filter((s) => {
      if (!showFixtures && s.isFixture) return false;
      if (selectedCategory !== "all" && s.category !== selectedCategory) return false;
      if (maxPrice && parseFloat(s.priceUsdc) > parseFloat(maxPrice)) return false;
      if (minSuccess !== "all" && s.reputation.successRate < parseFloat(minSuccess)) return false;
      if (
        searchQuery &&
        !s.name.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !s.description.toLowerCase().includes(searchQuery.toLowerCase()) &&
        !s.id.toLowerCase().includes(searchQuery.toLowerCase())
      ) {
        return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (sortOption === "price") return parseFloat(a.priceUsdc) - parseFloat(b.priceUsdc);
      if (sortOption === "latency") return (a.reputation.medianLatencyMs || 9999) - (b.reputation.medianLatencyMs || 9999);
      if (sortOption === "successRate") return b.reputation.successRate - a.reputation.successRate;
      if (sortOption === "name") return a.name.localeCompare(b.name);
      // default: score (best value)
      return Number(a.costPerSuccessUnits || 0) - Number(b.costPerSuccessUnits || 0);
    });

  const handleRegisterSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsRegistering(true);
    setRegStatus(null);

    try {
      let inputSchemaObj = {};
      let outputSchemaObj = {};
      try {
        inputSchemaObj = JSON.parse(regForm.inputSchema);
        outputSchemaObj = JSON.parse(regForm.outputSchema);
      } catch {
        setRegStatus({ ok: false, msg: "Invalid JSON in input or output schema" });
        setIsRegistering(false);
        return;
      }

      const listing = {
        id: regForm.id.trim(),
        name: regForm.name.trim(),
        category: regForm.category,
        method: regForm.method,
        endpoint: regForm.endpoint.trim(),
        price: regForm.price.trim(),
        payTo: regForm.payTo.trim(),
        description: regForm.description.trim(),
        inputSchema: inputSchemaObj,
        outputSchema: outputSchemaObj,
      };

      let res;
      if (useWalletProof) {
        if (!proofSignature || proofFor !== `${listing.id}|${listing.payTo.toLowerCase()}`) {
          setRegStatus({ ok: false, msg: "Sign the wallet challenge for this Service ID and payTo first" });
          setIsRegistering(false);
          return;
        }
        res = await registerWalletProofService(listing, { message: proofMessage, signature: proofSignature });
        setProofSignature(""); // challenges are one use
        setProofMessage("");
      } else {
        res = await registerService(listing);
      }

      setIsRegistering(false);

      if (res.error) {
        setRegStatus({ ok: false, msg: res.error });
      } else {
        setRegStatus({ ok: true, msg: "Service with verified wallet proof registered successfully!" });
        onRefresh();
        setTimeout(() => {
          setIsRegisterOpen(false);
          setRegStatus(null);
        }, 1500);
      }
    } catch (err: any) {
      setIsRegistering(false);
      setRegStatus({ ok: false, msg: err.message || "Failed to register" });
    }
  };

  return (
    <div className="space-y-6 pb-16">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-[#1e2538]">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight">Marketplace &amp; Services</h1>
          <p className="text-xs text-slate-400 mt-1">
            Discover and invoke verified sellers settling in USDC per call over HTTP 402 on Base Sepolia
          </p>
        </div>

        <div className="flex items-center gap-2.5 flex-wrap self-start sm:self-auto">
          {onNavigateToPortal && (
            <button
              onClick={onNavigateToPortal}
              className="flex items-center gap-2 px-3.5 py-2 rounded-xl bg-[#141926] hover:bg-[#1c2438] text-purple-300 hover:text-white border border-[#2b354d] text-xs font-semibold transition-all cursor-pointer shadow-sm"
              title="Open Dronacharya Portal for Buyer & Seller Registration"
            >
              <span className="flex h-4 w-4 items-center justify-center rounded bg-purple-500 text-[9px] font-extrabold text-white">
                DN
              </span>
              <span>Dronacharya Registration</span>
            </button>
          )}

          <button
            onClick={() => setIsRegisterOpen(true)}
            className="flex items-center gap-2 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold shadow-lg shadow-purple-600/20 transition-all cursor-pointer"
          >
            <Plus className="h-4 w-4" />
            <span>Register Service</span>
          </button>
        </div>
      </div>

      {/* Filter Bar */}
      <div className="space-y-3 bg-[#121624] p-4 rounded-2xl border border-[#222b3d]">
        {/* Category Pills */}
        <div className="flex items-center gap-2 overflow-x-auto pb-1">
          {["all", "scraping", "data", "inference"].map((cat) => (
            <button
              key={cat}
              onClick={() => setSelectedCategory(cat)}
              className={`px-3 py-1.5 rounded-xl text-xs font-semibold capitalize transition-all cursor-pointer ${
                selectedCategory === cat
                  ? "bg-purple-600 text-white shadow-sm"
                  : "bg-[#0a0d14] text-slate-400 hover:text-white border border-[#1e2538]"
              }`}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Inputs & Dropdowns */}
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="relative">
            <Search className="h-4 w-4 text-slate-500 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search services..."
              className="w-full bg-[#0a0d14] rounded-xl pl-9 pr-3 py-2 text-xs text-white placeholder-slate-500 border border-[#1e2638] focus:outline-none focus:border-purple-500"
            />
          </div>

          <div>
            <input
              type="text"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="Max Price (e.g. 0.005)"
              className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 border border-[#1e2638] focus:outline-none focus:border-purple-500 font-mono"
            />
          </div>

          <div>
            <select
              value={minSuccess}
              onChange={(e) => setMinSuccess(e.target.value)}
              className="w-full bg-[#0a0d14] text-xs text-slate-300 rounded-xl px-3 py-2 border border-[#1e2638] focus:outline-none focus:border-purple-500 cursor-pointer"
            >
              <option value="all">Min Success: Any</option>
              <option value="0.5">≥ 50% Success</option>
              <option value="0.8">≥ 80% Success</option>
              <option value="0.95">≥ 95% Success</option>
            </select>
          </div>

          <div>
            <select
              value={sortOption}
              onChange={(e) => setSortOption(e.target.value as any)}
              className="w-full bg-[#0a0d14] text-xs text-slate-300 rounded-xl px-3 py-2 border border-[#1e2638] focus:outline-none focus:border-purple-500 cursor-pointer"
            >
              <option value="score">Best Value (Price ÷ Success)</option>
              <option value="price">Cheapest</option>
              <option value="latency">Fastest</option>
              <option value="successRate">Most Reliable</option>
              <option value="name">Name</option>
            </select>
          </div>

          <div className="flex items-center">
            <label className="flex items-center gap-2 text-xs text-slate-400 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={showFixtures}
                onChange={(e) => setShowFixtures(e.target.checked)}
                className="rounded border-[#263147] bg-[#0a0d14] text-purple-600 focus:ring-0"
              />
              <span>Show test fixtures</span>
            </label>
          </div>
        </div>
      </div>

      {/* Services Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {filteredServices.length === 0 ? (
          <div className="col-span-full py-16 text-center text-slate-400 bg-[#121624] rounded-2xl border border-[#222b3d]">
            <p className="font-semibold text-slate-300">No services match the selected criteria.</p>
            <p className="text-xs text-slate-400 mt-1">Try resetting filters or registering a new service.</p>
          </div>
        ) : (
          filteredServices.map((svc) => {
            const successPct = Math.round(svc.reputation.successRate * 100);
            const rateColor =
              successPct >= 90
                ? "text-emerald-400 bg-emerald-500/10 border-emerald-500/30"
                : successPct >= 60
                ? "text-amber-400 bg-amber-500/10 border-amber-500/30"
                : "text-rose-400 bg-rose-500/10 border-rose-500/30";

            return (
              <div
                key={svc.id}
                className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 shadow-sm hover:border-purple-500/40 transition-all flex flex-col justify-between space-y-4 group"
              >
                <div className="space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-white text-base group-hover:text-purple-300 transition-colors">
                          {svc.name}
                        </h3>
                        {svc.isFixture && (
                          <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-500/15 text-amber-300 border border-amber-500/30 uppercase tracking-wider">
                            Fixture
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-400 font-mono mt-0.5">
                        Seller: {svc.sellerId}
                      </div>
                    </div>
                    <span className="text-[11px] font-semibold uppercase px-2 py-0.5 rounded-md bg-[#1e2638] text-slate-300">
                      {svc.category}
                    </span>
                  </div>

                  <p className="text-xs text-slate-400 leading-relaxed line-clamp-3">
                    {svc.description}
                  </p>
                </div>

                <div className="space-y-3 pt-3 border-t border-[#1e2538]">
                  {/* Price & Reputation stats */}
                  <div className="grid grid-cols-3 gap-2 text-center">
                    <div className="p-2 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                      <div className="text-[10px] text-slate-400">Price</div>
                      <div className="font-bold text-xs text-white font-mono mt-0.5">
                        {svc.priceUsdc} USDC
                      </div>
                    </div>

                    <div className="p-2 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                      <div className="text-[10px] text-slate-400">Success</div>
                      <div className={`font-bold text-xs font-mono mt-0.5 ${successPct >= 90 ? "text-emerald-400" : "text-amber-400"}`}>
                        {successPct}%
                      </div>
                    </div>

                    <div className="p-2 rounded-xl bg-[#0a0d14] border border-[#1e2538]">
                      <div className="text-[10px] text-slate-400">Latency</div>
                      <div className="font-bold text-xs text-white font-mono mt-0.5">
                        {svc.reputation.medianLatencyMs ? `${svc.reputation.medianLatencyMs} ms` : "—"}
                      </div>
                    </div>
                  </div>

                  {/* PayTo address */}
                  <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 bg-[#0a0d14] p-2 rounded-xl border border-[#1e2538]">
                    <span className="truncate" title={svc.payTo}>
                      payTo: {svc.payTo.slice(0, 6)}...{svc.payTo.slice(-4)}
                    </span>
                    <div className="flex items-center gap-1 shrink-0">
                      <button
                        onClick={() => copyAddress(svc.payTo)}
                        className="p-1 hover:text-white rounded"
                        title="Copy payTo address"
                      >
                        {copiedAddr === svc.payTo ? (
                          <Check className="h-3 w-3 text-emerald-400" />
                        ) : (
                          <Copy className="h-3 w-3" />
                        )}
                      </button>
                      <a
                        href={`${explorerUrl}/address/${svc.payTo}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="p-1 hover:text-white rounded"
                        title="View on Base Sepolia"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    </div>
                  </div>

                  {/* Actions */}
                  <button
                    onClick={() => setInspectedService(svc)}
                    className="w-full flex items-center justify-center gap-1.5 py-2 rounded-xl bg-[#1a2133] hover:bg-[#232c45] text-slate-200 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Code2 className="h-3.5 w-3.5" />
                    <span>Inspect Schemas</span>
                  </button>
                </div>
              </div>
            );
          })
        )}
      </div>

      {/* Schema Inspector Modal */}
      {inspectedService && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-[#222b3d] bg-[#121624] p-6 shadow-2xl space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-white">{inspectedService.name}</h2>
                <p className="text-xs text-slate-400 font-mono mt-0.5">
                  {inspectedService.method} {inspectedService.endpoint}
                </p>
              </div>
              <button
                onClick={() => setInspectedService(null)}
                className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <div className="overflow-y-auto space-y-4 pr-1">
              <div>
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Input JSON Schema
                </h4>
                <div className="rounded-xl bg-[#0a0d14] border border-[#1e2538] p-3 text-xs font-mono text-purple-300 overflow-x-auto">
                  <pre>{JSON.stringify(inspectedService.inputSchema, null, 2)}</pre>
                </div>
              </div>

              <div>
                <h4 className="text-xs font-semibold text-slate-300 uppercase tracking-wider mb-1.5">
                  Output JSON Schema
                </h4>
                <div className="rounded-xl bg-[#0a0d14] border border-[#1e2538] p-3 text-xs font-mono text-indigo-300 overflow-x-auto">
                  <pre>{JSON.stringify(inspectedService.outputSchema, null, 2)}</pre>
                </div>
              </div>
            </div>

            <div className="pt-2 border-t border-[#1e2538] flex justify-end">
              <button
                onClick={() => setInspectedService(null)}
                className="px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 text-white text-xs font-semibold transition-colors"
              >
                Done
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Register Service Modal */}
      {isRegisterOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm p-4">
          <div className="w-full max-w-2xl rounded-2xl border border-[#222b3d] bg-[#121624] p-6 shadow-2xl space-y-4 max-h-[90vh] flex flex-col">
            <div className="flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-white">Register a New Service</h2>
                <p className="text-xs text-slate-400 mt-0.5">
                  Listings are insert-only on Base Sepolia. Price is capped at 0.10 USDC.
                </p>
              </div>
              <button
                onClick={() => setIsRegisterOpen(false)}
                className="p-1 text-slate-400 hover:text-white rounded-lg hover:bg-white/5"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            <form onSubmit={handleRegisterSubmit} className="overflow-y-auto space-y-4 pr-1">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Service ID</label>
                  <input
                    type="text"
                    required
                    value={regForm.id}
                    onChange={(e) => setRegForm({ ...regForm, id: e.target.value })}
                    placeholder="my-custom-service"
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Display Name</label>
                  <input
                    type="text"
                    required
                    value={regForm.name}
                    onChange={(e) => setRegForm({ ...regForm, name: e.target.value })}
                    placeholder="Custom Scraper API"
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Category</label>
                  <select
                    value={regForm.category}
                    onChange={(e) => setRegForm({ ...regForm, category: e.target.value })}
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-slate-300 border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  >
                    <option value="scraping">scraping</option>
                    <option value="data">data</option>
                    <option value="inference">inference</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">HTTP Method</label>
                  <select
                    value={regForm.method}
                    onChange={(e) => setRegForm({ ...regForm, method: e.target.value })}
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-slate-300 border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  >
                    <option value="GET">GET</option>
                    <option value="POST">POST</option>
                  </select>
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-400 mb-1">Endpoint URL</label>
                  <input
                    type="url"
                    required
                    value={regForm.endpoint}
                    onChange={(e) => setRegForm({ ...regForm, endpoint: e.target.value })}
                    placeholder="https://example.com/api/scrape"
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">Price (USDC)</label>
                  <input
                    type="text"
                    required
                    value={regForm.price}
                    onChange={(e) => setRegForm({ ...regForm, price: e.target.value })}
                    placeholder="0.005"
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-400 mb-1">payTo Address</label>
                  <input
                    type="text"
                    required
                    value={regForm.payTo}
                    onChange={(e) => setRegForm({ ...regForm, payTo: e.target.value })}
                    placeholder="0x..."
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] font-mono focus:outline-none focus:border-purple-500"
                  />
                </div>

                {/* Cryptographic Wallet Proof (Part 2 Requirement) */}
                <div className="col-span-2 p-3.5 rounded-xl bg-[#0e1322] border border-purple-500/30 space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <Key className="h-4 w-4 text-purple-400" />
                      <span className="text-xs font-bold text-white">Cryptographic Wallet Ownership Proof (EIP-191)</span>
                    </div>
                    <label className="flex items-center gap-1.5 text-xs text-slate-300 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={useWalletProof}
                        onChange={(e) => setUseWalletProof(e.target.checked)}
                        className="rounded border-slate-700 bg-slate-900 text-purple-600 focus:ring-purple-500"
                      />
                      <span>Enable Proof</span>
                    </label>
                  </div>

                  {useWalletProof && (
                    <div className="space-y-2">
                      <p className="text-[11px] text-slate-400 leading-relaxed">
                        To prevent unauthorized listings, sign a one-time server challenge with your browser wallet for <code className="text-purple-300 font-mono">{regForm.payTo || "payTo"}</code>.
                      </p>
                      <div className="flex items-center gap-2 flex-wrap">
                        <button
                          type="button"
                          disabled={isGeneratingProof}
                          onClick={generateProof}
                          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-purple-600 hover:bg-purple-500 text-white font-bold text-xs shadow-sm transition-colors cursor-pointer"
                        >
                          <Sparkles className="h-3.5 w-3.5" />
                          <span>{isGeneratingProof ? "Waiting for wallet..." : "Sign with my wallet"}</span>
                        </button>
                        {proofSignature && (
                          <span className="text-[10px] font-mono px-2 py-1 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 flex items-center gap-1">
                            <Check className="h-3 w-3" />
                            <span>Signed · {proofSignature.slice(0, 14)}... (verified on submit)</span>
                          </span>
                        )}
                      </div>
                      {proofError && <div className="text-[10px] text-rose-400">{proofError}</div>}
                      {proofSignature && (
                        <div className="p-2 whitespace-pre-wrap rounded bg-[#080b12] border border-[#1a2236] text-[10px] font-mono text-slate-300 break-all">
                          <div><span className="text-slate-500">Msg:</span> {proofMessage}</div>
                          <div><span className="text-slate-500">Sig:</span> {proofSignature}</div>
                        </div>
                      )}
                    </div>
                  )}
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-400 mb-1">Description</label>
                  <textarea
                    rows={2}
                    required
                    value={regForm.description}
                    onChange={(e) => setRegForm({ ...regForm, description: e.target.value })}
                    placeholder="Describe what the service provides and pricing semantics"
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-400 mb-1">Input JSON Schema</label>
                  <textarea
                    rows={4}
                    required
                    value={regForm.inputSchema}
                    onChange={(e) => setRegForm({ ...regForm, inputSchema: e.target.value })}
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white font-mono border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  />
                </div>

                <div className="col-span-2">
                  <label className="block text-xs font-medium text-slate-400 mb-1">Output JSON Schema</label>
                  <textarea
                    rows={4}
                    required
                    value={regForm.outputSchema}
                    onChange={(e) => setRegForm({ ...regForm, outputSchema: e.target.value })}
                    className="w-full bg-[#0a0d14] rounded-xl px-3 py-2 text-xs text-white font-mono border border-[#1e2538] focus:outline-none focus:border-purple-500"
                  />
                </div>
              </div>

              {regStatus && (
                <div
                  className={`p-3 rounded-xl text-xs flex items-center gap-2 border ${
                    regStatus.ok
                      ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
                      : "bg-rose-500/15 border-rose-500/30 text-rose-300"
                  }`}
                >
                  {regStatus.ok ? (
                    <CheckCircle2 className="h-4 w-4 shrink-0" />
                  ) : (
                    <AlertCircle className="h-4 w-4 shrink-0" />
                  )}
                  <span>{regStatus.msg}</span>
                </div>
              )}

              <div className="pt-3 border-t border-[#1e2538] flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setIsRegisterOpen(false)}
                  className="px-4 py-2 rounded-xl bg-[#1e2638] hover:bg-[#28324a] text-slate-300 text-xs font-semibold"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isRegistering}
                  className="px-5 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-50 text-white text-xs font-bold transition-all"
                >
                  {isRegistering ? "Registering..." : "Submit Listing"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
