// Currency rates from Frankfurter (European Central Bank reference rates; free, no API key).
// Rates are cached for 30 minutes per pair; an unsupported currency is a 422, so it is never charged.

import { HttpError } from "@dron/shared";

const API = "https://api.frankfurter.dev/v1";
const RATE_TTL_MS = 30 * 60_000;
const CURRENCY_TTL_MS = 24 * 3600_000;

export interface Rate {
  from: string;
  to: string;
  rate: number;
  date: string;
  source: string;
  fetchedAt: string;
}

const rateCache = new Map<string, { value: Rate; expires: number }>();
let currencies: { set: Set<string>; expires: number } | undefined;

async function getJson(url: string, signal?: AbortSignal): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { headers: { accept: "application/json" }, signal });
  } catch {
    throw new HttpError(502, "upstream_unreachable", "rate source unreachable");
  }
  if (!res.ok) throw new HttpError(502, "upstream_error", `rate source answered ${res.status}`);
  return res.json();
}

async function supportedCurrencies(signal?: AbortSignal): Promise<Set<string>> {
  if (currencies && currencies.expires > Date.now()) return currencies.set;
  const body = (await getJson(`${API}/currencies`, signal)) as Record<string, string>;
  const set = new Set(Object.keys(body).map((c) => c.toUpperCase()));
  if (set.size === 0) throw new HttpError(502, "upstream_changed", "empty currency list");
  currencies = { set, expires: Date.now() + CURRENCY_TTL_MS };
  return set;
}

export async function getRate(fromRaw: string, toRaw: string, signal?: AbortSignal): Promise<Rate> {
  const from = fromRaw.toUpperCase();
  const to = toRaw.toUpperCase();
  const supported = await supportedCurrencies(signal);
  for (const code of [from, to]) {
    if (!supported.has(code)) {
      throw new HttpError(422, "unsupported_currency", `${code} is not an ECB reference currency`, { supported: [...supported].sort() });
    }
  }

  const key = `${from}/${to}`;
  const cached = rateCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.value;

  let rate: number;
  let date: string;
  if (from === to) {
    rate = 1;
    date = new Date().toISOString().slice(0, 10);
  } else {
    const body = (await getJson(`${API}/latest?from=${from}&symbols=${to}`, signal)) as { date?: string; rates?: Record<string, number> };
    const value = body.rates?.[to];
    if (typeof value !== "number" || !(value > 0) || typeof body.date !== "string") {
      throw new HttpError(502, "upstream_changed", "rate source returned an unexpected shape");
    }
    rate = value;
    date = body.date;
  }

  const value: Rate = { from, to, rate, date, source: "frankfurter.dev (ECB reference rates)", fetchedAt: new Date().toISOString() };
  rateCache.set(key, { value, expires: Date.now() + RATE_TTL_MS });
  return value;
}
