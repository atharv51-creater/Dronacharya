import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  Play,
  Calculator,
  AlertCircle,
  CheckCircle2,
  Circle,
  Loader2,
  XCircle,
  PauseCircle,
  Sparkles,
  ExternalLink,
  Bot,
  History,
  Wallet,
  LogIn,
  RefreshCw,
  ChevronRight,
  ListChecks,
  Activity,
  FileText,
  ShieldCheck,
  KeyRound,
  Zap,
} from "lucide-react";
import {
  AUTH_EVENT,
  createTask,
  topUpTask,
  startTask,
  cancelTask,
  createTaskEventsStream,
  getAuthMode,
  getAuthUser,
  getTask,
  getTasks,
  getWallets,
  type AuthMode,
  type AuthUser,
  type BuyerAuth,
  type CreateTaskPayload,
  type TaskDetail,
  type TaskSummary,
} from "../api/client.ts";
import { Markdown } from "./Markdown.tsx";
import { USDC_TYPING, fromUnits, toUnits } from "../lib/usdc.ts";

interface ConsoleViewProps {
  explorerUrl?: string;
  examples?: Array<{ title: string; task: string; budget: string; expectedUsdc?: string }>;
  onViewLedger?: () => void;
  /** Every live log line of the task being watched (the Agent Arena shows them). */
  onActivity?: (line: ActivityLine) => void;
}

export type LogLine = { key: string; time: string; text: string; kind: "info" | "ok" | "warn" | "bad"; href?: string };
export type ActivityLine = LogLine & { taskId: string };

const BUDGET_CHIPS = ["0.010", "0.025", "0.050", "0.100"];
const TERMINAL = new Set(["completed", "partial", "failed", "cancelled", "interrupted"]);
const RECONNECT_MS = [1000, 2000, 5000];
const TYPING_HINT = "Only digits and one decimal point, up to 6 decimals";

/** Validates a USDC amount exactly (bigint units via the shared toUnits); returns the reason when invalid. */
function checkAmount(raw: string, o: { what: string; maxUnits: bigint | null; walletUnits?: bigint | null; optional?: boolean }): { units: bigint | null; error: string | null } {
  const v = raw.trim();
  if (!v) return o.optional ? { units: null, error: null } : { units: null, error: `Enter ${o.what}` };
  let units: bigint;
  try {
    units = toUnits(v);
  } catch {
    return { units: null, error: "Enter an amount like 0.050 (up to 6 decimals)" };
  }
  if (units <= 0n) return { units, error: "Must be more than 0" };
  if (o.maxUnits !== null && units > o.maxUnits) return { units, error: `At most ${fromUnits(o.maxUnits < 0n ? 0n : o.maxUnits)} USDC (the buyer's per-task limit)` };
  if (o.walletUnits != null && units > o.walletUnits) return { units, error: `The buyer wallet holds only ${fromUnits(o.walletUnits)} USDC` };
  return { units, error: null };
}

const unitsOrNull = (usdc: string | null | undefined) => {
  try {
    return usdc ? toUnits(usdc) : null;
  } catch {
    return null;
  }
};

const DEFAULT_EXAMPLES = [
  {
    title: "Cheapest 5-star books in rupees, with Hindi summaries",
    task: "From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books, give their prices in rupees, and summarise each description in Hindi.",
    budget: "0.050",
  },
];

const EVENT_TYPES = [
  "task_created", "parsed", "estimate", "status", "wallet", "budget", "step_running", "call_started", "call_finished", "fallback",
  "waiting_for_budget", "step_done", "step_blocked", "step_failed", "progress", "needs_budget", "answer", "settled",
  "narrative", "topped_up", "error",
];

const ACTIVE = new Set(["parsing", "planning", "running"]);
const usdc = (units?: string | null) => (units ? (Number(units) / 1e6).toFixed(4) : "0.0000");

/** One readable log line per buyer event (null = not worth a line). */
function describe(type: string, p: any): Omit<LogLine, "key" | "time"> | null {
  switch (type) {
    case "task_created":
      return { text: `Task received · budget ${p.budget} USDC`, kind: "info" };
    case "parsed":
      return { text: `Understood (${p.parsedBy ?? "rules"}): ${p.summary ?? "task parsed"}`, kind: "info" };
    case "estimate": {
      const e = p.estimate ?? p;
      const missing: string[] = Array.isArray(e.impossible) ? e.impossible : [];
      return { text: `Plan priced: ${e.lowerBound ? "at least " : ""}${e.totalUsdc} USDC across ${e.lines?.length ?? 0} purchases${missing.length ? ` · no seller for: ${missing.join(", ")}` : ""}`, kind: missing.length ? "warn" : "info" };
    }
    case "wallet":
      return { text: `Buyer wallet holds ${p.balanceUsdc} USDC`, kind: Number(p.balanceUnits) > 0 ? "info" : "warn" };
    case "status":
      return { text: `Status → ${p.status}`, kind: p.status === "completed" ? "ok" : p.status === "failed" ? "bad" : p.status === "partial" ? "warn" : "info" };
    case "call_started":
      return { text: `Buying "${p.label ?? p.step}" from ${p.serviceId}${p.why ? ` — ${p.why}` : ""}`, kind: "info" };
    case "call_finished": {
      const a = p.attempt ?? {};
      const paid = a.status === "paid";
      return {
        href: a.txHash ? a.explorerUrl ?? undefined : undefined,
        text: `${a.serviceId ?? "seller"} → ${a.status ?? "done"}${a.paidUnits && a.paidUnits !== "0" ? ` · paid ${usdc(a.paidUnits)} USDC` : ""}${a.latencyMs !== undefined ? ` · ${a.latencyMs} ms` : ""}${a.reason ? ` · ${a.reason}` : ""}`,
        kind: paid ? "ok" : a.status === "refused" || a.status === "failed_not_charged" ? "warn" : "bad",
      };
    }
    case "fallback":
      return { text: `Fallback on "${p.label ?? p.step}": ${p.from} → ${p.next ?? "no other seller"} (${p.reason})`, kind: "warn" };
    case "step_done":
      return { text: `✓ ${p.label ?? p.step} (via ${p.serviceId})`, kind: "ok" };
    case "step_blocked":
      return { text: `Step "${p.label ?? p.step}" paused: needs ${usdc(p.neededUnits)} USDC more (${p.reason})`, kind: "warn" };
    case "step_failed":
      return { text: `Step "${p.label ?? p.step}" failed: ${p.reason}`, kind: "bad" };
    case "waiting_for_budget":
      return { text: `"${p.label ?? p.step}" waits for budget held by in-flight payments (${usdc(p.heldUnits)} USDC held)`, kind: "warn" };
    case "progress":
      return { text: p.message, kind: "info" };
    case "needs_budget":
      return { text: `Budget short by ${p.shortfall?.neededUsdc ?? "?"} USDC — top up to continue`, kind: "warn" };
    case "topped_up":
      return { text: `Budget topped up by ${p.amountUsdc} USDC`, kind: "ok" };
    case "answer":
      return { text: "Answer assembled", kind: "ok" };
    case "settled":
      return { text: "All payments settled and recorded in the ledger", kind: "ok" };
    case "narrative":
      return { text: "Narrative written", kind: "info" };
    case "error":
      return { text: `Error: ${p.message ?? p.error}`, kind: "bad" };
    default:
      return null; // budget ticks etc. are shown by the meter
  }
}

const statusStyle = (s: string) =>
  s === "completed"
    ? "bg-emerald-500/15 border-emerald-500/30 text-emerald-300"
    : s === "partial" || s === "needs_budget" || s === "interrupted"
    ? "bg-amber-500/15 border-amber-500/30 text-amber-300"
    : s === "failed" || s === "cancelled"
    ? "bg-rose-500/15 border-rose-500/30 text-rose-300"
    : "bg-purple-500/15 border-purple-500/30 text-purple-300";

const StepIcon: React.FC<{ state: string }> = ({ state }) =>
  state === "succeeded" ? (
    <CheckCircle2 className="h-4 w-4 text-emerald-400 shrink-0" />
  ) : state === "running" ? (
    <Loader2 className="h-4 w-4 text-purple-400 animate-spin shrink-0" />
  ) : state === "failed" ? (
    <XCircle className="h-4 w-4 text-rose-400 shrink-0" />
  ) : state === "blocked" ? (
    <PauseCircle className="h-4 w-4 text-amber-400 shrink-0" />
  ) : (
    <Circle className="h-4 w-4 text-slate-600 shrink-0" />
  );

const Card: React.FC<{ title: string; icon: React.ReactNode; right?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, icon, right, children, className }) => (
  <section className={`rounded-2xl border border-[#222b3d] bg-[#121624] ${className ?? ""}`}>
    <header className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-[#1e2538]">
      <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-slate-300">
        {icon}
        <span>{title}</span>
      </h2>
      {right}
    </header>
    <div className="p-5">{children}</div>
  </section>
);

export const ConsoleView: React.FC<ConsoleViewProps> = ({ explorerUrl = "https://sepolia.basescan.org", examples, onViewLedger, onActivity }) => {
  const presets = examples?.length ? examples : DEFAULT_EXAMPLES;
  const [taskText, setTaskText] = useState(presets[0]?.task || "");
  const [budget, setBudget] = useState(presets[0]?.budget || "0.050");
  const [budgetKeyHint, setBudgetKeyHint] = useState<string | null>(null);
  const [autoTopUp, setAutoTopUp] = useState("");
  const [autoKeyHint, setAutoKeyHint] = useState<string | null>(null);
  const [concurrency, setConcurrency] = useState(3);
  const [shortBudgetMode, setShortBudgetMode] = useState<"partial" | "ask">("partial");
  const [preferSellers, setPreferSellers] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(getAuthUser());
  const [mode, setMode] = useState<AuthMode | null>(null);
  const [modeError, setModeError] = useState<string | null>(null);
  // The operator key lives only in this component's state: never stored, never logged, gone on reload.
  const [operatorKey, setOperatorKey] = useState("");
  const [keyError, setKeyError] = useState<string | null>(null);
  const [walletFromList, setWalletFromList] = useState<string | null>(null);
  const [recent, setRecent] = useState<TaskSummary[]>([]);

  const [currentTaskId, setCurrentTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<TaskDetail | null>(null);
  const [liveLogs, setLiveLogs] = useState<LogLine[]>([]);
  const [waiting, setWaiting] = useState(false);
  const [topUpAmount, setTopUpAmount] = useState("0.020");
  const [topUpKeyHint, setTopUpKeyHint] = useState<string | null>(null);
  const [isActing, setIsActing] = useState(false);

  const streamRef = useRef<{ taskId: string; es: EventSource | null; attempts: number; timer: number | null; poll: number | null; seen: Set<string> } | null>(null);
  const logContainerRef = useRef<HTMLDivElement | null>(null);
  const refreshTimer = useRef<number | null>(null);
  const onActivityRef = useRef(onActivity);
  onActivityRef.current = onActivity;
  // Per task: the "auto top-up up to" allowance chosen when it was created, and what has been used.
  const autoPlans = useRef(new Map<string, { capUnits: bigint; usedUnits: bigint; handledTotal: string | null }>());
  const autoBusy = useRef(false);

  const keySet = Boolean(mode?.token) && operatorKey.length > 0;
  const auth: BuyerAuth = keySet ? { operatorKey } : {};
  const authRef = useRef(auth);
  authRef.current = auth;
  const canRun = Boolean(mode?.local || user?.canRunScout || keySet);

  const maxUnits = unitsOrNull(mode?.maxBudgetUsdc);
  const walletUsdc = mode?.walletBalanceUsdc ?? walletFromList;
  const walletUnits = unitsOrNull(walletUsdc);
  const budgetCheck = checkAmount(budget, { what: "a budget", maxUnits, walletUnits });
  const autoCheck = checkAmount(autoTopUp, { what: "an amount", maxUnits, optional: true });
  const formValid = taskText.trim().length > 0 && !budgetCheck.error && !autoCheck.error;

  useEffect(() => {
    const onAuth = (e: Event) => setUser((e as CustomEvent<AuthUser | null>).detail ?? null);
    window.addEventListener(AUTH_EVENT, onAuth);
    return () => window.removeEventListener(AUTH_EVENT, onAuth);
  }, []);

  const loadMode = useCallback(async () => {
    const res = await getAuthMode();
    if (res.data) {
      setMode(res.data);
      setModeError(null);
    } else setModeError(res.error);
  }, []);

  const loadRecent = useCallback(async () => {
    const res = await getTasks();
    if (res.data) setRecent(res.data.tasks.slice(0, 8));
  }, []);

  const loadWallet = useCallback(async () => {
    const res = await getWallets();
    const buyer = res.data?.wallets.find((w) => w.roles.includes("buyer"));
    setWalletFromList(buyer?.usdc ?? null);
  }, []);

  const stopStream = useCallback(() => {
    const st = streamRef.current;
    if (!st) return;
    st.es?.close();
    if (st.timer) window.clearTimeout(st.timer);
    if (st.poll) window.clearInterval(st.poll);
    streamRef.current = null;
  }, []);

  useEffect(() => {
    void loadMode();
    void loadRecent();
    void loadWallet();
    return () => {
      stopStream();
      if (refreshTimer.current) window.clearTimeout(refreshTimer.current);
    };
  }, [loadMode, loadRecent, loadWallet, stopStream]);

  useEffect(() => {
    if (logContainerRef.current) logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
  }, [liveLogs]);

  const addLog = useCallback((taskId: string, line: Omit<LogLine, "key" | "time"> & { time?: string }, key?: string) => {
    const full: LogLine = { ...line, time: line.time ?? new Date().toLocaleTimeString(), key: key ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 7)}` };
    setLiveLogs((prev) => [...prev, full]);
    onActivityRef.current?.({ ...full, taskId });
  }, []);

  const fetchTaskDetail = useCallback(async (id: string) => {
    const res = await getTask(id);
    if (!res.data) return;
    setTaskDetail(res.data);
    const st = streamRef.current;
    // Polling fallback ends once the task is finished and its audit trail is written.
    if (st?.poll && st.taskId === id && TERMINAL.has(res.data.status) && res.data.explanation) {
      window.clearInterval(st.poll);
      st.poll = null;
    }
  }, []);

  // Many events arrive in bursts: refresh the detail at most every 400 ms.
  const scheduleRefresh = useCallback(
    (id: string) => {
      if (refreshTimer.current) return;
      refreshTimer.current = window.setTimeout(() => {
        refreshTimer.current = null;
        void fetchTaskDetail(id);
      }, 400);
    },
    [fetchTaskDetail],
  );

  const connect = useCallback(
    (taskId: string) => {
      const st = streamRef.current;
      if (!st || st.taskId !== taskId) return;
      const es = createTaskEventsStream(taskId); // replays history; duplicates are skipped by event id
      st.es = es;
      es.onopen = () => {
        st.attempts = 0;
      };
      for (const type of EVENT_TYPES) {
        es.addEventListener(type, ((m: MessageEvent) => {
          if (m.lastEventId) {
            if (st.seen.has(m.lastEventId)) return;
            st.seen.add(m.lastEventId);
          }
          let payload: any = {};
          try {
            payload = JSON.parse(m.data);
          } catch {
            return;
          }
          if (type === "waiting_for_budget") setWaiting(true);
          if (type === "call_started" || type === "step_done" || (type === "status" && payload.status !== "running")) setWaiting(false);
          const line = describe(type, payload);
          if (line) addLog(taskId, { ...line, time: new Date(payload.at ?? Date.now()).toLocaleTimeString() }, `${m.lastEventId || Date.now()}-${type}`);
          scheduleRefresh(taskId);
          if (type === "settled" || (type === "status" && !ACTIVE.has(payload.status))) {
            void loadRecent();
            void loadMode();
          }
        }) as EventListener);
      }
      es.onerror = () => {
        if (streamRef.current !== st) return;
        es.close();
        st.es = null;
        if (st.attempts < RECONNECT_MS.length) {
          const delay = RECONNECT_MS[st.attempts++]!;
          addLog(taskId, { text: `Live stream dropped; reconnecting in ${delay / 1000} s`, kind: "warn" });
          st.timer = window.setTimeout(() => connect(taskId), delay);
        } else {
          addLog(taskId, { text: "Live stream unavailable; checking the task every 2 s instead", kind: "warn" });
          st.poll = window.setInterval(() => void fetchTaskDetail(taskId), 2000);
        }
      };
    },
    [addLog, scheduleRefresh, fetchTaskDetail, loadRecent, loadMode],
  );

  const openTask = useCallback(
    (taskId: string) => {
      stopStream();
      setCurrentTaskId(taskId);
      setLiveLogs([]);
      setWaiting(false);
      setErrorMsg(null);
      setTaskDetail(null);
      void fetchTaskDetail(taskId);
      streamRef.current = { taskId, es: null, attempts: 0, timer: null, poll: null, seen: new Set() };
      connect(taskId);
    },
    [stopStream, fetchTaskDetail, connect],
  );

  /** A 401 while an operator key is in use means the key is wrong: forget it. */
  const handleAuthFailure = (status?: number) => {
    if (status === 401 && authRef.current.operatorKey) {
      setOperatorKey("");
      setKeyError("Operator key rejected");
      return true;
    }
    return false;
  };

  const submitTask = async (dryRun: boolean) => {
    setErrorMsg(null);
    if (!canRun || !formValid || budgetCheck.units === null) return;
    setIsSubmitting(true);
    const prefer = preferSellers.split(",").map((x) => x.trim()).filter(Boolean);
    const payload: CreateTaskPayload = {
      task: taskText.trim(),
      budget: fromUnits(budgetCheck.units),
      max_concurrency: concurrency,
      on_short_budget: shortBudgetMode,
      dry_run: dryRun,
      ...(prefer.length ? { prefer_sellers: prefer } : {}),
    };
    const res = await createTask(payload, auth);
    setIsSubmitting(false);
    if (res.error || !res.data) {
      if (!handleAuthFailure(res.status)) setErrorMsg(res.error ?? "Could not create the task");
      return;
    }
    if (autoCheck.units) autoPlans.current.set(res.data.taskId, { capUnits: autoCheck.units, usedUnits: 0n, handledTotal: null });
    openTask(res.data.taskId);
    void loadRecent();
  };

  const act = async (fn: () => Promise<{ data: TaskDetail | null; error: string | null; status?: number }>) => {
    setIsActing(true);
    setErrorMsg(null);
    const res = await fn();
    setIsActing(false);
    if (res.error && !handleAuthFailure(res.status)) setErrorMsg(res.error);
    if (res.data) setTaskDetail(res.data);
    if (currentTaskId) scheduleRefresh(currentTaskId);
  };

  const d = taskDetail;
  const runningStepsCount = d?.steps.filter((s) => s.state === "running").length ?? 0;
  const maxParallel = d?.request?.max_concurrency ?? concurrency;
  const taskTotal = d ? BigInt(d.budget.totalUnits || "0") : 0n;
  const topUpRoom = maxUnits !== null ? maxUnits - taskTotal : null;
  const topUpCheck = checkAmount(topUpAmount, { what: "an amount", maxUnits: topUpRoom });

  // needs_budget: suggest the shortfall, and send the automatic top-up when one was allowed for this task.
  useEffect(() => {
    if (!d || d.status !== "needs_budget") return;
    const needed = d.shortfall?.neededUnits ? BigInt(d.shortfall.neededUnits) : 0n;
    const plan = autoPlans.current.get(d.id);
    if (!plan) {
      if (needed > 0n) setTopUpAmount(fromUnits(needed));
      return;
    }
    if (autoBusy.current || plan.handledTotal === d.budget.totalUnits) return;
    plan.handledTotal = d.budget.totalUnits; // one automatic top-up per shortfall
    const left = plan.capUnits - plan.usedUnits;
    const room = maxUnits !== null ? maxUnits - BigInt(d.budget.totalUnits) : left;
    let amount = needed > 0n ? needed : left;
    if (amount > left) amount = left;
    if (amount > room) amount = room;
    if (amount <= 0n) {
      addLog(d.id, { text: "Auto top-up allowance used up: add budget below to continue", kind: "warn" });
      if (needed > 0n) setTopUpAmount(fromUnits(needed));
      return;
    }
    autoBusy.current = true;
    plan.usedUnits += amount;
    addLog(d.id, { text: `Auto top-up: +${fromUnits(amount)} USDC (${fromUnits(plan.usedUnits)} of ${fromUnits(plan.capUnits)} allowed)`, kind: "ok" });
    void topUpTask(d.id, fromUnits(amount), authRef.current).then((res) => {
      autoBusy.current = false;
      if (res.error) {
        plan.usedUnits -= amount;
        if (!handleAuthFailure(res.status)) addLog(d.id, { text: `Auto top-up refused: ${res.error}`, kind: "bad" });
      } else if (res.data) setTaskDetail(res.data);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d?.id, d?.status, d?.budget.totalUnits]);

  const typedAmount = (set: (v: string) => void, hint: (h: string | null) => void) => (e: React.ChangeEvent<HTMLInputElement>) => {
    const v = e.target.value;
    if (USDC_TYPING.test(v)) {
      set(v);
      hint(null);
    } else hint(TYPING_HINT);
  };

  const total = Number(d?.budget.totalUnits || 0) || 1;
  const spentPct = d ? Math.min(100, (Number(d.budget.spentUnits) / total) * 100) : 0;
  const reservedPct = d ? Math.min(100 - spentPct, (Number(d.budget.reservedUnits) / total) * 100) : 0;
  const walletEmpty = walletUnits !== null && walletUnits === 0n;
  const chips = BUDGET_CHIPS.filter((c) => maxUnits === null || toUnits(c) <= maxUnits);

  return (
    <div className="space-y-6 pb-16 max-w-6xl mx-auto">
      {/* Title */}
      <div className="flex flex-col sm:flex-row sm:items-end justify-between gap-4 pb-4 border-b border-[#1e2538]">
        <div>
          <h1 className="text-2xl font-extrabold text-white tracking-tight flex items-center gap-2.5">
            <Bot className="h-6 w-6 text-purple-400" />
            Scout Buyer Console
          </h1>
          <p className="text-sm text-slate-400 mt-1">Describe a job in plain English. Scout plans it, hires sellers, and pays each call in USDC over x402.</p>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="px-2.5 py-1 rounded-lg bg-[#141926] border border-[#232c40] text-slate-300 font-mono">Base Sepolia · 84532</span>
          <span
            className={`px-2.5 py-1 rounded-lg border font-mono flex items-center gap-1.5 ${walletEmpty ? "bg-amber-500/10 border-amber-500/30 text-amber-300" : "bg-[#141926] border-[#232c40] text-slate-300"}`}
            title="Scout's buyer wallet balance"
          >
            <Wallet className="h-3.5 w-3.5" />
            {walletUsdc === null ? "—" : `${walletUsdc} USDC`}
          </span>
        </div>
      </div>

      {/* How this browser may run Scout (from GET /api/auth/mode) */}
      {modeError && !mode && (
        <div className="flex items-start gap-3 p-4 rounded-2xl border border-rose-500/30 bg-rose-500/[0.07] text-sm text-rose-200">
          <AlertCircle className="h-5 w-5 mt-0.5 shrink-0" />
          <span>Could not reach the buyer agent: {modeError}</span>
        </div>
      )}
      {mode?.local ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Local mode: running against this machine&apos;s backend.
        </div>
      ) : mode && user?.canRunScout ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-emerald-500/30 bg-emerald-500/[0.07] text-xs text-emerald-200">
          <ShieldCheck className="h-4 w-4 shrink-0" />
          Signed in as {user.email}: approved to run Scout{mode.dailyCapUsdc ? ` (up to ${mode.dailyCapUsdc} USDC a day)` : ""}.
        </div>
      ) : mode && mode.google && !user ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-purple-500/30 bg-purple-500/[0.07] text-xs text-purple-100">
          <LogIn className="h-4 w-4 shrink-0" />
          Sign in with Google to run Scout.
        </div>
      ) : mode && mode.google && user && !keySet ? (
        <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] text-xs text-amber-100">
          <AlertCircle className="h-4 w-4 shrink-0" />
          Signed in as {user.email}, but this account is not approved to run Scout.
        </div>
      ) : mode && !mode.google ? (
        mode.token ? (
          <div className={`p-4 rounded-2xl border ${keySet ? "border-emerald-500/30 bg-emerald-500/[0.07]" : "border-purple-500/30 bg-purple-500/[0.07]"} space-y-2`}>
            <div className="flex items-center gap-2 text-sm font-semibold text-white">
              <KeyRound className="h-4 w-4 text-purple-300" />
              {keySet ? "Operator key set for this page (forgotten on reload)" : "Enter the operator key to run Scout"}
            </div>
            <div className="flex items-center gap-2 flex-wrap">
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                aria-label="Operator key"
                placeholder="Operator key"
                value={operatorKey}
                onChange={(e) => {
                  setOperatorKey(e.target.value.trim());
                  setKeyError(null);
                }}
                className="w-full max-w-sm rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-white border border-[#232c40] focus:border-purple-500 focus:outline-none font-mono"
              />
              {keySet && (
                <button type="button" onClick={() => setOperatorKey("")} className="text-xs text-slate-400 hover:text-white cursor-pointer">
                  Clear
                </button>
              )}
            </div>
            {keyError && <p className="text-xs text-rose-300">{keyError}</p>}
          </div>
        ) : (
          <div className="flex items-start gap-2 px-4 py-3 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] text-xs text-amber-100">
            <AlertCircle className="h-4 w-4 shrink-0 mt-0.5" />
            <span>
              Scout can&apos;t be run from this browser: the server has no Google sign-in or operator key configured. Open the UI on the backend machine
              with <code>npm run dev</code> (local mode), or set <code>BUYER_API_TOKEN</code> or <code>GOOGLE_CLIENT_ID</code>. Past tasks stay browsable.
            </span>
          </div>
        )
      ) : null}
      {canRun && walletEmpty && (
        <div className="flex items-start gap-3 p-4 rounded-2xl border border-amber-500/30 bg-amber-500/[0.07] text-sm">
          <AlertCircle className="h-5 w-5 text-amber-300 mt-0.5 shrink-0" />
          <div className="text-slate-300">
            <div className="font-semibold text-amber-200">The buyer wallet has no testnet USDC</div>
            <p className="text-xs text-slate-400 mt-0.5">
              Estimates work; paid runs stop before spending anything. Fund it at <span className="font-mono text-slate-300">faucet.circle.com</span> (Base Sepolia).
            </p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Task form */}
        <Card title="New task" icon={<Sparkles className="h-4 w-4 text-purple-400" />} className="lg:col-span-2">
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submitTask(false);
            }}
            className="space-y-4"
          >
            <div className="flex flex-wrap gap-2">
              {presets.map((ex, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => {
                    setTaskText(ex.task);
                    setBudget(ex.budget);
                    setBudgetKeyHint(null);
                  }}
                  className={`text-xs px-3 py-1.5 rounded-lg border transition-colors text-left cursor-pointer ${
                    taskText === ex.task ? "bg-purple-500/15 border-purple-500/40 text-purple-200" : "bg-[#141926] hover:bg-[#1b2232] text-slate-300 border-[#232c40]"
                  }`}
                  title={ex.task}
                >
                  {ex.title}
                </button>
              ))}
            </div>

            <textarea
              rows={3}
              required
              value={taskText}
              onChange={(e) => setTaskText(e.target.value)}
              placeholder="From pages 1 to 4 of books.toscrape.com, find the three cheapest 5-star books…"
              className="w-full rounded-xl bg-[#0a0d14] p-3 text-sm text-white placeholder-slate-500 border border-[#232c40] focus:outline-none focus:border-purple-500 focus:ring-1 focus:ring-purple-500 leading-relaxed resize-y"
            />

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="budget" className="block text-[11px] font-medium text-slate-400 mb-1">
                  Budget (USDC){maxUnits !== null && <span className="text-slate-500"> · max {fromUnits(maxUnits)} per task</span>}
                </label>
                <input
                  id="budget"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  value={budget}
                  onChange={typedAmount(setBudget, setBudgetKeyHint)}
                  aria-invalid={Boolean(budgetCheck.error)}
                  aria-describedby="budget-help"
                  className={`w-full rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-white border focus:outline-none font-mono ${budgetCheck.error ? "border-rose-500/60 focus:border-rose-400" : "border-[#232c40] focus:border-purple-500"}`}
                />
                <div className="flex flex-wrap gap-1.5 mt-1.5">
                  {chips.map((c) => (
                    <button
                      key={c}
                      type="button"
                      onClick={() => {
                        setBudget(c);
                        setBudgetKeyHint(null);
                      }}
                      className={`px-2 py-0.5 rounded-md text-[11px] font-mono border transition-colors cursor-pointer ${budget === c ? "bg-purple-500/20 border-purple-500/50 text-purple-100" : "bg-[#141926] border-[#232c40] text-slate-400 hover:text-white"}`}
                    >
                      {c}
                    </button>
                  ))}
                </div>
                <p id="budget-help" className={`text-[11px] mt-1 ${budgetKeyHint || budgetCheck.error ? "text-rose-300" : "text-slate-500"}`}>
                  {budgetKeyHint ?? budgetCheck.error ?? (walletUsdc !== null ? `Wallet holds ${walletUsdc} USDC` : "\u00a0")}
                </p>
              </div>
              <div>
                <label htmlFor="autotopup" className="block text-[11px] font-medium text-slate-400 mb-1">
                  Auto top-up up to (USDC, optional)
                </label>
                <input
                  id="autotopup"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="e.g. 0.020"
                  value={autoTopUp}
                  onChange={typedAmount(setAutoTopUp, setAutoKeyHint)}
                  aria-invalid={Boolean(autoCheck.error)}
                  className={`w-full rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-white border focus:outline-none font-mono ${autoCheck.error ? "border-rose-500/60 focus:border-rose-400" : "border-[#232c40] focus:border-purple-500"}`}
                />
                <p className={`text-[11px] mt-1 ${autoKeyHint || autoCheck.error ? "text-rose-300" : "text-slate-500"}`}>
                  {autoKeyHint ?? autoCheck.error ?? "If the task runs short, add up to this much automatically (never above the per-task limit)."}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <label className="block">
                <span className="block text-[11px] font-medium text-slate-400 mb-1">Parallel calls</span>
                <select
                  value={concurrency}
                  onChange={(e) => setConcurrency(Number(e.target.value))}
                  className="w-full rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-slate-300 border border-[#232c40] focus:outline-none focus:border-purple-500 cursor-pointer"
                >
                  {[1, 2, 3, 4, 5].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-slate-400 mb-1">If budget is short</span>
                <select
                  value={shortBudgetMode}
                  onChange={(e) => setShortBudgetMode(e.target.value as "partial" | "ask")}
                  className="w-full rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-slate-300 border border-[#232c40] focus:outline-none focus:border-purple-500 cursor-pointer"
                >
                  <option value="partial">Buy what fits</option>
                  <option value="ask">Ask me first</option>
                </select>
              </label>
              <label className="block">
                <span className="block text-[11px] font-medium text-slate-400 mb-1">Prefer sellers</span>
                <input
                  type="text"
                  value={preferSellers}
                  onChange={(e) => setPreferSellers(e.target.value)}
                  placeholder="optional"
                  className="w-full rounded-lg bg-[#0a0d14] px-3 py-2 text-xs text-white border border-[#232c40] focus:outline-none focus:border-purple-500 font-mono"
                />
              </label>
            </div>

            {errorMsg && (
              <div role="alert" className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
                <span>{errorMsg}</span>
              </div>
            )}

            <div className="flex items-center gap-3 flex-wrap">
              <button
                type="submit"
                disabled={isSubmitting || !canRun || !formValid}
                title={!canRun ? "Not authorised to run Scout from this browser" : !formValid ? "Fix the highlighted fields" : undefined}
                className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-semibold shadow-lg shadow-purple-600/20 transition-colors cursor-pointer"
              >
                {isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4 fill-current" />}
                Run task
              </button>
              <button
                type="button"
                disabled={isSubmitting || !canRun || !formValid}
                onClick={() => void submitTask(true)}
                className="flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[#181f2f] hover:bg-[#20293d] disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 border border-[#263147] text-sm font-medium transition-colors cursor-pointer"
              >
                <Calculator className="h-4 w-4" />
                Estimate only
              </button>
              <span className="text-[11px] text-slate-500">Estimate plans and prices the job without paying anyone.</span>
            </div>
          </form>
        </Card>

        {/* Recent tasks */}
        <Card
          title="Recent tasks"
          icon={<History className="h-4 w-4 text-purple-400" />}
          right={
            <button type="button" onClick={() => void loadRecent()} className="text-slate-400 hover:text-white cursor-pointer" title="Refresh">
              <RefreshCw className="h-3.5 w-3.5" />
            </button>
          }
        >
          {recent.length === 0 ? (
            <p className="text-xs text-slate-500 py-6 text-center">No tasks yet on this server.</p>
          ) : (
            <ul className="space-y-1.5 -mx-2">
              {recent.map((t) => (
                <li key={t.id}>
                  <button
                    type="button"
                    onClick={() => openTask(t.id)}
                    className={`w-full text-left px-2 py-2 rounded-lg flex items-center gap-2 transition-colors cursor-pointer ${currentTaskId === t.id ? "bg-purple-500/10" : "hover:bg-white/[0.04]"}`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs text-slate-200 truncate">{t.task}</div>
                      <div className="text-[10px] text-slate-500 font-mono mt-0.5">
                        {t.spentUsdc} / {t.budgetUsdc} USDC · {new Date(t.createdAt).toLocaleTimeString()}
                      </div>
                    </div>
                    <span className={`text-[10px] px-1.5 py-0.5 rounded border font-semibold ${statusStyle(t.status)}`}>{t.status}</span>
                    <ChevronRight className="h-3.5 w-3.5 text-slate-600" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      {/* Task run */}
      {d && (
        <>
          <section className="rounded-2xl border border-[#222b3d] bg-[#121624] p-5 space-y-5">
            <div className="flex flex-col md:flex-row md:items-start justify-between gap-4">
              <div className="min-w-0 space-y-2">
                <div className="flex items-center gap-2.5 flex-wrap">
                  <span className={`text-[11px] px-2.5 py-1 rounded-lg font-bold uppercase tracking-wider border ${statusStyle(d.status)}`}>
                    {ACTIVE.has(d.status) && <Loader2 className="inline h-3 w-3 mr-1 -mt-0.5 animate-spin" />}
                    {d.status.replace("_", " ")}
                  </span>
                  <span className="text-xs text-slate-500 font-mono">{d.id}</span>
                  {d.request.dry_run && d.status === "planned" && <span className="text-[11px] text-slate-400">Estimate only — nothing spent</span>}
                </div>
                <p className="text-sm text-white leading-relaxed">{d.request.task}</p>
                {d.understanding?.summary && (
                  <p className="text-xs text-slate-400 flex items-start gap-1.5">
                    <Sparkles className="h-3.5 w-3.5 text-purple-400 mt-0.5 shrink-0" />
                    <span>
                      Understood as: <span className="text-slate-200">{d.understanding.summary}</span>
                      {d.parsedBy && <span className="text-slate-500"> · parsed by {d.parsedBy}</span>}
                    </span>
                  </p>
                )}
                {d.understanding?.notes?.length ? (
                  <ul className="list-disc pl-5 text-xs text-slate-400 space-y-0.5">
                    {d.understanding.notes.map((n, i) => (
                      <li key={i}>{n}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {d.status === "planned" && (
                  <button
                    type="button"
                    disabled={isActing || !canRun}
                    onClick={() => void act(() => startTask(d.id, auth))}
                    className="flex items-center gap-1.5 px-4 py-2 rounded-xl bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white text-xs font-semibold transition-colors cursor-pointer"
                  >
                    <Play className="h-3.5 w-3.5 fill-current" /> Run now
                  </button>
                )}
                {["running", "planned", "needs_budget"].includes(d.status) && (
                  <button
                    type="button"
                    disabled={isActing || !canRun}
                    onClick={() => void act(() => cancelTask(d.id, auth))}
                    className="px-4 py-2 rounded-xl bg-rose-500/10 hover:bg-rose-500/20 disabled:opacity-40 text-rose-300 border border-rose-500/30 text-xs font-semibold transition-colors cursor-pointer"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </div>

            {/* Budget meter */}
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Budget</span>
                <span className="font-mono text-slate-300">
                  <span className="text-purple-300">{d.budget.spentUsdc}</span> spent · <span className="text-amber-300">{d.budget.reservedUsdc}</span> held · {d.budget.totalUsdc} USDC cap
                </span>
              </div>
              <div className="h-2 w-full rounded-full bg-[#0a0d14] overflow-hidden flex border border-[#1e2638]">
                <div style={{ width: `${spentPct}%` }} className="bg-purple-500 transition-all duration-500" />
                <div style={{ width: `${reservedPct}%` }} className="bg-amber-500/80 transition-all duration-500" />
              </div>
            </div>

            {d.error && (
              <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-200 text-xs flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 text-rose-400 mt-0.5" />
                <span>{d.error}</span>
              </div>
            )}

            {waiting && d.status === "running" && (
              <div className="p-3 rounded-xl bg-amber-500/10 border border-amber-500/30 text-amber-100 text-xs flex items-start gap-2">
                <Loader2 className="h-4 w-4 shrink-0 animate-spin mt-0.5" />
                <span>Waiting for budget held by in-flight payments to settle. This clears on its own; if the task then runs short it will ask for more here.</span>
              </div>
            )}

            {d.status === "needs_budget" && (
              <div className="p-4 rounded-xl bg-amber-500/10 border border-amber-500/40 space-y-3">
                <div className="text-sm font-semibold text-amber-200 flex items-center gap-2">
                  <AlertCircle className="h-4 w-4" /> Needs {d.shortfall?.neededUsdc ?? "more"} USDC to finish
                  {autoPlans.current.has(d.id) && <span className="text-[11px] font-normal text-amber-300/80">· auto top-up active</span>}
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (topUpCheck.units) void act(() => topUpTask(d.id, fromUnits(topUpCheck.units!), auth));
                  }}
                  className="space-y-1.5"
                >
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      aria-label="Add budget (USDC)"
                      value={topUpAmount}
                      onChange={typedAmount(setTopUpAmount, setTopUpKeyHint)}
                      className="rounded-lg bg-[#0a0d14] px-3 py-1.5 text-xs text-white border border-amber-500/50 font-mono w-28 focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={isActing || !canRun || Boolean(topUpCheck.error)}
                      className="flex items-center gap-1.5 px-4 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-400 disabled:opacity-40 text-slate-950 font-bold text-xs transition-colors cursor-pointer"
                    >
                      <Zap className="h-3.5 w-3.5" /> Add budget &amp; continue
                    </button>
                  </div>
                  {(topUpKeyHint || topUpCheck.error) && <p className="text-[11px] text-rose-300">{topUpKeyHint ?? topUpCheck.error}</p>}
                </form>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Plan / steps */}
            <Card
              title={d.steps.length ? "Steps" : "Plan & estimate"}
              icon={<ListChecks className="h-4 w-4 text-purple-400" />}
              right={
                <div className="flex items-center gap-2">
                  {d.steps.length > 0 && ACTIVE.has(d.status) && (
                    <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-purple-500/15 text-purple-300 border border-purple-500/30">
                      {runningStepsCount > 0 ? `${runningStepsCount}/${maxParallel} parallel calling` : `Parallel cap: ${maxParallel}`}
                    </span>
                  )}
                  {d.estimate && <span className="font-mono text-xs text-purple-300">est. {d.estimate.totalUsdc} USDC</span>}
                </div>
              }
            >
              {d.steps.length > 0 ? (
                <ol className="space-y-2.5">
                  {d.steps.map((st) => (
                    <li key={st.id} className="flex items-start gap-2.5">
                      <StepIcon state={st.state} />
                      <div className="min-w-0 text-xs flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={st.state === "pending" ? "text-slate-400" : "text-slate-200"}>
                            {st.description}
                          </span>
                          {st.state === "running" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono animate-pulse">
                              calling payment…
                            </span>
                          )}
                          {st.state === "pending" && (
                            <span className="text-[10px] px-1.5 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/60 font-mono">
                              queued (waiting for parallel slot)
                            </span>
                          )}
                        </div>
                        {st.sellerId && <div className="text-[11px] text-purple-300/80 font-mono mt-0.5">{st.sellerId}</div>}
                        {st.error && <div className="text-[11px] text-rose-300 mt-0.5">{st.error}</div>}
                      </div>
                    </li>
                  ))}
                </ol>
              ) : d.estimate?.steps?.length ? (
                <div className="overflow-x-auto -mx-1">
                  <table className="w-full text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="py-1.5 px-1 font-medium">Purchase</th>
                        <th className="py-1.5 px-1 font-medium text-right">Calls</th>
                        <th className="py-1.5 px-1 font-medium">Seller</th>
                        <th className="py-1.5 px-1 font-medium text-right">USDC</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#1e2538]">
                      {d.estimate.steps.map((s) => (
                        <tr key={s.id}>
                          <td className="py-2 px-1 text-slate-200">{s.description}</td>
                          <td className="py-2 px-1 text-right text-slate-400 font-mono">{s.calls}</td>
                          <td className="py-2 px-1 text-purple-300 font-mono whitespace-nowrap">{s.sellerId}</td>
                          <td className="py-2 px-1 text-right text-slate-200 font-mono whitespace-nowrap">{s.totalUsdc}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="text-xs text-slate-500 flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Planning…
                </p>
              )}
            </Card>

            {/* Live log */}
            <Card title="Live activity" icon={<Activity className="h-4 w-4 text-purple-400" />} right={ACTIVE.has(d.status) ? <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse" /> : undefined}>
              <div ref={logContainerRef} className="max-h-80 overflow-y-auto space-y-1.5 font-mono text-[11px] -mx-1 px-1">
                {liveLogs.length === 0 ? (
                  <p className="text-slate-500 text-center py-8 font-sans text-xs">Waiting for events…</p>
                ) : (
                  liveLogs.map((l) => (
                    <div
                      key={l.key}
                      className={`flex gap-2 leading-relaxed ${l.kind === "ok" ? "text-emerald-300" : l.kind === "warn" ? "text-amber-300" : l.kind === "bad" ? "text-rose-300" : "text-slate-300"}`}
                    >
                      <span className="text-slate-600 shrink-0">{l.time}</span>
                      <span className="break-words min-w-0">
                        {l.text}
                        {l.href && (
                          <a href={l.href} target="_blank" rel="noopener noreferrer" className="ml-1.5 text-purple-300 hover:underline inline-flex items-center gap-0.5">
                            tx <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </span>
                    </div>
                  ))
                )}
              </div>
            </Card>
          </div>

          {/* Answer */}
          {typeof d.answer === "string" && d.answer.trim() !== "" && (
            <Card title="Answer" icon={<FileText className="h-4 w-4 text-emerald-400" />}>
              <Markdown text={d.answer} />
            </Card>
          )}
          {d.answer != null && typeof d.answer !== "string" && (
            <Card title="Answer" icon={<FileText className="h-4 w-4 text-emerald-400" />}>
              <pre className="text-xs text-slate-200 whitespace-pre-wrap">{JSON.stringify(d.answer, null, 2)}</pre>
            </Card>
          )}

          {/* Audit trail */}
          {d.explanation && (
            <Card
              title="Audit trail"
              icon={<ShieldCheck className="h-4 w-4 text-purple-400" />}
              right={
                onViewLedger && (
                  <button type="button" onClick={onViewLedger} className="text-xs text-purple-300 hover:text-purple-200 cursor-pointer">
                    Open ledger →
                  </button>
                )
              }
            >
              <div className="space-y-4">
                <p className="text-sm text-slate-300">{d.explanation.summary}</p>
                {d.explanation.narrative && (
                  <blockquote className="text-sm text-purple-200/90 border-l-2 border-purple-500/50 pl-3 italic">{d.explanation.narrative}</blockquote>
                )}
                {d.explanation.purchases?.length > 0 && (
                  <div className="overflow-x-auto rounded-xl border border-[#1e2538]">
                    <table className="w-full text-left text-xs">
                      <thead className="bg-[#111520] text-slate-400">
                        <tr>
                          <th className="py-2 px-3 font-medium">#</th>
                          <th className="py-2 px-3 font-medium">Step</th>
                          <th className="py-2 px-3 font-medium">Seller</th>
                          <th className="py-2 px-3 font-medium">Result</th>
                          <th className="py-2 px-3 font-medium text-right">Paid</th>
                          <th className="py-2 px-3 font-medium">Why</th>
                          <th className="py-2 px-3 font-medium">Tx</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#1e2538]">
                        {d.explanation.purchases.map((p) => (
                          <tr key={p.index} className="hover:bg-white/[0.03] align-top">
                            <td className="py-2 px-3 text-slate-500 font-mono">{p.index}</td>
                            <td className="py-2 px-3 text-slate-200">{p.stepId}</td>
                            <td className="py-2 px-3 text-purple-300 font-mono whitespace-nowrap">{p.sellerId}</td>
                            <td className="py-2 px-3">
                              <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold border ${p.status === "paid" ? statusStyle("completed") : p.status === "refused" || p.status === "failed_not_charged" ? statusStyle("partial") : statusStyle("failed")}`}>
                                {p.status}
                              </span>
                            </td>
                            <td className="py-2 px-3 text-right font-mono text-white whitespace-nowrap">{p.paidUsdc}</td>
                            <td className="py-2 px-3 text-slate-400 max-w-xs">{p.decisionReason}</td>
                            <td className="py-2 px-3 font-mono">
                              {p.txHash ? (
                                <a href={p.explorerUrl ?? `${explorerUrl}/tx/${p.txHash}`} target="_blank" rel="noopener noreferrer" className="text-purple-300 hover:underline inline-flex items-center gap-1">
                                  {p.txHash.slice(0, 8)}… <ExternalLink className="h-3 w-3" />
                                </a>
                              ) : (
                                <span className="text-slate-600">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {d.explanation.decisions?.length > 0 && (
                  <ul className="list-disc pl-5 text-xs text-slate-400 space-y-1">
                    {d.explanation.decisions.map((x, i) => (
                      <li key={i}>{x}</li>
                    ))}
                  </ul>
                )}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
};
