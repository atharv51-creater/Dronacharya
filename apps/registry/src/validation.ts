// Registration rules (PRD FR-REG-4). Anything that could make a buyer pay on the wrong network,
// in the wrong token, too much, or to a malformed address is rejected here, before it is listed.

import { getAddress, isAddress } from "viem";
import {
  CATEGORIES,
  MAX_PRICE_UNITS,
  NETWORK,
  USDC_ADDRESS,
  compileSchema,
  isUnitString,
  toUnits,
  type Category,
  type JsonSchema,
  type Listing,
} from "@dron/shared";

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const MAX_SCHEMA_BYTES = 32 * 1024;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

export type ValidationResult = { ok: true; listing: Listing } | { ok: false; errors: string[] };

export function validateListing(body: unknown, opts: { admin: boolean; allowLoopback: boolean }): ValidationResult {
  const errors: string[] = [];
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, errors: ["body must be a JSON object"] };
  const b = body as Record<string, unknown>;

  const id = str(b.id);
  if (!id || !SLUG.test(id)) errors.push("id must be a lowercase slug of 2-63 characters (a-z, 0-9, -)");
  const sellerId = str(b.sellerId) ?? id;
  if (!sellerId || !SLUG.test(sellerId)) errors.push("sellerId must be a lowercase slug of 2-63 characters");

  const name = str(b.name);
  if (!name || name.length > 80) errors.push("name is required (at most 80 characters)");
  const description = str(b.description);
  if (!description || description.length > 1000) errors.push("description is required (at most 1000 characters)");

  const category = str(b.category);
  if (!category || !(CATEGORIES as readonly string[]).includes(category)) errors.push(`category must be one of ${CATEGORIES.join(", ")}`);

  const method = (str(b.method) ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "POST") errors.push("method must be GET or POST");

  const endpoint = str(b.endpoint);
  const endpointError = endpoint ? checkEndpoint(endpoint, opts.allowLoopback) : "endpoint is required";
  if (endpointError) errors.push(endpointError);

  let priceUnits: bigint | undefined;
  try {
    if (b.priceUnits !== undefined) {
      const raw = typeof b.priceUnits === "number" ? String(b.priceUnits) : b.priceUnits;
      if (!isUnitString(raw)) throw new Error();
      priceUnits = BigInt(raw);
    } else if (typeof b.price === "string" || typeof b.price === "number") {
      priceUnits = toUnits(String(b.price));
    } else {
      errors.push('price is required: "priceUnits" (e.g. "5000") or "price" in USDC (e.g. "0.005")');
    }
  } catch {
    errors.push("price must be a positive amount with at most 6 decimals");
  }
  if (priceUnits !== undefined && (priceUnits <= 0n || priceUnits > MAX_PRICE_UNITS)) {
    errors.push(`price must be more than 0 and at most ${MAX_PRICE_UNITS} units (0.10 USDC)`);
  }

  const network = str(b.network) ?? NETWORK;
  if (network !== NETWORK) errors.push(`network must be ${NETWORK} (Base Sepolia); this registry is testnet-only`);
  const asset = str(b.asset) ?? USDC_ADDRESS;
  if (asset.toLowerCase() !== USDC_ADDRESS.toLowerCase()) errors.push(`asset must be Base Sepolia USDC (${USDC_ADDRESS})`);

  const payTo = str(b.payTo);
  if (!payTo || !isAddress(payTo, { strict: false })) errors.push("payTo must be a valid EVM address");

  const inputSchema = checkSchema("inputSchema", b.inputSchema, errors);
  const outputSchema = checkSchema("outputSchema", b.outputSchema, errors);

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    listing: {
      id: id!,
      sellerId: sellerId!,
      name: name!,
      category: category as Category,
      description: description!,
      endpoint: endpoint!,
      method: method as Listing["method"],
      priceUnits: priceUnits!.toString(),
      network: NETWORK,
      asset: USDC_ADDRESS,
      payTo: getAddress(payTo!),
      inputSchema: inputSchema!,
      outputSchema: outputSchema!,
      // Only our own (admin) registrations may hide themselves as fixtures.
      ...(opts.admin && b.isFixture === true ? { isFixture: true } : {}),
    },
  };
}

function checkEndpoint(raw: string, allowLoopback: boolean): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "endpoint must be an absolute URL";
  }
  if (raw.length > 500) return "endpoint is too long";
  if (url.username || url.password) return "endpoint must not contain credentials";
  if (url.protocol === "https:") return undefined;
  if (url.protocol === "http:" && allowLoopback && LOOPBACK.has(url.hostname)) return undefined;
  return "endpoint must use https (http is only accepted for localhost in development)";
}

function checkSchema(field: string, value: unknown, errors: string[]): JsonSchema | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    errors.push(`${field} must be a JSON Schema object`);
    return undefined;
  }
  if (JSON.stringify(value).length > MAX_SCHEMA_BYTES) {
    errors.push(`${field} is larger than ${MAX_SCHEMA_BYTES / 1024} KB`);
    return undefined;
  }
  try {
    compileSchema(value as JsonSchema);
  } catch (err) {
    errors.push(`${field} is not a valid JSON Schema: ${(err as Error).message}`);
    return undefined;
  }
  return value as JsonSchema;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
