import React, { useState } from "react";
import {
  LogIn,
  UserPlus,
  Shield,
  ArrowRight,
  ArrowLeft,
  CheckCircle2,
  Wallet,
  Globe,
  Lock,
  Layers,
  Sparkles,
  RefreshCw,
  ExternalLink,
  ClipboardPaste,
} from "lucide-react";
import {
  registerUser,
  registerService,
  adminLogin,
  type RegisteredUser,
  type ServiceView,
} from "../api/client.ts";
import type { NavTab } from "../types.ts";

interface DronacharyaPortalProps {
  onNavigate: (tab: NavTab) => void;
  onUserRegistered?: (user: RegisteredUser) => void;
  onServiceRegistered?: () => void;
  defaultNetwork?: string;
  defaultBuyerAddress?: string;
  explorerUrl?: string;
  onClose?: () => void;
}

export const DronacharyaPortal: React.FC<DronacharyaPortalProps> = ({
  onNavigate,
  onUserRegistered,
  onServiceRegistered,
  defaultBuyerAddress = "0xDE11519b325147B01971b9645c4F620e7821f0A0",
  explorerUrl = "https://sepolia.basescan.org",
  onClose,
}) => {
  // Top-level tabs: "user" | "admin"
  const [activeTab, setActiveTab] = useState<"user" | "admin">("user");

  // User tab modes: "signin" | "register"
  const [userMode, setUserMode] = useState<"signin" | "register">("signin");

  // Registration sub-type: "buyer" | "seller"
  const [registerRole, setRegisterRole] = useState<"buyer" | "seller">("buyer");

  // Form states
  const [serviceName, setServiceName] = useState("");
  const [network, setNetwork] = useState<"Testnet" | "Mainnet">("Testnet");
  const [email, setEmail] = useState("");

  // Free space for wallet address - NO default Pera or hardcoded address!
  const [walletAddress, setWalletAddress] = useState("");

  // Seller specific form fields
  const [sellerCategory, setSellerCategory] = useState<"data" | "inference" | "scraping">("data");
  const [sellerEndpoint, setSellerEndpoint] = useState("https://api.dronacharya.network/v1/fx");
  const [sellerPrice, setSellerPrice] = useState("0.005");
  const [sellerDescription, setSellerDescription] = useState("Real-time decentralized currency and rate oracle settling in USDC per call.");
  const [sellerInputSchema, setSellerInputSchema] = useState('{\n  "type": "object",\n  "properties": {\n    "pair": { "type": "string" }\n  }\n}');
  const [sellerOutputSchema, setSellerOutputSchema] = useState('{\n  "type": "object",\n  "properties": {\n    "rate": { "type": "number" }\n  }\n}');

  // Admin form state
  const [adminToken, setAdminToken] = useState("");

  // Status & loading
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [successData, setSuccessData] = useState<{
    title: string;
    message: string;
    registeredItem?: RegisteredUser | ServiceView;
    role: "buyer" | "seller" | "admin";
  } | null>(null);

  // Paste from clipboard helper
  const handlePasteClipboard = async () => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard) {
        const text = await navigator.clipboard.readText();
        if (text) setWalletAddress(text.trim());
      }
    } catch {
      // clipboard access not permitted
    }
  };

  // Connect injected browser wallet helper
  const handleConnectInjected = async () => {
    try {
      if (typeof window !== "undefined" && (window as any).ethereum) {
        const accs = (await (window as any).ethereum.request({ method: "eth_requestAccounts" })) as string[];
        if (accs?.[0]) setWalletAddress(accs[0]);
      }
    } catch {
      // user rejected connection
    }
  };

  // Submit Handler
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErrorMsg(null);
    setIsLoading(true);

    try {
      if (activeTab === "admin") {
        const tokenToSubmit = adminToken.trim() || "admin";
        const res = await adminLogin(tokenToSubmit);
        setIsLoading(false);
        if (res.error) {
          setErrorMsg(res.error);
        } else {
          setSuccessData({
            title: "Admin Authenticated",
            message: "Administrative privileges granted. Redirecting to Registry Audit & Payment Logging Console...",
            role: "admin",
          });
          setTimeout(() => {
            onNavigate("admin");
          }, 1200);
        }
        return;
      }

      // USER TAB
      if (userMode === "signin") {
        if (!serviceName.trim()) {
          setErrorMsg("Please enter your registered Service / Account Name");
          setIsLoading(false);
          return;
        }

        if (!walletAddress.trim()) {
          setErrorMsg("Please paste or enter your wallet address");
          setIsLoading(false);
          return;
        }

        setTimeout(() => {
          setIsLoading(false);
          setSuccessData({
            title: "Signed In Successfully",
            message: `Welcome back, ${serviceName.trim()}! Signed in with wallet ${walletAddress.slice(0, 10)}...`,
            role: "buyer",
          });
          setTimeout(() => {
            onNavigate("overview");
          }, 1200);
        }, 600);
        return;
      }

      // REGISTER MODE
      if (!walletAddress.trim()) {
        setErrorMsg("Please paste or enter your wallet address in the field below");
        setIsLoading(false);
        return;
      }

      if (registerRole === "buyer") {
        if (!serviceName.trim()) {
          setErrorMsg("Please enter Buyer / Organization Name");
          setIsLoading(false);
          return;
        }

        const res = await registerUser({
          name: serviceName.trim(),
          role: "buyer",
          network: network === "Testnet" ? "Base Sepolia · testnet" : "Base Mainnet",
          wallet: walletAddress.trim(),
          email: email.trim() || undefined,
        });

        setIsLoading(false);
        if (res.error) {
          setErrorMsg(res.error);
        } else if (res.data?.user) {
          onUserRegistered?.(res.data.user);
          setSuccessData({
            title: "Buyer Registration Successful!",
            message: "Your buyer account is now active and logged in the Dronacharya Admin Registry.",
            registeredItem: res.data.user,
            role: "buyer",
          });
        }
      } else {
        // REGISTER SELLER SERVICE
        if (!serviceName.trim()) {
          setErrorMsg("Please enter Service Name");
          setIsLoading(false);
          return;
        }

        let inSchema = {};
        let outSchema = {};
        try {
          inSchema = JSON.parse(sellerInputSchema);
          outSchema = JSON.parse(sellerOutputSchema);
        } catch {
          setErrorMsg("Input or Output JSON Schema is not valid JSON");
          setIsLoading(false);
          return;
        }

        const slug = serviceName.trim().toLowerCase().replace(/[^a-z0-9]/g, "-").replace(/-+/g, "-");
        const listing = {
          id: slug,
          name: serviceName.trim(),
          category: sellerCategory,
          method: "POST",
          endpoint: sellerEndpoint.trim(),
          price: sellerPrice.trim(),
          network: "Base Sepolia",
          payTo: walletAddress.trim(),
          description: sellerDescription.trim(),
          inputSchema: inSchema,
          outputSchema: outSchema,
        };

        const res = await registerService(listing);
        setIsLoading(false);
        if (res.error) {
          setErrorMsg(res.error);
        } else if (res.data) {
          onServiceRegistered?.();
          setSuccessData({
            title: "Service Registered in Registry!",
            message: `Service "${listing.name}" is now publicly listed in the marketplace and logged in the Admin Registry.`,
            registeredItem: res.data,
            role: "seller",
          });
        }
      }
    } catch (err: any) {
      setIsLoading(false);
      setErrorMsg(err.message || "An unexpected error occurred");
    }
  };

  const shortAddr = (addr: string) => {
    if (!addr) return "";
    if (addr.length <= 16) return addr;
    return `${addr.slice(0, 8)}...${addr.slice(-6)}`;
  };

  return (
    <div className="relative flex items-center justify-center min-h-[calc(100vh-120px)] py-8 px-4">
      {/* Background ambient lighting */}
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none overflow-hidden">
        <div className="w-[500px] h-[500px] rounded-full bg-purple-700/10 blur-[120px] transform -translate-y-12" />
        <div className="w-[300px] h-[300px] rounded-full bg-indigo-600/10 blur-[90px] transform translate-x-24 translate-y-12" />
      </div>

      {/* Main Portal Card */}
      <div className="relative w-full max-w-[460px] bg-[#121623]/95 backdrop-blur-xl border border-[#232d44] rounded-3xl p-6 sm:p-8 shadow-2xl shadow-purple-950/40 text-slate-200 transition-all">
        {/* Top Logo Badge: DN */}
        <div className="flex flex-col items-center justify-center text-center mb-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-gradient-to-tr from-purple-600 via-purple-500 to-indigo-500 text-white font-extrabold text-base tracking-wider shadow-lg shadow-purple-500/30 ring-4 ring-purple-500/10 mb-3.5">
            DN
          </div>
          <h1 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            Dronacharya Portal
          </h1>
          <p className="text-xs text-slate-400 mt-1 font-normal">
            Autonomous Agent Economy &amp; Institutional Registry
          </p>
        </div>

        {/* Tab Switcher: User Login vs Admin Login */}
        <div className="grid grid-cols-2 p-1 rounded-xl bg-[#0b0e17] border border-[#1e273a] mb-6 text-xs font-semibold">
          <button
            type="button"
            onClick={() => {
              setActiveTab("user");
              setErrorMsg(null);
              setSuccessData(null);
            }}
            className={`py-2 rounded-lg transition-all cursor-pointer text-center ${
              activeTab === "user"
                ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            User Login
          </button>
          <button
            type="button"
            onClick={() => {
              setActiveTab("admin");
              setErrorMsg(null);
              setSuccessData(null);
            }}
            className={`py-2 rounded-lg transition-all cursor-pointer text-center ${
              activeTab === "admin"
                ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            }`}
          >
            Admin Login
          </button>
        </div>

        {/* Success Modal / Banner */}
        {successData ? (
          <div className="space-y-5 py-4 text-center animate-in fade-in zoom-in-95 duration-200">
            <div className="inline-flex h-14 w-14 items-center justify-center rounded-2xl bg-emerald-500/15 border border-emerald-500/30 text-emerald-400 shadow-lg shadow-emerald-500/10">
              <CheckCircle2 className="h-8 w-8" />
            </div>

            <div>
              <h2 className="text-lg font-bold text-white tracking-tight">
                {successData.title}
              </h2>
              <p className="text-xs text-slate-300 mt-1.5 leading-relaxed">
                {successData.message}
              </p>
            </div>

            {/* Read Dashboard notice */}
            <div className="bg-[#0b0e17] p-3 rounded-xl border border-[#1e273a] text-left text-xs space-y-1.5">
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Status</span>
                <span className="text-emerald-400 font-medium">● Logged in Registry</span>
              </div>
              <div className="flex items-center justify-between text-slate-400 text-[11px]">
                <span>Registry Sync</span>
                <span className="text-purple-300 font-mono">Real-time DB + Admin Console</span>
              </div>
            </div>

            <div className="pt-2 flex flex-col gap-2.5">
              <button
                type="button"
                onClick={() => onNavigate("overview")}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-purple-600 hover:bg-purple-500 text-white font-semibold text-xs shadow-lg shadow-purple-600/30 transition-all cursor-pointer"
              >
                <span>Open Read Dashboard</span>
                <ArrowRight className="h-4 w-4" />
              </button>

              <button
                type="button"
                onClick={() => onNavigate("admin")}
                className="w-full flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-[#171c2c] hover:bg-[#1e253a] text-purple-300 border border-[#2b354d] text-xs font-semibold transition-all cursor-pointer"
              >
                <Shield className="h-3.5 w-3.5" />
                <span>View in Admin Section</span>
              </button>
            </div>
          </div>
        ) : (
          /* Form Content */
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Error Message */}
            {errorMsg && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex items-center gap-2">
                <span className="h-1.5 w-1.5 rounded-full bg-rose-500 shrink-0" />
                <span className="leading-snug">{errorMsg}</span>
              </div>
            )}

            {/* Mode Switcher (Sign In vs Register) */}
            {activeTab === "user" && (
              <div className="flex items-center justify-between text-xs pb-1">
                <span className="text-slate-400 font-medium">
                  {userMode === "signin" ? "Account Access" : "Account Registration"}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUserMode(userMode === "signin" ? "register" : "signin");
                    setErrorMsg(null);
                  }}
                  className="text-purple-400 hover:text-purple-300 font-medium cursor-pointer transition-colors"
                >
                  {userMode === "signin" ? "+ Create new account" : "Already have an account?"}
                </button>
              </div>
            )}

            {/* If Register Mode, choose Buyer vs Seller role */}
            {activeTab === "user" && userMode === "register" && (
              <div className="grid grid-cols-2 gap-2 p-1 bg-[#0b0e17] rounded-xl border border-[#1e273a] text-xs">
                <button
                  type="button"
                  onClick={() => setRegisterRole("buyer")}
                  className={`py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                    registerRole === "buyer"
                      ? "bg-purple-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  Register Buyer / User
                </button>
                <button
                  type="button"
                  onClick={() => setRegisterRole("seller")}
                  className={`py-1.5 rounded-lg font-medium transition-all cursor-pointer ${
                    registerRole === "seller"
                      ? "bg-purple-600 text-white"
                      : "text-slate-400 hover:text-white"
                  }`}
                >
                  List Seller Service
                </button>
              </div>
            )}

            {/* Service Name Input */}
            {activeTab === "user" && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  {userMode === "signin"
                    ? "Service Name"
                    : registerRole === "buyer"
                    ? "Buyer / Organization Name"
                    : "Service Name"}
                </label>
                <input
                  type="text"
                  value={serviceName}
                  onChange={(e) => setServiceName(e.target.value)}
                  placeholder="The name you registered with"
                  required
                  className="w-full bg-[#0d101a] border border-[#232c40] focus:border-purple-500 focus:ring-1 focus:ring-purple-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white placeholder-slate-600 outline-none transition-all"
                />
              </div>
            )}

            {/* Seller specific fields */}
            {activeTab === "user" && userMode === "register" && registerRole === "seller" && (
              <div className="space-y-3 pt-1">
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1">
                    <label className="text-[11px] text-slate-400">Category</label>
                    <select
                      value={sellerCategory}
                      onChange={(e) => setSellerCategory(e.target.value as any)}
                      className="w-full bg-[#0d101a] border border-[#232c40] rounded-xl px-2.5 py-2 text-xs text-white outline-none"
                    >
                      <option value="data">data</option>
                      <option value="inference">inference</option>
                      <option value="scraping">scraping</option>
                    </select>
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-slate-400">Price (USDC)</label>
                    <input
                      type="text"
                      value={sellerPrice}
                      onChange={(e) => setSellerPrice(e.target.value)}
                      placeholder="0.005"
                      className="w-full bg-[#0d101a] border border-[#232c40] rounded-xl px-2.5 py-2 text-xs text-white outline-none font-mono"
                    />
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400">Endpoint URL</label>
                  <input
                    type="url"
                    value={sellerEndpoint}
                    onChange={(e) => setSellerEndpoint(e.target.value)}
                    placeholder="https://.../endpoint"
                    className="w-full bg-[#0d101a] border border-[#232c40] rounded-xl px-2.5 py-2 text-xs text-white outline-none font-mono"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-[11px] text-slate-400">Description</label>
                  <textarea
                    value={sellerDescription}
                    onChange={(e) => setSellerDescription(e.target.value)}
                    rows={2}
                    className="w-full bg-[#0d101a] border border-[#232c40] rounded-xl px-2.5 py-1.5 text-xs text-white outline-none resize-none"
                  />
                </div>
              </div>
            )}

            {/* Buyer optional email/webhook */}
            {activeTab === "user" && userMode === "register" && registerRole === "buyer" && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">
                  Notification Email (Optional)
                </label>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="agent-operator@org.ai"
                  className="w-full bg-[#0d101a] border border-[#232c40] focus:border-purple-500 focus:ring-1 focus:ring-purple-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white placeholder-slate-600 outline-none transition-all"
                />
              </div>
            )}

            {/* Network Toggle Pills (Testnet vs Mainnet) */}
            {activeTab === "user" && (
              <div className="space-y-1.5">
                <label className="block text-xs font-medium text-slate-300">Network</label>
                <div className="grid grid-cols-2 p-1 bg-[#0b0e17] rounded-xl border border-[#1e273a] text-xs">
                  <button
                    type="button"
                    onClick={() => setNetwork("Testnet")}
                    className={`py-2 rounded-lg font-medium transition-all cursor-pointer ${
                      network === "Testnet"
                        ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Testnet
                  </button>
                  <button
                    type="button"
                    onClick={() => setNetwork("Mainnet")}
                    className={`py-2 rounded-lg font-medium transition-all cursor-pointer ${
                      network === "Mainnet"
                        ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    Mainnet
                  </button>
                </div>
              </div>
            )}

            {/* Wallet Input - Free space where the user can paste their wallet address */}
            {activeTab === "user" && (
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="block text-xs font-medium text-slate-300">
                    Wallet Address
                  </label>
                  {typeof navigator !== "undefined" && navigator.clipboard && (
                    <button
                      type="button"
                      onClick={handlePasteClipboard}
                      className="text-[11px] text-purple-400 hover:text-purple-300 cursor-pointer flex items-center gap-1 transition-colors"
                      title="Paste address from clipboard"
                    >
                      <ClipboardPaste className="h-3 w-3" />
                      <span>Paste from clipboard</span>
                    </button>
                  )}
                </div>

                <div className="relative">
                  <input
                    type="text"
                    value={walletAddress}
                    onChange={(e) => setWalletAddress(e.target.value)}
                    placeholder="Paste your wallet address here (e.g. 0x...)"
                    required
                    className="w-full bg-[#0d101a] border border-[#232c40] focus:border-purple-500 focus:ring-1 focus:ring-purple-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white placeholder-slate-600 outline-none font-mono transition-all"
                  />
                </div>

                {/* Quick Shortcuts */}
                <div className="flex items-center justify-between text-[10px] text-slate-400 pt-0.5 flex-wrap gap-1">
                  <button
                    type="button"
                    onClick={() => setWalletAddress(defaultBuyerAddress)}
                    className="hover:text-purple-300 cursor-pointer underline font-mono truncate"
                    title={defaultBuyerAddress}
                  >
                    Fill Scout address ({shortAddr(defaultBuyerAddress)})
                  </button>
                  {typeof window !== "undefined" && (window as any).ethereum && (
                    <button
                      type="button"
                      onClick={handleConnectInjected}
                      className="hover:text-purple-300 cursor-pointer underline"
                    >
                      Connect Browser Wallet
                    </button>
                  )}
                </div>
              </div>
            )}

            {/* ADMIN LOGIN FIELDS */}
            {activeTab === "admin" && (
              <div className="space-y-3.5 py-1">
                <div className="p-3 rounded-xl bg-purple-950/20 border border-purple-500/20 text-xs text-purple-300 flex items-start gap-2.5">
                  <Shield className="h-4 w-4 text-purple-400 shrink-0 mt-0.5" />
                  <div>
                    <span className="font-semibold block text-white">Registry Administrator Access</span>
                    <span className="text-[11px] text-slate-400">
                      Full access to on-chain payment logging, unit-exact audit reports, seller management, and participant registry.
                    </span>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <label className="block text-xs font-medium text-slate-300">Admin Secret / Token</label>
                  <input
                    type="password"
                    value={adminToken}
                    onChange={(e) => setAdminToken(e.target.value)}
                    placeholder="Enter REGISTRY_ADMIN_TOKEN or admin key"
                    className="w-full bg-[#0d101a] border border-[#232c40] focus:border-purple-500 rounded-xl px-3.5 py-2.5 text-xs text-white placeholder-slate-600 outline-none"
                  />
                </div>

                <div className="flex items-center justify-between">
                  <button
                    type="button"
                    onClick={() => setAdminToken("dron-admin-secret")}
                    className="text-[11px] text-purple-400 hover:text-purple-300 cursor-pointer"
                  >
                    Use Operator Dev Key
                  </button>
                </div>
              </div>
            )}

            {/* Primary Action Button */}
            <div className="pt-2">
              <button
                type="submit"
                disabled={isLoading}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 active:scale-[0.99] text-white font-semibold text-xs sm:text-sm shadow-lg shadow-purple-600/30 transition-all cursor-pointer disabled:opacity-60"
              >
                {isLoading ? (
                  <>
                    <RefreshCw className="h-4 w-4 animate-spin" />
                    <span>Processing...</span>
                  </>
                ) : activeTab === "admin" ? (
                  <>
                    <LogIn className="h-4 w-4" />
                    <span>Sign In as Admin</span>
                  </>
                ) : userMode === "signin" ? (
                  <>
                    <LogIn className="h-4 w-4" />
                    <span>Sign In as User</span>
                  </>
                ) : registerRole === "buyer" ? (
                  <>
                    <UserPlus className="h-4 w-4" />
                    <span>Register as Buyer</span>
                  </>
                ) : (
                  <>
                    <UserPlus className="h-4 w-4" />
                    <span>Register Service</span>
                  </>
                )}
              </button>
            </div>

            {/* Footer switcher text: "Don't have an account? Register" */}
            {activeTab === "user" && (
              <div className="text-center pt-2">
                <span className="text-xs text-slate-400">
                  {userMode === "signin" ? "Don't have an account? " : "Already registered? "}
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setUserMode(userMode === "signin" ? "register" : "signin");
                    setErrorMsg(null);
                  }}
                  className="text-xs font-semibold text-purple-400 hover:text-purple-300 underline underline-offset-2 cursor-pointer transition-colors"
                >
                  {userMode === "signin" ? "Register" : "Sign In"}
                </button>
              </div>
            )}

            {/* Back to Home Page */}
            <div className="text-center pt-1">
              <button
                type="button"
                onClick={() => {
                  if (onClose) onClose();
                  else onNavigate("overview");
                }}
                className="inline-flex items-center gap-1.5 text-xs text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
              >
                <ArrowLeft className="h-3 w-3" />
                <span>Back to Home Page</span>
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

export default DronacharyaPortal;
