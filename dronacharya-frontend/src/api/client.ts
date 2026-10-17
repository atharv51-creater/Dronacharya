// Central API client for Dronacharya
// All frontend API requests MUST go through this file.
// The browser reads only VITE_API_BASE_URL (and VITE_GOOGLE_CLIENT_ID in Header). No secrets here.

const BASE_URL = (((import.meta as any).env?.VITE_API_BASE_URL as string) || "").replace(/\/+$/, "");

export interface AuthUser {
  email: string;
  name?: string;
  picture?: string;
  canRunScout?: boolean;
  isAdmin?: boolean;
}

export interface MetaResponse {
  network: string;
  chainId: number;
  asset: {
    address: string;
    symbol: string;
    decimals: number;
  };
  explorer: string;
  facilitator?: string;
  buyer?: string;
  categories: string[];
  examples?: Array<{ title: string; task: string; budget: string }>;
  authRequired?: boolean;
  registry?: string;
  maxPriceUnits?: string;
}

const AUTH_TOKEN_KEY = "dron_auth_token";
const AUTH_USER_KEY = "dron_auth_user";

// The session token lives in memory, mirrored to sessionStorage (cleared when the tab closes). Never localStorage.
let memToken: string | null = null;
let memUser: AuthUser | null = null;

export function getAuthToken(): string | null {
  if (memToken) return memToken;
  try {
    memToken = sessionStorage.getItem(AUTH_TOKEN_KEY);
  } catch {
    // storage unavailable: memory only
  }
  return memToken;
}

export function setAuthToken(token: string | null, user?: AuthUser | null): void {
  memToken = token;
  memUser = token ? user ?? memUser : null;
  try {
    localStorage.removeItem(AUTH_TOKEN_KEY); // clean up anything an older build left behind
    localStorage.removeItem(AUTH_USER_KEY);
    if (token) {
      sessionStorage.setItem(AUTH_TOKEN_KEY, token);
      if (memUser) sessionStorage.setItem(AUTH_USER_KEY, JSON.stringify(memUser));
    } else {
      sessionStorage.removeItem(AUTH_TOKEN_KEY);
      sessionStorage.removeItem(AUTH_USER_KEY);
    }
  } catch {
    // ignore storage access errors
  }
  try {
    window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: memUser }));
  } catch {
    // non-browser
  }
}

/** Fired on window whenever the signed-in user changes (sign in, sign out, expiry). */
export const AUTH_EVENT = "dron-auth-change";
export const SIGN_IN_CONFIGURED = Boolean((((import.meta as any).env?.VITE_GOOGLE_CLIENT_ID as string) || "").trim());

export function getAuthUser(): AuthUser | null {
  if (memUser) return memUser;
  if (!getAuthToken()) return null;
  try {
    const raw = sessionStorage.getItem(AUTH_USER_KEY);
    memUser = raw ? (JSON.parse(raw) as AuthUser) : null;
  } catch {
    memUser = null;
  }
  return memUser;
}

export const SIGN_IN_REQUIRED = "Sign in with Google to continue";

export interface ServiceView {
  id: string;
  sellerId: string;
  name: string;
  category: "scraping" | "data" | "inference" | string;
  description: string;
  endpoint: string;
  method: "GET" | "POST";
  priceUnits: string;
  priceUsdc: string;
  network: string;
  asset: string;
  payTo: string;
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown>;
  isFixture?: boolean;
  reputation: {
    calls: number;
    paid: number;
    refused: number;
    failedNotCharged: number;
    paidOutputRejected: number;
    successRate: number;
    medianLatencyMs: number | null;
  };
  costPerSuccessUnits: string;
  registeredBy: "admin" | "public";
  createdAt: string;
  updatedAt: string;
}

export interface LedgerRow {
  id: string;
  time: string;
  updatedAt: string;
  sessionId: string;
  taskId: string;
  buyer: string;
  sellerId: string;
  serviceId: string;
  endpoint: string;
  payTo: string;
  listedUnits: string;
  askedUnits: string | null;
  paidUnits: string;
  status: "pending" | "paid" | "paid_output_rejected" | "refused" | "failed_not_charged";
  reasonCode: string;
  reason: string | null;
  txHash: string | null;
  explorerUrl: string | null;
  nonce: string | null;
  validBefore: number | null;
  httpStatus: number | null;
  latencyMs: number;
  onchainConfirmed: boolean | null;
  isSimulated?: boolean;
}

export interface SessionRecord {
  id: string;
  buyer: string;
  startBlock: string | number;
  createdAt: string;
  totals: {
    calls: number;
    paidRows?: number;
    paidUnits: string;
    paidUsdc?: string;
  };
}

export interface WalletInfo {
  address: string;
  roles: string[];
  usdc: string | null;
  eth?: string | null;
  explorerUrl: string;
}

export interface TaskSummary {
  id: string;
  sessionId: string;
  task: string;
  status: string;
  createdAt: string;
  budgetUsdc: string;
  spentUsdc: string;
}

export interface TaskDetail {
  id: string;
  sessionId: string;
  status: string;
  request: {
    task: string;
    budget: string;
    max_concurrency: number;
    on_short_budget: "partial" | "ask";
    dry_run: boolean;
  };
  understanding?: {
    summary: string;
    notes: string[];
    spec: Record<string, unknown>;
  };
  estimate?: {
    totalUnits: string;
    totalUsdc: string;
    fitsBudget: boolean;
    steps: Array<{
      id: string;
      description: string;
      calls: number;
      sellerId: string;
      serviceId: string;
      priceUnitsEach: string;
      totalUnits: string;
      totalUsdc: string;
    }>;
  };
  budget: {
    totalUnits: string;
    totalUsdc: string;
    spentUnits: string;
    spentUsdc: string;
    reservedUnits: string;
    reservedUsdc: string;
    remainingUnits: string;
    remainingUsdc: string;
  };
  steps: Array<{
    id: string;
    description: string;
    state: "pending" | "running" | "succeeded" | "failed" | "blocked";
    sellerId?: string;
    paidUnits?: string;
    paidUsdc?: string;
    txHash?: string;
    error?: string;
  }>;
  createdAt?: string;
  parsedBy?: string;
  error?: string | null;
  shortfall?: { neededUnits: string; neededUsdc: string; freeUsdc?: string } | null;
  /** The buyer's answer: usually markdown text, sometimes structured. */
  answer?: unknown;
  explanation?: {
    summary: string;
    narrative?: string;
    decisions: string[];
    purchases: Array<{
      index: number;
      stepId: string;
      sellerId: string;
      status: string;
      listedUnits: string;
      askedUnits?: string;
      paidUnits: string;
      paidUsdc: string;
      decisionReason: string;
      txHash?: string;
      explorerUrl?: string;
    }>;
  };
}

export interface ReconciliationReport {
  ok: boolean;
  /** Where the chain transfers came from: "etherscan", "rpc", or "mixed" (Etherscan + RPC for the newest blocks). */
  dataSource?: string;
  summary: string;
  diffUnits: string;
  fromBlock: string;
  toBlock: string;
  buyer: string;
  chain: {
    units: string;
    transfers: number;
  };
  ledger: {
    paidUnits: string;
    paidRows: number;
    confirmedRows: number;
    pendingRows: number;
  };
  session?: {
    rows: number;
    paidUnits: string;
  };
  issues: Array<{
    kind: string;
    detail: string;
    txHash?: string;
    explorerUrl?: string;
  }>;
}

export interface ApiResult<T> {
  data: T | null;
  error: string | null;
  isOffline?: boolean;
  /** HTTP status when the server answered. */
  status?: number;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<ApiResult<T>> {
  const url = `${BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
  try {
    // The server decides who may write (local mode, Google session, or operator key); the client never
    // pre-empts it. An explicit Authorization header (operator key) replaces the session header.
    const token = getAuthToken();
    const explicitAuth = Boolean((options.headers as Record<string, string> | undefined)?.Authorization);

    const defaultHeaders: Record<string, string> = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (token) {
      defaultHeaders["Authorization"] = `Bearer ${token}`;
    }

    const res: Response = await fetch(url, {
      ...options,
      headers: {
        ...defaultHeaders,
        ...options.headers,
      },
    });

    if (!res.ok) {
      if (res.status === 401 && token && !explicitAuth && !path.startsWith("/api/auth")) setAuthToken(null, null); // expired session
      let errorMsg = `Server error (HTTP ${res.status})`;
      try {
        const body = (await res.json()) as any;
        errorMsg = body.message || body.error || (Array.isArray(body.details) ? body.details.join(", ") : errorMsg);
      } catch {
        // fallback to status
      }
      return { data: null, error: errorMsg, isOffline: false, status: res.status };
    }

    const data = (await res.json()) as T;
    return { data, error: null, isOffline: false, status: res.status };
  } catch (err: unknown) {
    const isNetwork = err instanceof TypeError || (err as Error)?.message?.includes("fetch");
    return {
      data: null,
      error: isNetwork
        ? `Backend offline: Could not connect to API server at ${url}`
        : ((err as Error)?.message || "Unknown error"),
      isOffline: isNetwork,
    };
  }
}

// Auth API Calls
export async function loginWithGoogle(idToken: string): Promise<ApiResult<{ token: string; user: AuthUser }>> {
  const res = await request<{ ok: boolean; token: string; user: AuthUser }>("/api/auth/google", {
    method: "POST",
    body: JSON.stringify({ idToken }),
  });
  if (res.data?.token) {
    setAuthToken(res.data.token, res.data.user);
    return { data: { token: res.data.token, user: res.data.user }, error: null };
  }
  return { data: null, error: res.error || "Google authentication failed" };
}

export async function checkAuthSession(): Promise<ApiResult<{ authenticated: boolean; user?: AuthUser }>> {
  return request<{ authenticated: boolean; user?: AuthUser }>("/api/auth/session");
}

export async function logoutUser(): Promise<void> {
  if (getAuthToken()) await request("/api/auth/logout", { method: "POST" });
  setAuthToken(null, null);
}

// 1. Metadata
// Registry meta (chain, asset, categories) merged with the buyer's meta (buyer address, examples).
export async function getMeta(): Promise<ApiResult<MetaResponse>> {
  const [reg, buyer] = await Promise.all([request<MetaResponse>("/api/meta"), request<Partial<MetaResponse>>("/api/buyer-meta")]);
  if (!reg.data) return reg;
  return { data: { ...reg.data, ...(buyer.data ?? {}), network: reg.data.network, explorer: reg.data.explorer }, error: null, isOffline: false };
}

// 2. Services / Marketplace
export interface ServicesQuery {
  category?: string;
  maxPrice?: string;
  minSuccessRate?: number;
  sort?: "score" | "price" | "latency" | "successRate" | "name";
  q?: string;
  includeFixtures?: boolean;
}

export async function getServices(q: ServicesQuery = {}): Promise<ApiResult<{ count: number; services: ServiceView[] }>> {
  const params = new URLSearchParams();
  if (q.category) params.set("category", q.category);
  if (q.maxPrice) params.set("maxPrice", q.maxPrice);
  if (q.minSuccessRate !== undefined) params.set("minSuccessRate", String(q.minSuccessRate));
  if (q.sort) params.set("sort", q.sort);
  if (q.q) params.set("q", q.q);
  if (q.includeFixtures) params.set("includeFixtures", "true");

  const queryStr = params.toString() ? `?${params.toString()}` : "";
  const res = await request<{ count: number; services: any[] }>(`/api/services${queryStr}`);
  if (!res.data) return res as ApiResult<{ count: number; services: ServiceView[] }>;
  return { ...res, data: { ...res.data, services: res.data.services.map(toServiceView) } };
}

function toServiceView(s: any): ServiceView {
  const r = s?.reputation ?? {};
  return {
    ...s,
    reputation: {
      calls: r.calls ?? 0,
      paid: r.paid ?? r.successes ?? 0,
      refused: r.refused ?? 0,
      failedNotCharged: r.failedNotCharged ?? 0,
      paidOutputRejected: r.paidOutputRejected ?? 0,
      successRate: typeof r.successRate === "number" ? r.successRate : 0,
      medianLatencyMs: r.medianLatencyMs ?? null,
    },
  };
}

export async function getService(id: string): Promise<ApiResult<ServiceView>> {
  return request<ServiceView>(`/api/services/${encodeURIComponent(id)}`);
}

export async function registerService(listing: Record<string, unknown>, token?: string): Promise<ApiResult<ServiceView>> {
  const headers: Record<string, string> = {};
  if (token) headers["Authorization"] = `Bearer ${token}`;
  return request<ServiceView>("/api/services", {
    method: "POST",
    headers,
    body: JSON.stringify(listing),
  });
}

// Seller registration with wallet proof: ask the server for a one-time message, sign it with the payTo wallet,
// then submit { listing, message, signature }.
export async function requestWalletChallenge(serviceId: string, payTo: string): Promise<ApiResult<{ message: string; expiresAt: string }>> {
  return request<{ message: string; expiresAt: string }>("/api/auth/wallet-challenge", {
    method: "POST",
    body: JSON.stringify({ serviceId, payTo }),
  });
}

export async function registerWalletProofService(
  listing: Record<string, unknown>,
  proof: { message: string; signature: string }
): Promise<ApiResult<{ ok: boolean; service: Record<string, unknown>; walletProof: { verified: boolean; address: string; timestamp: number } }>> {
  return request<{ ok: boolean; service: Record<string, unknown>; walletProof: { verified: boolean; address: string; timestamp: number } }>("/api/sellers/register", {
    method: "POST",
    body: JSON.stringify({ listing, message: proof.message, signature: proof.signature }),
  });
}

// 3. Ledger & Transactions
export interface LedgerQuery {
  sessionId?: string;
  status?: string;
  service?: string;
  limit?: number;
}

export async function getLedger(q: LedgerQuery = {}): Promise<ApiResult<{ count: number; rows: LedgerRow[] }>> {
  const params = new URLSearchParams();
  if (q.sessionId) params.set("sessionId", q.sessionId);
  if (q.status) params.set("status", q.status);
  if (q.service) params.set("service", q.service);
  if (q.limit) params.set("limit", String(q.limit));
  else params.set("limit", "1000");

  return request<{ count: number; rows: LedgerRow[] }>(`/api/ledger?${params.toString()}`);
}

export async function getSessions(): Promise<ApiResult<{ count: number; sessions: SessionRecord[] }>> {
  const res = await request<{ count?: number; sessions: any[] }>("/api/sessions");
  if (!res.data) return res as ApiResult<{ count: number; sessions: SessionRecord[] }>;
  const sessions: SessionRecord[] = res.data.sessions.map((s) => ({
    ...s,
    totals: { calls: s.totals?.calls ?? 0, paidRows: s.totals?.paidRows ?? s.totals?.byStatus?.paid ?? 0, paidUnits: String(s.totals?.paidUnits ?? "0"), paidUsdc: s.totals?.paidUsdc },
  }));
  return { ...res, data: { count: res.data.count ?? sessions.length, sessions } };
}

export async function reconcileSession(sessionId: string): Promise<ApiResult<ReconciliationReport>> {
  return request<ReconciliationReport>(`/api/ledger/reconcile?sessionId=${encodeURIComponent(sessionId)}`);
}

export async function getWallets(): Promise<ApiResult<{ wallets: WalletInfo[] }>> {
  return request<{ wallets: WalletInfo[] }>("/api/wallets");
}

export interface WalletTransfer {
  txHash: string;
  explorerUrl: string;
  blockNumber: number;
  time: string;
  direction: "in" | "out" | "self";
  counterparty: string;
  units: string;
  usdc: string;
}

/** Recent USDC transfers of a known wallet (read server-side from Etherscan; the key never reaches the browser). */
export async function getWalletTransfers(address: string, limit = 25): Promise<ApiResult<{ address: string; transfers: WalletTransfer[] }>> {
  return request<{ address: string; transfers: WalletTransfer[] }>(`/api/wallets/${encodeURIComponent(address)}/transfers?limit=${limit}`);
}

// 4. Tasks (Buyer Agent)
export interface CreateTaskPayload {
  task: string;
  budget: string;
  max_concurrency?: number;
  on_short_budget?: "partial" | "ask";
  dry_run?: boolean;
  prefer_sellers?: string[];
  only_sellers?: string[];
}

/** How this browser may run Scout, as seen by the buyer for THIS request. */
export interface AuthMode {
  local: boolean;
  google: boolean;
  token: boolean;
  dailyCapUsdc: string | null;
  walletBalanceUsdc: string | null;
  maxBudgetUsdc: string;
}

export async function getAuthMode(): Promise<ApiResult<AuthMode>> {
  return request<AuthMode>("/api/auth/mode");
}

/** Buyer POSTs: with an operator key (held only in React state by the caller) it is sent as the bearer token. */
export interface BuyerAuth {
  operatorKey?: string | null;
}
const buyerHeaders = (auth?: BuyerAuth): Record<string, string> => (auth?.operatorKey ? { Authorization: `Bearer ${auth.operatorKey}` } : {});

export async function createTask(payload: CreateTaskPayload, auth?: BuyerAuth): Promise<ApiResult<{ taskId: string; sessionId: string; status: string; events: string }>> {
  return request<{ taskId: string; sessionId: string; status: string; events: string }>("/api/tasks", {
    method: "POST",
    headers: buyerHeaders(auth),
    body: JSON.stringify(payload),
  });
}

export async function getTasks(): Promise<ApiResult<{ tasks: TaskSummary[] }>> {
  const res = await request<{ tasks: any[] }>("/api/tasks");
  if (!res.data) return res as ApiResult<{ tasks: TaskSummary[] }>;
  const tasks: TaskSummary[] = res.data.tasks.map((t) => ({
    id: t.id,
    sessionId: t.sessionId ?? `ses_${String(t.id).replace(/^task_/, "")}`,
    task: t.task,
    status: t.status,
    createdAt: t.createdAt,
    budgetUsdc: t.budgetUsdc ?? t.budget ?? "0",
    spentUsdc: t.spentUsdc ?? "0",
  }));
  return { ...res, data: { tasks } };
}

const taskResult = (res: ApiResult<any>): ApiResult<TaskDetail> => (res.data ? { ...res, data: toTaskDetail(res.data) } : res);

export async function getTask(id: string): Promise<ApiResult<TaskDetail>> {
  return taskResult(await request(`/api/tasks/${encodeURIComponent(id)}`));
}

export async function topUpTask(id: string, amount: string, auth?: BuyerAuth): Promise<ApiResult<TaskDetail>> {
  return taskResult(await request(`/api/tasks/${encodeURIComponent(id)}/topup`, { method: "POST", headers: buyerHeaders(auth), body: JSON.stringify({ amount }) }));
}

export async function startTask(id: string, auth?: BuyerAuth): Promise<ApiResult<TaskDetail>> {
  return taskResult(await request(`/api/tasks/${encodeURIComponent(id)}/start`, { method: "POST", headers: buyerHeaders(auth) }));
}

export async function cancelTask(id: string, auth?: BuyerAuth): Promise<ApiResult<TaskDetail>> {
  return taskResult(await request(`/api/tasks/${encodeURIComponent(id)}/cancel`, { method: "POST", headers: buyerHeaders(auth) }));
}

const usdc = (units: unknown) => {
  try {
    const n = BigInt(String(units ?? "0"));
    const neg = n < 0n ? "-" : "";
    const a = n < 0n ? -n : n;
    return `${neg}${a / 1_000_000n}.${(a % 1_000_000n).toString().padStart(6, "0")}`;
  } catch {
    return "0.000000";
  }
};
const unitsOf = (v: unknown) => {
  const m = /^(\d+)(?:\.(\d{0,6}))?/.exec(String(v ?? "0"));
  return m ? (BigInt(m[1]!) * 1_000_000n + BigInt((m[2] ?? "").padEnd(6, "0") || "0")).toString() : "0";
};

/** Buyer task view -> the shape the console renders. Unknown fields pass through untouched. */
function toTaskDetail(v: any): TaskDetail {
  if (!v || typeof v !== "object") return v;
  const b = v.budget ?? {};
  const totalUnits = b.totalUnits ?? unitsOf(b.totalUsdc);
  const spentUnits = b.spentUnits ?? unitsOf(b.spentUsdc);
  const reservedUnits = b.reservedUnits ?? unitsOf(b.reservedUsdc);
  const remainingUnits = b.remainingUnits ?? unitsOf(b.remainingUsdc);
  const est = v.estimate;
  const exp = v.explanation;
  return {
    ...v,
    understanding: v.understanding ?? (v.understood || v.notes?.length ? { summary: v.understood ?? "", notes: v.notes ?? [], spec: v.spec ?? {} } : undefined),
    estimate:
      est && !est.steps
        ? {
            totalUnits: est.totalUnits,
            totalUsdc: `${est.lowerBound ? "≥ " : ""}${est.totalUsdc}`,
            fitsBudget: !(Array.isArray(est.impossible) ? est.impossible.length : est.impossible) && BigInt(est.totalUnits ?? "0") <= BigInt(totalUnits || "0"),
            steps: (est.lines ?? []).map((l: any, i: number) => ({
              id: `${i}`,
              description: l.note ? `${l.what} (${l.note})` : l.what,
              calls: l.calls,
              sellerId: l.serviceId ?? "—",
              serviceId: l.serviceId ?? "",
              priceUnitsEach: l.unitUnits ?? "0",
              totalUnits: l.subtotalUnits ?? "0",
              totalUsdc: l.subtotalUnits ? usdc(l.subtotalUnits) : "—",
            })),
          }
        : est,
    budget: {
      totalUnits,
      spentUnits,
      reservedUnits,
      remainingUnits,
      totalUsdc: b.totalUsdc ?? usdc(totalUnits),
      spentUsdc: b.spentUsdc ?? usdc(spentUnits),
      reservedUsdc: b.reservedUsdc ?? usdc(reservedUnits),
      remainingUsdc: b.remainingUsdc ?? usdc(remainingUnits),
    },
    steps: (v.steps ?? []).map((st: any) => ({
      ...st,
      id: st.id ?? st.key,
      description: st.description ?? st.label ?? st.key,
      state: st.state === "done" ? "succeeded" : st.state,
      sellerId: st.sellerId ?? st.servedBy ?? undefined,
      error: st.error ?? undefined,
    })),
    explanation: exp
      ? {
          ...exp,
          narrative: exp.narrative ?? v.narrative ?? undefined,
          decisions: exp.decisions ?? [],
          purchases: (exp.purchases ?? []).map((p: any, i: number) => ({
            ...p,
            index: p.index ?? p.n ?? i + 1,
            stepId: p.stepId ?? p.step ?? "",
            sellerId: p.sellerId ?? p.serviceId ?? "",
            listedUnits: p.listedUnits ?? unitsOf(p.listedUsdc),
            paidUnits: p.paidUnits ?? "0",
            paidUsdc: p.paidUsdc ?? usdc(p.paidUnits),
            decisionReason: p.decisionReason ?? [p.why, p.outcome].filter(Boolean).join(" · "),
            txHash: p.txHash ?? undefined,
            explorerUrl: p.explorerUrl ?? undefined,
          })),
        }
      : undefined,
    answer: v.answer ?? undefined,
  };
}

// 5. Server-Sent Events (SSE) Stream Helpers
export function createLedgerStream(): EventSource {
  const url = `${BASE_URL}/api/ledger/stream`;
  return new EventSource(url);
}

export function createTaskEventsStream(taskId: string): EventSource {
  const url = `${BASE_URL}/api/tasks/${encodeURIComponent(taskId)}/events`;
  return new EventSource(url);
}

// 6. User Registration & Admin Audit Reports
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

export interface RegisterUserPayload {
  name: string;
  role: "buyer" | "seller" | "user";
  network?: string;
  wallet: string;
  email?: string;
  category?: string;
  serviceId?: string;
}

export async function registerUser(payload: RegisterUserPayload): Promise<ApiResult<{ ok: boolean; user: RegisteredUser }>> {
  return request<{ ok: boolean; user: RegisteredUser }>("/api/users/register", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export async function getRegisteredUsers(): Promise<ApiResult<{ count: number; users: RegisteredUser[] }>> {
  return request<{ count: number; users: RegisteredUser[] }>("/api/users");
}

export async function adminLogin(tokenOrPassword: string): Promise<ApiResult<{ ok: boolean; token: string; isAdmin: boolean }>> {
  return request<{ ok: boolean; token: string; isAdmin: boolean }>("/api/admin/login", {
    method: "POST",
    body: JSON.stringify({ token: tokenOrPassword, password: tokenOrPassword }),
  });
}

export async function getAdminAuditReport(): Promise<ApiResult<AdminAuditReport>> {
  return request<AdminAuditReport>("/api/admin/audit-report");
}

