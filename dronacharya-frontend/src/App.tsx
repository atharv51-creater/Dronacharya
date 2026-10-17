import React, { useState, useEffect, useCallback } from "react";
import { Header } from "./components/Header.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { OverviewView } from "./components/OverviewView.tsx";
import { AgentArena } from "./components/AgentArena.tsx";
import { TransactionsView } from "./components/TransactionsView.tsx";
import { ConsoleView, type ActivityLine } from "./components/ConsoleView.tsx";
import { MarketplaceView } from "./components/MarketplaceView.tsx";
import { ReconciliationView } from "./components/ReconciliationView.tsx";
import { WalletsView } from "./components/WalletsView.tsx";
import { TransactionModal } from "./components/TransactionModal.tsx";
import { DronacharyaPortal } from "./components/DronacharyaPortal.tsx";
import { AdminRegistryView } from "./components/AdminRegistryView.tsx";
import {
  getMeta,
  getServices,
  getLedger,
  getSessions,
  getWallets,
  createLedgerStream,
  type MetaResponse,
  type ServiceView,
  type LedgerRow,
  type SessionRecord,
  type WalletInfo,
} from "./api/client.ts";
import sampleSession from "./demo/sample-session.json";
import type { NavTab } from "./types.ts";

export const App: React.FC = () => {
  const [currentTab, setCurrentTab] = useState<NavTab>("overview");
  const [meta, setMeta] = useState<MetaResponse | null>(null);
  const [services, setServices] = useState<ServiceView[]>([]);
  const [ledgerRows, setLedgerRows] = useState<LedgerRow[]>([]);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [wallets, setWallets] = useState<WalletInfo[]>([]);

  // Loading & Offline states
  const [isLoadingServices, setIsLoadingServices] = useState(false);
  const [isLoadingLedger, setIsLoadingLedger] = useState(false);
  const [isLoadingWallets, setIsLoadingWallets] = useState(false);
  const [isBackendOffline, setIsBackendOffline] = useState(false);

  // Inspector modal state
  const [inspectedRow, setInspectedRow] = useState<LedgerRow | null>(null);

  // Replay Mode states
  const [isReplayMode, setIsReplayMode] = useState(false);
  const [isSimulatedReplay, setIsSimulatedReplay] = useState(false);
  // Live lines from the Scout run the console is watching (shown in the Agent Arena too).
  const [liveFeed, setLiveFeed] = useState<ActivityLine[]>([]);
  const onActivity = useCallback((line: ActivityLine) => {
    setLiveFeed((prev) => (prev.length && prev[prev.length - 1]!.taskId !== line.taskId ? [line] : [...prev, line].slice(-60)));
  }, []);
  const [replayRows, setReplayRows] = useState<LedgerRow[]>([]);

  // 1. Fetch metadata
  const loadMeta = useCallback(async () => {
    const res = await getMeta();
    if (res.data) {
      setMeta(res.data);
      setIsBackendOffline(false);
    } else if (res.isOffline) {
      setIsBackendOffline(true);
    }
  }, []);

  // 2. Fetch services
  const loadServices = useCallback(async () => {
    setIsLoadingServices(true);
    const res = await getServices({ includeFixtures: true });
    setIsLoadingServices(false);
    if (res.data) {
      setServices(res.data.services);
      setIsBackendOffline(false);
    } else if (res.isOffline) {
      setIsBackendOffline(true);
    }
  }, []);

  // 3. Fetch ledger rows
  const loadLedger = useCallback(async () => {
    setIsLoadingLedger(true);
    const res = await getLedger({ limit: 1000 });
    setIsLoadingLedger(false);
    if (res.data) {
      setLedgerRows(res.data.rows);
      setIsBackendOffline(false);
    } else if (res.isOffline) {
      setIsBackendOffline(true);
    }
  }, []);

  // 4. Fetch sessions
  const loadSessions = useCallback(async () => {
    const res = await getSessions();
    if (res.data) {
      setSessions(res.data.sessions);
      setIsBackendOffline(false);
    } else if (res.isOffline) {
      setIsBackendOffline(true);
    }
  }, []);

  // 5. Fetch wallets
  const loadWallets = useCallback(async () => {
    setIsLoadingWallets(true);
    const res = await getWallets();
    setIsLoadingWallets(false);
    if (res.data) {
      setWallets(res.data.wallets);
      setIsBackendOffline(false);
    } else if (res.isOffline) {
      setIsBackendOffline(true);
    }
  }, []);

  // Initial load
  useEffect(() => {
    loadMeta();
    loadServices();
    loadLedger();
    loadSessions();
    loadWallets();
  }, [loadMeta, loadServices, loadLedger, loadSessions, loadWallets]);

  // Connect to SSE stream for live ledger row additions
  useEffect(() => {
    if (isReplayMode) return;

    let es: EventSource | null = null;
    try {
      es = createLedgerStream();
      es.addEventListener("row", ((event: any) => {
        try {
          const row: LedgerRow = JSON.parse(event.data);
          setLedgerRows((prev) => {
            const exists = prev.some((r) => r.id === row.id);
            if (exists) {
              return prev.map((r) => (r.id === row.id ? row : r));
            }
            return [row, ...prev];
          });
          loadSessions();
        } catch {
          // ignore parse error
        }
      }) as EventListener);

      es.onerror = () => {
        // stream dropped
      };
    } catch {
      // SSE connection error
    }

    return () => {
      es?.close();
    };
  }, [isReplayMode, loadSessions]);

  // Handle retry connection
  const handleRetryConnection = () => {
    setIsBackendOffline(false);
    loadMeta();
    loadServices();
    loadLedger();
    loadSessions();
    loadWallets();
  };

  // Toggle Replay Mode
  const handleToggleReplayMode = () => {
    if (!isReplayMode) {
      // Switch to Replay mode: check if recorded sessions exist
      if (sessions.length > 0) {
        setIsSimulatedReplay(false);
        // Use latest recorded session rows
        const latestSessionId = sessions[0]?.id;
        const sessionRows = ledgerRows.filter((r) => r.sessionId === latestSessionId);
        setReplayRows(sessionRows.length > 0 ? sessionRows : (sampleSession.rows as LedgerRow[]));
      } else {
        // No recorded sessions exist -> use sample-session.json with persistent banner
        setIsSimulatedReplay(true);
        setReplayRows(sampleSession.rows as LedgerRow[]);
      }
      setIsReplayMode(true);
      setCurrentTab("transactions");
    } else {
      // Switch back to live mode
      setIsReplayMode(false);
      setIsSimulatedReplay(false);
      loadLedger();
    }
  };

  // Active rows to display (Live vs Replay)
  const activeRows = isReplayMode ? replayRows : ledgerRows;

  // Total volume calculation
  const totalVolumeUsdc = React.useMemo(() => {
    let units = 0n;
    activeRows.forEach((r) => {
      if (r.status === "paid" || r.status === "paid_output_rejected") {
        units += BigInt(r.paidUnits || 0);
      }
    });
    const whole = units / 1000000n;
    const frac = (units % 1000000n).toString().padStart(6, "0");
    return `${whole}.${frac}`;
  }, [activeRows]);

  const explorerUrl = meta?.explorer || "https://sepolia.basescan.org";
  const buyerAddress = meta?.buyer || "0xDE11519b325147B01971b9645c4F620e7821f0A0";

  return (
    <div className="min-h-screen bg-[#0b0e14] text-slate-200 flex flex-col font-sans selection:bg-purple-500/30 selection:text-purple-200">
      {/* Top Header */}
      <Header
        currentTab={currentTab}
        isBackendOffline={isBackendOffline}
        onRetryConnection={handleRetryConnection}
        isReplayMode={isReplayMode}
        onToggleReplayMode={handleToggleReplayMode}
        isSimulatedReplay={isSimulatedReplay}
        onNavigate={setCurrentTab}
      />

      {/* Main Layout: Sidebar + Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Sidebar */}
        <div className="hidden md:block">
          <Sidebar
            currentTab={currentTab}
            onTabChange={setCurrentTab}
            buyerAddress={buyerAddress}
            explorerUrl={explorerUrl}
          />
        </div>

        {/* Center / Right Content Area */}
        <main className="flex-1 overflow-y-auto px-4 sm:px-8 py-6">
          {/* Offline Warning Banner */}
          {isBackendOffline && !isReplayMode && (
            <div className="mb-6 p-4 rounded-2xl bg-rose-500/10 border border-rose-500/30 text-rose-300 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-3 shadow-lg shadow-rose-950/20">
              <div className="flex items-center gap-2.5">
                <span className="h-2 w-2 rounded-sm bg-rose-500" />
                <div>
                  <span className="font-bold text-sm block">Backend API Offline</span>
                  <span className="text-slate-400">
                    Cannot reach backend services at the configured API base URL. Showing read-only offline state without simulated data in live mode.
                  </span>
                </div>
              </div>
              <button
                onClick={handleRetryConnection}
                className="px-4 py-2 rounded-xl bg-rose-600 hover:bg-rose-500 text-white font-semibold text-xs transition-colors shrink-0 cursor-pointer self-start sm:self-auto"
              >
                Retry Connection
              </button>
            </div>
          )}

          {/* Active Tab View */}
          {currentTab === "overview" && (
            <OverviewView
              onNavigate={setCurrentTab}
              buyerAddress={buyerAddress}
              totalTransactions={activeRows.length}
              totalVolumeUsdc={totalVolumeUsdc}
              totalServices={services.length}
              explorerUrl={explorerUrl}
            />
          )}

          {currentTab === "arena" && (
            <AgentArena
              buyerAddress={buyerAddress}
              services={services}
              recentLedgerRows={activeRows}
              liveFeed={liveFeed}
              onNavigateToConsole={() => setCurrentTab("console")}
              explorerUrl={explorerUrl}
            />
          )}

          {currentTab === "transactions" && (
            <TransactionsView
              rows={activeRows}
              isLoading={isLoadingLedger}
              onRefresh={loadLedger}
              onSelectRow={setInspectedRow}
              explorerUrl={explorerUrl}
              isSimulatedReplay={isSimulatedReplay}
            />
          )}

          {/* Kept mounted so a running task keeps streaming while you look at other tabs. */}
          <div hidden={currentTab !== "console"}>
            <ConsoleView
              explorerUrl={explorerUrl}
              examples={meta?.examples}
              onViewLedger={() => setCurrentTab("transactions")}
              onActivity={onActivity}
            />
          </div>

          {currentTab === "marketplace" && (
            <MarketplaceView
              services={services}
              isLoading={isLoadingServices}
              onRefresh={loadServices}
              explorerUrl={explorerUrl}
              onNavigateToPortal={() => setCurrentTab("portal")}
            />
          )}

          {currentTab === "reconcile" && (
            <ReconciliationView sessions={sessions} explorerUrl={explorerUrl} />
          )}

          {currentTab === "wallets" && (
            <WalletsView
              wallets={wallets}
              isLoading={isLoadingWallets}
              onRefresh={loadWallets}
              explorerUrl={explorerUrl}
            />
          )}

          {currentTab === "portal" && (
            <DronacharyaPortal
              onNavigate={setCurrentTab}
              onUserRegistered={() => {
                loadWallets();
              }}
              onServiceRegistered={() => {
                loadServices();
              }}
              defaultBuyerAddress={buyerAddress}
              explorerUrl={explorerUrl}
            />
          )}

          {currentTab === "admin" && (
            <AdminRegistryView
              onNavigate={setCurrentTab}
              onSelectRow={setInspectedRow}
              explorerUrl={explorerUrl}
            />
          )}
        </main>
      </div>

      {/* Transaction Details Inspector Modal */}
      <TransactionModal
        row={inspectedRow}
        onClose={() => setInspectedRow(null)}
        explorerUrl={explorerUrl}
        isSimulatedReplay={isSimulatedReplay}
      />
    </div>
  );
};
