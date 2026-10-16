// The price check. A 402 may offer several payment options ("accepts"). We keep only the ones that
// agree exactly with the registry listing and refuse the call if none survives. Nothing is signed for
// a refused call, so a seller that asks too much, or names another token, network or payTo, gets
// nothing: not even a signature it could try to settle.

import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import { isUnitString, type Listing, type ReasonCode } from "@dron/shared";

/** An authorisation that stays valid longer than this is an unreasonable exposure for a single call. */
export const MAX_ACCEPTED_TIMEOUT_SECONDS = 3600;

export interface AcceptVerdict {
  accept: PaymentRequirements;
  ok: boolean;
  problems: { code: ReasonCode; message: string }[];
}

export type PriceCheck =
  | { ok: true; chosen: PaymentRequirements; verdicts: AcceptVerdict[] }
  | { ok: false; code: ReasonCode; reason: string; askedUnits: string | null; verdicts: AcceptVerdict[] };

// Order matters when explaining a refusal: the most important mismatch is reported first.
const PRIORITY: ReasonCode[] = [
  "version_unsupported",
  "network_mismatch",
  "asset_mismatch",
  "payto_mismatch",
  "price_above_listing",
  "scheme_unsupported",
  "unreasonable_timeout",
  "bad_402",
];

export function checkPaymentRequired(required: PaymentRequired, listing: Listing): PriceCheck {
  if (required.x402Version !== 2) {
    return { ok: false, code: "version_unsupported", reason: `402 uses x402 version ${required.x402Version}; only v2 is accepted`, askedUnits: null, verdicts: [] };
  }
  const accepts = Array.isArray(required.accepts) ? required.accepts : [];
  if (accepts.length === 0) {
    return { ok: false, code: "bad_402", reason: "402 lists no payment options", askedUnits: null, verdicts: [] };
  }

  const listed = BigInt(listing.priceUnits);
  const verdicts = accepts.map((accept) => judge(accept, listing, listed));
  const good = verdicts.filter((v) => v.ok);
  if (good.length > 0) {
    // Several valid options: pay the least.
    const chosen = good.map((v) => v.accept).sort((a, b) => (BigInt(a.amount) < BigInt(b.amount) ? -1 : 1))[0]!;
    return { ok: true, chosen, verdicts };
  }

  // Explain using the option that is "closest" (fewest problems), and its most important problem.
  const closest = [...verdicts].sort((a, b) => a.problems.length - b.problems.length)[0]!;
  const top = [...closest.problems].sort((a, b) => PRIORITY.indexOf(a.code) - PRIORITY.indexOf(b.code))[0]!;
  const extra = accepts.length > 1 ? ` (none of the ${accepts.length} offered options matched the listing)` : "";
  return {
    ok: false,
    code: top.code,
    reason: `${top.message}${extra}`,
    askedUnits: isUnitString(closest.accept.amount) ? closest.accept.amount : null,
    verdicts,
  };
}

function judge(accept: PaymentRequirements, listing: Listing, listed: bigint): AcceptVerdict {
  const problems: AcceptVerdict["problems"] = [];
  const add = (code: ReasonCode, message: string) => problems.push({ code, message });

  if (!accept || typeof accept !== "object") {
    return { accept, ok: false, problems: [{ code: "bad_402", message: "malformed payment option" }] };
  }
  if (accept.scheme !== "exact") add("scheme_unsupported", `scheme "${accept.scheme}" is not supported (only "exact")`);
  if (accept.network !== listing.network) add("network_mismatch", `402 asks for network ${accept.network}; the listing says ${listing.network}`);
  if (typeof accept.asset !== "string" || accept.asset.toLowerCase() !== listing.asset.toLowerCase()) {
    add("asset_mismatch", `402 asks for token ${accept.asset}; the listing says ${listing.asset}`);
  }
  if (typeof accept.payTo !== "string" || accept.payTo.toLowerCase() !== listing.payTo.toLowerCase()) {
    add("payto_mismatch", `402 names payTo ${accept.payTo}; the listing's payTo is ${listing.payTo}`);
  }
  if (!isUnitString(accept.amount) || BigInt(accept.amount) === 0n) {
    add("bad_402", `402 amount ${JSON.stringify(accept.amount)} is not a positive integer`);
  } else if (BigInt(accept.amount) > listed) {
    const amount = BigInt(accept.amount);
    const ratio = listed > 0n ? Number((amount * 100n) / listed) / 100 : Infinity;
    add("price_above_listing", `402 asks ${accept.amount} units, ${ratio}x the listed ${listing.priceUnits}`);
  }
  if (!Number.isInteger(accept.maxTimeoutSeconds) || accept.maxTimeoutSeconds <= 0 || accept.maxTimeoutSeconds > MAX_ACCEPTED_TIMEOUT_SECONDS) {
    add("unreasonable_timeout", `authorisation window of ${accept.maxTimeoutSeconds}s is outside 1-${MAX_ACCEPTED_TIMEOUT_SECONDS}s`);
  }
  return { accept, ok: problems.length === 0, problems };
}

/** Stable fingerprint of a payment option, used to approve exactly one option for signing. */
export function fingerprint(r: Pick<PaymentRequirements, "scheme" | "network" | "asset" | "payTo" | "amount" | "maxTimeoutSeconds">): string {
  return [r.scheme, r.network, String(r.asset).toLowerCase(), String(r.payTo).toLowerCase(), r.amount, r.maxTimeoutSeconds].join("|");
}
