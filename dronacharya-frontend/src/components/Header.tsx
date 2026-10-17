import React, { useEffect, useRef, useState } from "react";
import { Film, Radio, RefreshCw, LogIn, LogOut, ShieldCheck, User } from "lucide-react";
import type { NavTab } from "../types.ts";
import { AUTH_EVENT, checkAuthSession, getAuthUser, loginWithGoogle, logoutUser, type AuthUser } from "../api/client.ts";

const GOOGLE_CLIENT_ID = (((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string) || "").trim();

interface HeaderProps {
  currentTab: NavTab;
  isBackendOffline: boolean;
  onRetryConnection: () => void;
  isReplayMode: boolean;
  onToggleReplayMode: () => void;
  isSimulatedReplay: boolean;
  onNavigate: (tab: NavTab) => void;
}

export const Header: React.FC<HeaderProps> = ({
  currentTab,
  isBackendOffline,
  onRetryConnection,
  isReplayMode,
  onToggleReplayMode,
  isSimulatedReplay,
  onNavigate,
}) => {
  const [user, setUser] = useState<AuthUser | null>(() => getAuthUser());

  const buttonRef = useRef<HTMLDivElement | null>(null);
  const [signInError, setSignInError] = useState<string | null>(null);

  useEffect(() => {
    const onAuth = (e: Event) => setUser((e as CustomEvent<AuthUser | null>).detail ?? null);
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  // Re-check a stored session with the server (it may have expired).
  useEffect(() => {
    if (!getAuthUser()) return;
    void checkAuthSession().then((res) => {
      if (!res.data?.authenticated) {
        void logoutUser();
        setUser(null);
      } else if (res.data.user) setUser(res.data.user);
    });
  }, []);

  // Google Identity Services button (only when a client ID is configured).
  useEffect(() => {
    if (!GOOGLE_CLIENT_ID || user) return;
    let cancelled = false;
    let tries = 0;
    const handleCredentialResponse = async (response: any) => {
      if (!response?.credential) return;
      const res = await loginWithGoogle(response.credential);
      if (res.data?.user) {
        setSignInError(null);
        setUser(res.data.user);
      } else setSignInError(res.error ?? "Sign-in failed");
    };
    const mount = () => {
      if (cancelled) return;
      const gis = (window as any).google?.accounts?.id;
      if (!gis || !buttonRef.current) {
        if (++tries < 50) setTimeout(mount, 200);
        return;
      }
      gis.initialize({ client_id: GOOGLE_CLIENT_ID, callback: handleCredentialResponse });
      gis.renderButton(buttonRef.current, { theme: "filled_black", size: "small", text: "signin_with", shape: "rectangular" });
    };
    mount();
    return () => {
      cancelled = true;
    };
  }, [user]);

  const handleSignOut = async () => {
    await logoutUser();
    setUser(null);
  };

  return (
    <header className="sticky top-0 z-40 w-full border-b border-[#1f2638] bg-[#0c0f17]/95 backdrop-blur px-4 sm:px-6 py-3">
      <div className="flex items-center justify-between gap-4">
        {/* Brand & Title */}
        <div className="flex items-center gap-3">
          <button
            onClick={() => onNavigate("overview")}
            className="flex items-center gap-2.5 text-left group focus:outline-none"
          >
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 font-extrabold text-white shadow-lg shadow-purple-500/20 group-hover:scale-105 transition-transform text-sm tracking-wider font-mono">
              DN
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-base tracking-tight text-white group-hover:text-purple-300 transition-colors">
                  Dronacharya
                </span>
                <span className="text-xs text-slate-500 font-mono">x402</span>
              </div>
              <p className="text-[11px] text-slate-400 hidden sm:block">
                Autonomous Pay-Per-Call Agent Economy
              </p>
            </div>
          </button>
        </div>

        {/* Center / Right controls */}
        <div className="flex items-center gap-2.5 sm:gap-3 flex-wrap justify-end">
          {/* Backend Status indicator (only if offline) */}
          {isBackendOffline && (
            <button
              onClick={onRetryConnection}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-rose-500/10 text-rose-400 border border-rose-500/30 hover:bg-rose-500/20 transition-colors"
              title="Click to retry connection"
            >
              <span className="h-2 w-2 rounded-sm bg-rose-500" />
              <span>Backend Offline</span>
              <RefreshCw className="h-3 w-3 ml-0.5" />
            </button>
          )}

          {/* Mode Switch: Live vs Replay Mode */}
          <div className="flex items-center bg-[#141926] p-0.5 rounded-lg border border-[#222b40]">
            <button
              onClick={() => isReplayMode && onToggleReplayMode()}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all ${
                !isReplayMode
                  ? "bg-purple-600 text-white shadow-sm font-semibold"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Radio className="h-3 w-3" />
              <span>Live</span>
            </button>
            <button
              onClick={() => !isReplayMode && onToggleReplayMode()}
              className={`flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-md transition-all ${
                isReplayMode
                  ? "bg-amber-500 text-slate-950 font-bold shadow-sm"
                  : "text-slate-400 hover:text-white"
              }`}
            >
              <Film className="h-3 w-3" />
              <span>Replay</span>
            </button>
          </div>

          {/* Dronacharya Portal Button */}
          <button
            onClick={() => onNavigate("portal")}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              currentTab === "portal"
                ? "bg-purple-600 text-white shadow-md shadow-purple-600/30 ring-1 ring-purple-400"
                : "bg-purple-600/15 text-purple-300 border border-purple-500/30 hover:bg-purple-600/25 hover:text-white"
            }`}
            title="Open Dronacharya Portal for Buyer & Seller Registration / Sign In"
          >
            <span className="flex h-4 w-4 items-center justify-center rounded bg-purple-500 text-[9px] font-extrabold text-white leading-none">
              DN
            </span>
            <span>Dronacharya Portal</span>
          </button>

          {/* Admin Registry Quick Link */}
          <button
            onClick={() => onNavigate("admin")}
            className={`hidden sm:flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition-all cursor-pointer ${
              currentTab === "admin"
                ? "bg-[#251f47] text-purple-200 border border-purple-500/40 shadow-sm"
                : "bg-[#141926] text-slate-300 border border-[#222b40] hover:text-white hover:bg-[#1a2133]"
            }`}
            title="Open Admin Payment Logging & Registry Audit"
          >
            <ShieldCheck className="h-3.5 w-3.5 text-purple-400" />
            <span>Admin</span>
          </button>

          {/* User Authentication Profile Chip */}
          {user ? (
            <div className="flex items-center gap-2 bg-[#141926] border border-[#242d42] px-2.5 py-1 rounded-lg text-xs">
              {user.picture ? (
                <img
                  src={user.picture}
                  alt={user.name || user.email}
                  className="h-5 w-5 rounded-md object-cover"
                />
              ) : (
                <div className="h-5 w-5 rounded-md bg-purple-600/30 text-purple-300 flex items-center justify-center font-bold text-[10px]">
                  {user.email.charAt(0).toUpperCase()}
                </div>
              )}
              <div className="hidden sm:flex flex-col text-left">
                <span className="text-[11px] font-semibold text-slate-200 truncate max-w-[130px]" title={user.email}>
                  {user.name || user.email.split("@")[0]}
                </span>
                <span className="text-[9px] font-mono text-emerald-400">
                  {user.canRunScout ? "Scout approved" : "Seller ready"}
                </span>
              </div>
              <button
                onClick={handleSignOut}
                className="text-slate-400 hover:text-white p-1 rounded hover:bg-white/5 transition-colors"
                title="Sign out"
              >
                <LogOut className="h-3.5 w-3.5" />
              </button>
            </div>
          ) : (
            GOOGLE_CLIENT_ID ? (
              <div className="flex items-center gap-2">
                <div ref={buttonRef} title="Sign in with Google" />
                {signInError && <span className="text-[10px] text-rose-400 max-w-[160px]">{signInError}</span>}
              </div>
            ) : (
              <span
                className="flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-lg bg-[#141926] text-slate-500 border border-[#242d42]"
                title="Set VITE_GOOGLE_CLIENT_ID (frontend) and GOOGLE_CLIENT_ID (server) to enable sign-in"
              >
                <LogIn className="h-3 w-3" />
                <span>Sign-in not configured</span>
              </span>
            )
          )}
        </div>
      </div>

      {/* Persistent Replay Warning Banner if in Replay Mode */}
      {isReplayMode && (
        <div
          className={`mt-2.5 px-3.5 py-1.5 rounded-lg text-xs font-medium flex items-center justify-between border ${
            isSimulatedReplay
              ? "bg-amber-500/15 border-amber-500/40 text-amber-200"
              : "bg-purple-500/15 border-purple-500/40 text-purple-200"
          }`}
        >
          <div className="flex items-center gap-2">
            <span className="font-bold uppercase tracking-wider text-[10px] px-1.5 py-0.5 rounded bg-black/30">
              {isSimulatedReplay ? "Simulated Mode" : "Session Replay"}
            </span>
            <span>
              {isSimulatedReplay
                ? "Simulated sample — not on chain. (Transaction explorer links are disabled for simulated records)."
                : "Replaying recorded on-chain session from backend database. Preserves real Base Sepolia transaction references."}
            </span>
          </div>
          <button
            onClick={onToggleReplayMode}
            className="underline hover:no-underline font-semibold ml-2 cursor-pointer text-xs"
          >
            Return to Live Mode
          </button>
        </div>
      )}
    </header>
  );
};
