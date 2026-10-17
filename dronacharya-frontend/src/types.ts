import type { LedgerRow, ServiceView, SessionRecord, TaskDetail, WalletInfo } from "./api/client.ts";

export type NavTab = "overview" | "arena" | "console" | "transactions" | "marketplace" | "reconcile" | "wallets" | "portal" | "admin";

export interface RegisteredUser {
  id: string;
  name: string;
  role: "buyer" | "seller" | "user";
  network: string;
  wallet: string;
  email?: string;
  category?: string;
  serviceId?: string;
  status: "active" | "verified" | "pending";
  createdAt: string;
  updatedAt: string;
}

export interface AdminAuditReport {
  timestamp: string;
  network: string;
  chainId: number;
  registryStatus: string;
  summary: {
    totalVolumeUsdc: string;
    totalVolumeUnits: string;
    totalTransactions: number;
    paidCalls: number;
    paidOutputRejectedCalls: number;
    refusedCalls: number;
    failedCalls: number;
    pendingCalls: number;
    successRate: number;
    avgLatencyMs: number;
    discrepancies: number;
    reconciledToChain: boolean;
  };
  counts: {
    registeredUsers: number;
    registeredBuyers: number;
    registeredSellers: number;
    servicesListed: number;
    sessionsCount: number;
  };
  categories: {
    scraping: { services: number; volumeUsdc: string; paidCalls: number };
    data: { services: number; volumeUsdc: string; paidCalls: number };
    inference: { services: number; volumeUsdc: string; paidCalls: number };
  };
  recentLedger: LedgerRow[];
  registeredUsers: RegisteredUser[];
}

export interface ReplayState {
  isReplay: boolean;
  isSimulated: boolean;
  currentSessionId: string | null;
  recordedSessions: SessionRecord[];
  rows: LedgerRow[];
  currentStepIndex: number;
  isPlaying: boolean;
}

export interface InspectorTarget {
  type: "transaction" | "service" | "task";
  data: LedgerRow | ServiceView | TaskDetail;
}
