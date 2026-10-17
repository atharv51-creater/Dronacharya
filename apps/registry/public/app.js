// Marketplace page. Listing fields come from anyone who registers, so everything is rendered with
// textContent / DOM nodes, never innerHTML.

const $ = (id) => document.getElementById(id);
let explorer = "https://sepolia.basescan.org";
let current = [];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k === "href") node.href = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) node.append(child instanceof Node ? child : document.createTextNode(String(child ?? "")));
  return node;
}

const short = (addr) => `${addr.slice(0, 6)}…${addr.slice(-4)}`;
const pct = (r) => `${Math.round(r * 1000) / 10}%`;
const rateClass = (r) => (r >= 0.9 ? "rate-good" : r >= 0.6 ? "rate-mid" : "rate-bad");

function addressLink(addr) {
  return el("a", { href: `${explorer}/address/${addr}`, target: "_blank", rel: "noopener", class: "mono", title: addr }, short(addr));
}

function setStatus(text, isError = false) {
  const s = $("status");
  s.textContent = text;
  s.classList.toggle("error", isError);
}

function query() {
  const p = new URLSearchParams();
  const map = { category: "f-category", maxPrice: "f-max", minSuccessRate: "f-success", sort: "f-sort", q: "f-q" };
  for (const [key, id] of Object.entries(map)) {
    const v = $(id).value.trim();
    if (v) p.set(key, v);
  }
  if ($("f-fixtures").checked) p.set("includeFixtures", "true");
  return p;
}

async function load() {
  const params = query();
  history.replaceState(null, "", params.toString() ? `?${params}` : location.pathname);
  try {
    const res = await fetch(`api/services?${params}`);
    const body = await res.json();
    if (!res.ok) {
      setStatus((body.details ?? [body.error]).join("; "), true);
      return;
    }
    current = body.services;
    render(current);
    setStatus(`${body.count} service${body.count === 1 ? "" : "s"}`);
  } catch {
    setStatus("Could not reach the registry API.", true);
  }
}

function render(services) {
  const rows = $("rows");
  rows.replaceChildren();
  if (services.length === 0) {
    rows.append(el("tr", {}, el("td", { colspan: "7", class: "units" }, "No services match these filters.")));
    return;
  }
  for (const s of services) {
    const name = el("div", { class: "svc-name" }, s.name);
    if (s.isFixture) name.append(el("span", { class: "fixture" }, "TEST FIXTURE"));
    const tr = el(
      "tr",
      { tabindex: "0" },
      el("td", {}, name, el("div", { class: "svc-desc" }, s.description)),
      el("td", {}, el("span", { class: "chip" }, s.category)),
      el("td", { class: "num" }, `${s.priceUsdc} USDC`, el("div", { class: "units" }, `${s.priceUnits} units`)),
      el("td", {}, addressLink(s.payTo)),
      el("td", { class: `num ${rateClass(s.reputation.successRate)}` }, pct(s.reputation.successRate)),
      el("td", { class: "num" }, s.reputation.medianLatencyMs == null ? "—" : `${s.reputation.medianLatencyMs} ms`),
      el("td", { class: "num" }, s.reputation.calls),
    );
    tr.addEventListener("click", () => showDetail(s));
    tr.addEventListener("keydown", (e) => e.key === "Enter" && showDetail(s));
    rows.append(tr);
  }
}

function showDetail(s) {
  $("d-name").textContent = s.name;
  $("d-desc").textContent = s.description;
  const facts = $("d-facts");
  facts.replaceChildren();
  const add = (k, v) => facts.append(el("dt", {}, k), el("dd", {}, v));
  add("id", el("span", { class: "mono" }, s.id));
  add("Seller", s.sellerId);
  add("Endpoint", el("span", { class: "mono" }, `${s.method} ${s.endpoint}`));
  add("Price", `${s.priceUsdc} USDC (${s.priceUnits} units)`);
  add("Network", s.network);
  add("Asset", el("a", { href: `${explorer}/token/${s.asset}`, target: "_blank", rel: "noopener", class: "mono" }, s.asset));
  add("payTo", el("a", { href: `${explorer}/address/${s.payTo}`, target: "_blank", rel: "noopener", class: "mono" }, s.payTo));
  add("Reputation", `${pct(s.reputation.successRate)} success over ${s.reputation.calls} call(s); value score ${s.costPerSuccessUnits} units per good result`);
  add("Registered", `${s.registeredBy} · ${new Date(s.createdAt).toLocaleString()}`);
  $("d-in").textContent = JSON.stringify(s.inputSchema, null, 2);
  $("d-out").textContent = JSON.stringify(s.outputSchema, null, 2);
  $("detail").hidden = false;
  $("detail").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("d-close").addEventListener("click", () => ($("detail").hidden = true));

let timer;
for (const id of ["f-category", "f-success", "f-sort", "f-fixtures"]) $(id).addEventListener("change", load);
for (const id of ["f-max", "f-q"]) {
  $(id).addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(load, 250);
  });
}

$("reg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const out = $("reg-status");
  const data = Object.fromEntries(new FormData(e.target).entries());
  try {
    data.inputSchema = JSON.parse(data.inputSchema);
    data.outputSchema = JSON.parse(data.outputSchema);
  } catch {
    out.textContent = "Schemas must be valid JSON.";
    out.classList.add("error");
    return;
  }
  data.sellerId = data.id;
  const res = await fetch("api/services", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  out.classList.toggle("error", !res.ok);
  out.textContent = res.ok ? `Registered ${body.id} at ${body.priceUsdc} USDC.` : (body.details ?? [body.message ?? body.error]).join("; ");
  if (res.ok) load();
});

const buyerForm = $("buyer-reg-form");
if (buyerForm) {
  buyerForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    const out = $("buyer-reg-status");
    const data = Object.fromEntries(new FormData(e.target).entries());
    if (!data.name || !data.wallet) {
      out.textContent = "Name and wallet address are required.";
      out.classList.add("error");
      return;
    }
    const res = await fetch("api/users/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
    const body = await res.json().catch(() => ({}));
    out.classList.toggle("error", !res.ok);
    out.textContent = res.ok
      ? `Registered "${body.user?.name}" (${body.user?.role})! Logged in Registry.`
      : (body.message ?? body.error ?? "Registration failed");
  });
}

// Restore filters from the URL, then load.
const initial = new URLSearchParams(location.search);
const restore = { category: "f-category", maxPrice: "f-max", minSuccessRate: "f-success", sort: "f-sort", q: "f-q" };
for (const [key, id] of Object.entries(restore)) if (initial.has(key)) $(id).value = initial.get(key);
$("f-fixtures").checked = initial.get("includeFixtures") === "true";

fetch("api/meta")
  .then((r) => r.json())
  .then((m) => {
    explorer = m.explorer;
    $("network-pill").textContent = `Base Sepolia · ${m.network} · testnet`;
  })
  .catch(() => {})
  .finally(load);
