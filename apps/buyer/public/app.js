// Buyer console. All data is rendered with textContent / DOM nodes (seller output is untrusted).

const $ = (id) => document.getElementById(id);
let explorer = "https://sepolia.basescan.org";
let current = null;
let source = null;

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
  const u = BigInt(units ?? 0);
  const whole = u / 1000000n;
  const frac = (u % 1000000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
};
const money = (v, c) => {
  try {
    return new Intl.NumberFormat(c === "INR" ? "en-IN" : "en-GB", { style: "currency", currency: c, maximumFractionDigits: ["JPY", "KRW"].includes(c) ? 0 : 2 }).format(v);
  } catch {
    return `${v} ${c}`;
  }
};
const shortHash = (h) => (h ? `${h.slice(0, 10)}…` : "");
const token = () => $("token").value.trim();
const headers = () => ({ "content-type": "application/json", ...(token() ? { authorization: `Bearer ${token()}` } : {}) });

try {
  $("token").value = localStorage.getItem("buyerToken") ?? "";
} catch {}
$("token").addEventListener("change", () => {
  try {
    localStorage.setItem("buyerToken", token());
  } catch {}
});

fetch("api/meta")
  .then((r) => r.json())
  .then((m) => {
    explorer = m.explorer;
    $("buyer-line").textContent = `Buyer wallet ${m.buyer} · registry ${m.registry}`;
    for (const ex of m.examples) {
      const b = el("button", { type: "button", title: ex.task }, ex.title);
      b.addEventListener("click", () => {
        $("task").value = ex.task;
        $("budget").value = ex.budget;
      });
      $("examples").append(b);
    }
  })
  .catch(() => {});

async function submit(dryRun) {
  const status = $("form-status");
  status.classList.remove("error");
  status.textContent = dryRun ? "estimating…" : "starting…";
  const prefer = $("prefer").value.split(",").map((s) => s.trim()).filter(Boolean);
  const body = {
    task: $("task").value,
    budget: $("budget").value.trim(),
    max_concurrency: Number($("concurrency").value) || 3,
    on_short_budget: $("mode").value,
    dry_run: dryRun,
    ...(prefer.length ? { prefer_sellers: prefer } : {}),
  };
  const res = await fetch("api/tasks", { method: "POST", headers: headers(), body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    status.classList.add("error");
    status.textContent = data.message ?? data.error ?? `HTTP ${res.status}`;
    return;
  }
  status.textContent = "";
  watch(data.taskId);
}
$("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  submit(false);
});
$("estimate-btn").addEventListener("click", () => submit(true));

function watch(id) {
  source?.close();
  $("log").replaceChildren();
  $("task-card").hidden = false;
  $("answer-card").hidden = true;
  $("explain-card").hidden = true;
  current = id;
  source = new EventSource(`api/tasks/${id}/events`);
  source.onmessage = () => {};
  for (const type of ["task_created", "parsed", "estimate", "status", "call_started", "call_finished", "fallback", "waiting_for_budget", "step_blocked", "step_failed", "progress", "needs_budget", "answer", "settled", "narrative", "topped_up", "error"]) {
    source.addEventListener(type, (m) => {
      const e = JSON.parse(m.data);
      logEvent(e);
      if (["parsed", "estimate", "status", "answer", "settled", "narrative", "needs_budget", "topped_up", "call_finished"].includes(type)) refresh();
    });
  }
  source.addEventListener("budget", (m) => renderMeter(JSON.parse(m.data)));
  refresh();
}

let refreshing = false;
async function refresh() {
  if (refreshing || !current) return;
  refreshing = true;
  try {
    const t = await (await fetch(`api/tasks/${current}`)).json();
    render(t);
  } finally {
    refreshing = false;
  }
}

function logEvent(e) {
  const time = e.at?.slice(11, 19) ?? "";
  let text = null;
  let cls = "";
  switch (e.type) {
    case "parsed": text = `Understood (${e.parsedBy}): ${e.summary}`; break;
    case "estimate": text = `Estimate: ${e.estimate.lowerBound ? "at least " : ""}${e.estimate.totalUsdc} USDC`; break;
    case "status": text = `Status: ${e.status}`; break;
    case "call_started": text = `→ ${e.label}: calling ${e.serviceId} (${(e.why ?? "").split("; ").slice(0, 2).join("; ")})${e.relaxed?.length ? ` [relaxed ${e.relaxed.join(", ")}]` : ""}`; break;
    case "call_finished": {
      const a = e.attempt;
      cls = a.usable ? "ok" : a.status === "refused" || a.status === "paid_output_rejected" ? "bad" : "warn";
      text = `${a.usable ? "✓" : "✗"} ${e.label}: ${a.serviceId} ${a.status}${a.paidUnits !== "0" ? ` (${usdc(a.paidUnits)} USDC)` : ""}${a.reason ? ` · ${a.reason}` : ""}`;
      break;
    }
    case "fallback": cls = "warn"; text = `↪ ${e.label}: dropping ${e.from} (${e.reason})${e.next ? `, trying ${e.next}` : ", no other seller"}`; break;
    case "waiting_for_budget": cls = "warn"; text = `… ${e.label}: waiting for ${usdc(e.heldUnits)} USDC held by an unsettled payment`; break;
    case "step_blocked": cls = "warn"; text = `■ ${e.label}: over budget (needs ${usdc(e.neededUnits)} USDC)`; break;
    case "step_failed": cls = "bad"; text = `✗ ${e.label}: ${e.reason}`; break;
    case "progress": text = e.message; break;
    case "needs_budget": cls = "warn"; text = e.shortfall.message; break;
    case "settled": cls = "ok"; text = "All payments final on-chain; ledger delivered to the registry."; break;
    case "topped_up": text = `Topped up ${e.amountUsdc} USDC (budget now ${e.budgetUsdc})`; break;
    case "error": cls = "bad"; text = `Error: ${e.message}`; break;
  }
  if (!text) return;
  const li = el("li", { class: cls }, el("span", { class: "t" }, time), text);
  $("log").append(li);
  li.scrollIntoView({ block: "nearest" });
}

function renderMeter(b) {
  const total = Number(b.totalUnits ?? b.total ?? 0) || 1;
  const spent = Number(b.spentUnits ?? b.spent ?? 0);
  const reserved = Number(b.reserved ?? (b.reservedUsdc ? Math.round(Number(b.reservedUsdc) * 1e6) : 0));
  $("m-spent").style.width = `${(spent / total) * 100}%`;
  $("m-reserved").style.width = `${(reserved / total) * 100}%`;
  $("m-legend").textContent = `spent ${usdc(spent)} · reserved ${usdc(reserved)} · left ${usdc(total - spent - reserved)} of ${usdc(total)} USDC`;
}

function render(t) {
  $("status-badge").textContent = t.status.replace("_", " ");
  $("status-badge").className = `badge ${t.status}`;
  $("task-id").textContent = `${t.id} · session ${t.sessionId}`;
  $("understood").textContent = t.understood ? `Understood: ${t.understood}${t.parsedBy ? ` (read by ${t.parsedBy})` : ""}` : "";
  $("notes").replaceChildren(...(t.notes ?? []).map((n) => el("li", {}, n)));
  renderMeter({ totalUnits: t.budget.totalUnits, spentUnits: t.budget.spentUnits, reservedUsdc: t.budget.reservedUsdc });
  $("start-btn").hidden = t.status !== "planned";
  $("cancel-btn").hidden = !["running", "needs_budget", "planned"].includes(t.status);

  const tbody = $("estimate").querySelector("tbody");
  tbody.replaceChildren();
  for (const l of t.estimate?.lines ?? []) {
    tbody.append(el("tr", {}, el("td", {}, l.what, l.note ? el("div", { class: "muted" }, l.note) : ""), el("td", { class: "num" }, l.calls), el("td", { class: "mono" }, l.serviceId ?? "none"), el("td", { class: "num" }, l.subtotalUnits ? usdc(l.subtotalUnits) : "-")));
  }
  if (t.estimate) tbody.append(el("tr", {}, el("td", {}, el("strong", {}, "Total")), el("td", {}, ""), el("td", {}, ""), el("td", { class: "num" }, el("strong", {}, `${t.estimate.lowerBound ? "≥ " : ""}${t.estimate.totalUsdc}`))));

  $("shortfall").hidden = !t.shortfall;
  if (t.shortfall) {
    $("shortfall-text").textContent = t.shortfall.message;
    if (!$("topup").value) $("topup").value = t.shortfall.neededUsdc;
  }

  if (t.result) renderAnswer(t);
  if (t.explanation) renderExplanation(t);
}

function renderAnswer(t) {
  const r = t.result;
  const box = $("answer");
  box.replaceChildren();
  const cur = r.rates.map((x) => x.currency);
  if (r.kind === "books") {
    const table = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "#"), el("th", {}, "Book"), el("th", {}, "Rating"), el("th", { class: "num" }, "GBP"), ...cur.map((c) => el("th", { class: "num" }, c)))));
    const tb = el("tbody");
    for (const b of r.books) {
      tb.append(el("tr", {}, el("td", {}, b.rank), el("td", {}, b.url ? el("a", { href: b.url, target: "_blank", rel: "noopener" }, b.title) : b.title), el("td", {}, "★".repeat(b.rating)), el("td", { class: "num" }, money(b.priceGbp, "GBP")), ...cur.map((c) => el("td", { class: "num" }, b.prices[c] != null ? money(b.prices[c], c) : "?"))));
    }
    table.append(tb);
    box.append(el("div", { class: "table-scroll" }, table));
    const texts = r.books.filter((b) => b.text);
    if (texts.length) box.append(el("ol", { class: "answer-list" }, ...texts.map((b) => el("li", {}, el("strong", {}, b.title), el("div", { class: "hindi", lang: "hi" }, b.text)))));
  } else {
    const table = el("table", {}, el("thead", {}, el("tr", {}, el("th", {}, "Category"), el("th", { class: "num" }, "Books"), el("th", { class: "num" }, "Average GBP"), ...cur.map((c) => el("th", { class: "num" }, `Average ${c}`)), el("th", {}, "Range GBP"))));
    const tb = el("tbody");
    for (const g of r.groups) {
      tb.append(el("tr", {}, el("td", {}, g.category), el("td", { class: "num" }, g.count), el("td", { class: "num" }, money(g.averageGbp, "GBP")), ...cur.map((c) => el("td", { class: "num" }, g.prices.average[c] != null ? money(g.prices.average[c], c) : "?")), el("td", {}, `${money(g.minGbp, "GBP")} to ${money(g.maxGbp, "GBP")}`)));
    }
    table.append(tb);
    box.append(el("div", { class: "table-scroll" }, table));
    if (r.combinedText) box.append(el("p", { class: "hindi", lang: "hi" }, r.combinedText));
  }
  if (r.rates.length) box.append(el("p", { class: "muted" }, `Rates: ${r.rates.map((x) => `1 GBP = ${x.rate} ${x.currency}`).join(", ")} (${r.rates[0].source ?? ""} ${r.rates[0].date ?? ""}) · scanned ${r.scanned.pages} pages, ${r.scanned.books} books`));
  if (r.gaps.length) box.append(el("p", { class: "muted" }, `Gaps: ${r.gaps.join("; ")}`));
  $("answer-card").hidden = false;
}

function renderExplanation(t) {
  const x = t.explanation;
  $("summary").textContent = x.summary;
  $("narrative").hidden = !t.narrative;
  $("narrative").textContent = t.narrative ?? "";
  const tb = $("purchases").querySelector("tbody");
  tb.replaceChildren();
  for (const p of x.purchases) {
    tb.append(
      el(
        "tr",
        {},
        el("td", {}, p.n),
        el("td", {}, p.step),
        el("td", { class: "mono" }, p.serviceId),
        el("td", {}, el("span", { class: `st ${p.status}` }, p.status.replaceAll("_", " ")), p.outcome && p.outcome !== "used" ? el("div", { class: "muted" }, p.outcome) : ""),
        el("td", { class: "num" }, p.listedUsdc),
        el("td", { class: "num" }, p.askedUsdc ?? "-"),
        el("td", { class: "num" }, p.paidUsdc),
        el("td", {}, p.why),
        el("td", {}, p.explorerUrl ? el("a", { href: p.explorerUrl, target: "_blank", rel: "noopener", class: "mono" }, shortHash(p.txHash)) : "-", p.onchainConfirmed ? " ✓" : ""),
      ),
    );
  }
  $("decisions").replaceChildren(...x.decisions.map((d) => el("li", {}, d)));
  $("settled-line").textContent = t.settled ? "Settled: every payment is final on-chain and the ledger is in the registry." : "Settling: waiting for on-chain confirmations…";
  $("explain-card").hidden = false;
}

async function act(path, body) {
  const res = await fetch(`api/tasks/${current}/${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body ?? {}) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) alertBox(data.message ?? data.error);
  refresh();
}
function alertBox(msg) {
  $("form-status").classList.add("error");
  $("form-status").textContent = msg ?? "request failed";
}
$("topup-form").addEventListener("submit", (e) => {
  e.preventDefault();
  act("topup", { amount: $("topup").value.trim() });
  $("topup").value = "";
});
$("start-btn").addEventListener("click", () => act("start"));
$("cancel-btn").addEventListener("click", () => act("cancel"));
