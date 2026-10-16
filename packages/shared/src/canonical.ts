// Deterministic JSON (sorted keys, no whitespace) so a buyer and the registry sign and verify the
// exact same bytes for a ledger row, whatever order the fields were built in.

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "bigint") return JSON.stringify(value.toString());
    if (typeof value === "number" && !Number.isFinite(value)) throw new TypeError("non-finite number in canonical JSON");
    return JSON.stringify(value ?? null);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** Domain-separated messages so a ledger signature can never be replayed as another kind of message. */
export const ledgerMessage = (row: unknown) => `dronacharya/ledger-row/v1\n${canonicalJson(row)}`;
export const sessionMessage = (session: unknown) => `dronacharya/session/v1\n${canonicalJson(session)}`;
