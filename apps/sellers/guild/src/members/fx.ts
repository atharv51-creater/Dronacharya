// fx-global: 166 currencies from open.er-api.com (ExchangeRate-API open access; free, no key), with the same
// request and answer shape as fx-rates, so it is a drop-in alternative that also covers currencies the
// ECB does not publish (AED, SAR, PKR, NGN, ...).
//
// fx-trend: the latest ECB rate plus a 7-90 day window (min, max, mean, change) from Frankfurter. Its answer
// also contains `rate`, so a buyer that needs only the rate can use it as a fallback.

import { HttpError } from "@dron/shared";
import type { PaidRoute } from "@dron/x402-kit";
import { inputSchema as pairInput, outputSchema as rateOutput } from "@dron/seller-data/schemas";

type Fetch = typeof fetch;

async function getJson(url: string, what: string, signal?: AbortSignal, fetchImpl: Fetch = fetch): Promise<any> {
  let res: Response;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json" }, signal });
  } catch {
    if (signal?.aborted) throw new HttpError(504, "timeout", `${what} did not answer in time`);
    throw new HttpError(502, "upstream_unreachable", `${what} unreachable`);
  }
  if (res.status === 404 || res.status === 422) return { __status: res.status };
  if (!res.ok) throw new HttpError(502, "upstream_error", `${what} answered ${res.status}`);
  return res.json();
}

// ---------- fx-global ----------

const ER_API = "https://open.er-api.com/v6/latest";
const ER_SOURCE = "open.er-api.com (Rates By Exchange Rate API, https://www.exchangerate-api.com)";
const tables = new Map<string, { rates: Record<string, number>; date: string; expires: number }>();

export async function globalRate(fromRaw: string, toRaw: string, signal?: AbortSignal, fetchImpl?: Fetch) {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  let table = tables.get(from);
  if (!table || table.expires < Date.now()) {
    const body = await getJson(`${ER_API}/${from}`, "open.er-api.com", signal, fetchImpl);
    if (body?.result === "error" || body?.__status) {
      throw new HttpError(422, "unsupported_currency", `${from} is not a supported currency`);
    }
    if (body?.result !== "success" || typeof body.rates !== "object" || typeof body.time_last_update_unix !== "number") {
      throw new HttpError(502, "upstream_changed", "rate source returned an unexpected shape");
    }
    table = { rates: body.rates, date: new Date(body.time_last_update_unix * 1000).toISOString().slice(0, 10), expires: Date.now() + 30 * 60_000 };
    tables.set(from, table);
  }
  const rate = from === to ? 1 : table.rates[to];
  if (typeof rate !== "number" || !(rate > 0)) {
    throw new HttpError(422, "unsupported_currency", `${to} is not a supported currency`, { supported: Object.keys(table.rates).sort() });
  }
  return { from, to, rate, date: table.date, source: ER_SOURCE, fetchedAt: new Date().toISOString() };
}

export const fxGlobal: PaidRoute = {
  id: "fx-global",
  name: "fx-global",
  category: "data",
  description:
    "Exchange rate for one currency pair across 166 currencies (including AED, SAR, PKR, NGN, VND that ECB data lacks), " +
    "from ExchangeRate-API's open feed, updated daily. Same request/answer shape as fx-rates.",
  method: "GET",
  path: "/rate",
  priceUnits: 1500n,
  inputSchema: pairInput,
  outputSchema: rateOutput,
  timeoutMs: 10_000,
  handler: (input: { from: string; to: string }, ctx) => globalRate(input.from, input.to, ctx.signal),
};

// ---------- fx-trend ----------

const FRANKFURTER = "https://api.frankfurter.dev/v1";
let ecb: { set: Set<string>; expires: number } | undefined;
const trendCache = new Map<string, { value: Trend; expires: number }>();

export interface Trend {
  from: string;
  to: string;
  rate: number;
  date: string;
  days: number;
  observations: number;
  firstDate: string;
  firstRate: number;
  min: number;
  max: number;
  mean: number;
  changePct: number;
  source: string;
  fetchedAt: string;
}

const round = (n: number, dp = 6) => Math.round(n * 10 ** dp) / 10 ** dp;

/** Statistics over a date -> rate series (sorted by date). */
export function trendStats(series: [string, number][]) {
  if (series.length === 0) throw new HttpError(502, "upstream_changed", "no observations in the window");
  const values = series.map(([, v]) => v);
  const first = series[0]!;
  const last = series[series.length - 1]!;
  return {
    observations: series.length,
    firstDate: first[0],
    firstRate: first[1],
    rate: last[1],
    date: last[0],
    min: Math.min(...values),
    max: Math.max(...values),
    mean: round(values.reduce((a, b) => a + b, 0) / values.length),
    changePct: round(((last[1] - first[1]) / first[1]) * 100, 3),
  };
}

export async function rateTrend(fromRaw: string, toRaw: string, days = 30, signal?: AbortSignal, fetchImpl?: Fetch): Promise<Trend> {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  if (!ecb || ecb.expires < Date.now()) {
    const list = await getJson(`${FRANKFURTER}/currencies`, "frankfurter.dev", signal, fetchImpl);
    ecb = { set: new Set(Object.keys(list ?? {}).filter((k) => k !== "__status")), expires: Date.now() + 24 * 3600_000 };
  }
  for (const c of [from, to]) {
    if (!ecb.set.has(c)) throw new HttpError(422, "unsupported_currency", `${c} is not an ECB reference currency (try fx-global)`, { supported: [...ecb.set].sort() });
  }
  const key = `${from}/${to}/${days}`;
  const hit = trendCache.get(key);
  if (hit && hit.expires > Date.now()) return hit.value;

  let series: [string, number][];
  if (from === to) {
    const today = new Date().toISOString().slice(0, 10);
    series = [[today, 1]];
  } else {
    const start = new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);
    const body = await getJson(`${FRANKFURTER}/${start}..?from=${from}&symbols=${to}`, "frankfurter.dev", signal, fetchImpl);
    if (!body?.rates || typeof body.rates !== "object") throw new HttpError(502, "upstream_changed", "rate source returned an unexpected shape");
    series = Object.entries(body.rates as Record<string, Record<string, number>>)
      .map(([date, r]) => [date, r[to]] as [string, number | undefined])
      .filter((e): e is [string, number] => typeof e[1] === "number" && e[1] > 0)
      .sort((a, b) => a[0].localeCompare(b[0]));
  }
  const value: Trend = { from, to, days, ...trendStats(series), source: "frankfurter.dev (ECB reference rates)", fetchedAt: new Date().toISOString() };
  trendCache.set(key, { value, expires: Date.now() + 30 * 60_000 });
  return value;
}

const currency = { type: "string", pattern: "^[A-Za-z]{3}$", description: "ISO 4217 code, e.g. GBP" };
const num = { type: "number" };

export const fxTrend: PaidRoute = {
  id: "fx-trend",
  name: "fx-trend",
  category: "data",
  description:
    "Latest ECB reference rate for a currency pair PLUS its trend over the last 7-90 days (default 30): min, max, mean, " +
    "first observation and % change. Useful to tell a buyer whether a currency is cheap or dear right now.",
  method: "GET",
  path: "/trend",
  priceUnits: 2000n,
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to"],
    properties: { from: currency, to: currency, days: { type: "integer", minimum: 7, maximum: 90, default: 30 } },
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["from", "to", "rate", "date", "days", "observations", "firstDate", "firstRate", "min", "max", "mean", "changePct", "source", "fetchedAt"],
    properties: {
      from: { type: "string", pattern: "^[A-Z]{3}$" },
      to: { type: "string", pattern: "^[A-Z]{3}$" },
      rate: { type: "number", exclusiveMinimum: 0 },
      date: { type: "string", format: "date" },
      days: { type: "integer" },
      observations: { type: "integer", minimum: 1 },
      firstDate: { type: "string", format: "date" },
      firstRate: { type: "number", exclusiveMinimum: 0 },
      min: num,
      max: num,
      mean: num,
      changePct: num,
      source: { type: "string" },
      fetchedAt: { type: "string", format: "date-time" },
    },
  },
  timeoutMs: 12_000,
  handler: (input: { from: string; to: string; days?: number }, ctx) => rateTrend(input.from, input.to, input.days ?? 30, ctx.signal),
};
