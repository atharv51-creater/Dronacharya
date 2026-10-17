// Ledger dashboard. Rows come from buyers (untrusted text): rendered with textContent only.

const $ = (id) => document.getElementById(id);
let explorer = "https://sepolia.basescan.org";
let rows = new Map();
let sessions = [];

const STATUS_LABEL = {
  paid: "paid",
  paid_output_rejected: "paid, output rejected",
  refused: "refused",
  failed_not_charged: "failed, not charged",
  pending: "pending",
};

function el(tag, attrs = {}, ...children) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") n.className = v;
    else if (k === "href") n.href = v;
    else n.setAttribute(k, v);
  }
  for (const c of children) n.append(c instanceof Node ? c : document.createTextNode(String(c ?? "")));
  return n;
}
const usdc = (units) => {
  if (units == null) return "-";
  const u = BigInt(units);
  const neg = u < 0n;
  const a = neg ? -u : u;
  const frac = (a % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${neg ? "-" : ""}${a / 1000000n}${frac ? "." + frac : ""}`;
};
const short = (s) => (s ? `${s.slice(0, 6)}…${s.slice(-4)}` : "");
const link = (href, text, cls = "mono") => el("a", { href, target: "_blank", rel: "noopener", class: cls }, text);

function filters() {
  return { sessionId: $("f-session").value, status: $("f-status").value, service: $("f-service").value.trim() };
}
function matches(row) {
  const f = filters();
  return (!f.sessionId || row.sessionId === f.sessionId) && (!f.status || row.status === f.status) && (!f.service || row.serviceId.includes(f.service));
}

async function loadRows() {
  const f = filters();
  const q = new URLSearchParams({ limit: "1000" });
  if (f.sessionId) q.set("sessionId", f.sessionId);
  if (f.status) q.set("status", f.status);
  const data = await (await fetch(`api/ledger?${q}`)).json();
  rows = new Map(data.rows.map((r) => [r.id, r]));
  render();
}

async function loadSessions() {
  const data = await (await fetch("api/sessions")).json();
  sessions = data.sessions;
  const select = $("f-session");
  const current = select.value;
  select.replaceChildren(el("option", { value: "" }, "All sessions"));
  for (const s of sessions) {
    select.append(el("option", { value: s.id }, `${s.id} · ${short(s.buyer)} · ${usdc(s.totals.paidUnits)} USDC · ${s.totals.calls} calls`));
  }
  select.value = current;
}

function render() {
  const list = [...rows.values()].filter(matches).sort((a, b) => b.time.localeCompare(a.time));
  const tbody = $("rows");
  tbody.replaceChildren();
  for (const r of list) {
    const tx = r.txHash ? el("span", {}, link(r.explorerUrl ?? `${explorer}/tx/${r.txHash}`, short(r.txHash)), r.onchainConfirmed ? el("span", { class: "ok", title: "receipt checked" }, " ✓") : "") : "-";
    tbody.append(
      el(
        "tr",
        { "data-id": r.id },
        el("td", { class: "mono" }, new Date(r.time).toLocaleTimeString()),
        el("td", {}, link(`${explorer}/address/${r.buyer}`, short(r.buyer))),
        el("td", {}, el("div", {}, r.serviceId), el("div", { class: "units" }, r.sellerId)),
        el("td", { class: "num" }, usdc(r.listedUnits)),
        el("td", { class: "num" }, r.askedUnits == null ? "-" : usdc(r.askedUnits)),
        el("td", { class: "num" }, usdc(r.paidUnits)),
        el("td", {}, tx),
        el("td", {}, el("span", { class: `badge ${r.status}` }, STATUS_LABEL[r.status] ?? r.status), r.reason ? el("div", { class: "units reason" }, r.reason) : ""),
        el("td", { class: "num" }, `${r.latencyMs} ms`),
      ),
    );
  }
  $("status").textContent = list.length ? "" : "No calls yet.";
  renderStats(list);
  $("reconcile-card").hidden = !filters().sessionId;
}

function renderStats(list) {
  let paid = 0n;
  const counts = {};
  for (const r of list) {
    counts[r.status] = (counts[r.status] ?? 0) + 1;
    if (r.status === "paid" || r.status === "paid_output_rejected") paid += BigInt(r.paidUnits);
  }
  const tile = (label, value) => el("div", { class: "stat" }, el("div", { class: "stat-value" }, value), el("div", { class: "stat-label" }, label));
  $("stats").replaceChildren(
    tile("calls", String(list.length)),
    tile("USDC paid", usdc(paid)),
    tile("transactions", String(list.filter((r) => r.txHash && BigInt(r.paidUnits) > 0n).length)),
    ...Object.keys(STATUS_LABEL).filter((k) => counts[k]).map((k) => tile(STATUS_LABEL[k], String(counts[k]))),
  );
}

async function reconcile() {
  const sessionId = filters().sessionId;
  if (!sessionId) return;
  const out = $("reconcile-out");
  out.replaceChildren(el("p", { class: "hint" }, "Scanning Base Sepolia…"));
  $("reconcile-btn").disabled = true;
  try {
    const res = await fetch(`api/ledger/reconcile?sessionId=${encodeURIComponent(sessionId)}`);
    const r = await res.json();
    if (!res.ok) {
      out.replaceChildren(el("p", { class: "status error" }, r.message ?? r.error));
      return;
    }
    const verdict = el("p", { class: r.ok ? "verdict ok" : "verdict bad" }, r.ok ? "✓ " : "✗ ", r.summary);
    const facts = el(
      "dl",
      { class: "facts" },
      el("dt", {}, "Ledger"), el("dd", {}, `${usdc(r.ledger.paidUnits)} USDC in ${r.ledger.paidRows} paid rows (${r.ledger.confirmedRows} receipts checked, ${r.ledger.pendingRows} pending)`),
      el("dt", {}, "Chain"), el("dd", {}, `${usdc(r.chain.units)} USDC in ${r.chain.transfers} transfers out of `, link(`${explorer}/address/${r.buyer}`, short(r.buyer))),
      el("dt", {}, "Difference"), el("dd", {}, `${usdc(r.diffUnits)} USDC`),
      el("dt", {}, "Blocks"), el("dd", {}, `${r.fromBlock} to ${r.toBlock}`),
      ...(r.session ? [el("dt", {}, "This session"), el("dd", {}, `${usdc(r.session.paidUnits)} USDC in ${r.session.rows} paid rows`)] : []),
    );
    const issues = r.issues.length
      ? el("ul", { class: "issues" }, ...r.issues.map((i) => el("li", {}, el("strong", {}, i.kind.replaceAll("_", " ")), ": ", i.detail, " ", i.explorerUrl ? link(i.explorerUrl, short(i.txHash)) : "")))
      : "";
    out.replaceChildren(verdict, facts, issues);
  } catch {
    out.replaceChildren(el("p", { class: "status error" }, "Could not reach the registry."));
  } finally {
    $("reconcile-btn").disabled = false;
  }
}

async function loadUsers() {
  try {
    const res = await (await fetch("api/users")).json();
    const tbody = $("users-tbody");
    if (!tbody) return;
    tbody.replaceChildren(
      ...(res.users || []).map((u) =>
        el(
          "tr",
          {},
          el("td", { class: "bold" }, u.name),
          el("td", {}, el("span", { class: "pill" }, u.role)),
          el("td", { class: "mono" }, u.network),
          el("td", {}, link(`${explorer}/address/${u.wallet}`, short(u.wallet))),
          el("td", { class: "ok" }, u.status || "active")
        )
      )
    );
  } catch {
    // optional
  }
}

async function loadWallets() {
  try {
    const data = await (await fetch("api/wallets")).json();
    $("wallets").replaceChildren(
      ...data.wallets.map((w) => el("tr", {}, el("td", {}, link(w.explorerUrl, w.address)), el("td", {}, w.roles.join(", ")), el("td", { class: "num" }, w.usdc ?? "?"))),
    );
  } catch {
    // balances are optional
  }
}

function connect() {
  const live = $("live");
  const source = new EventSource("api/ledger/stream");
  source.addEventListener("open", () => live.classList.add("on"));
  source.addEventListener("error", () => live.classList.remove("on"));
  source.addEventListener("row", (m) => {
    const row = JSON.parse(m.data);
    const isNew = !rows.has(row.id);
    rows.set(row.id, row);
    render();
    if (isNew && !sessions.some((s) => s.id === row.sessionId)) loadSessions();
    const tr = document.querySelector(`tr[data-id="${CSS.escape(row.id)}"]`);
    tr?.classList.add("flash");
  });
}

for (const id of ["f-session", "f-status"]) $(id).addEventListener("change", () => {
  const q = new URLSearchParams();
  if ($("f-session").value) q.set("session", $("f-session").value);
  history.replaceState(null, "", q.toString() ? `?${q}` : location.pathname);
  $("reconcile-out").replaceChildren();
  loadRows();
});
$("f-service").addEventListener("input", render);
$("reconcile-btn").addEventListener("click", reconcile);

fetch("api/meta").then((r) => r.json()).then((m) => (explorer = m.explorer)).catch(() => {});
const initial = new URLSearchParams(location.search).get("session");
await loadSessions();
if (initial) $("f-session").value = initial;
await loadRows();
connect();
loadWallets();
loadUsers();
setInterval(loadWallets, 60_000);
setInterval(loadUsers, 60_000);
