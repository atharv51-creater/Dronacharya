// Small .env editor: sets keys in place (keeping comments and order) and appends missing ones.

import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { REPO_ROOT } from "@dron/shared";

export const ENV_PATH = `${REPO_ROOT}.env`;

export function setEnvValues(values: Record<string, string>): void {
  const lines = existsSync(ENV_PATH) ? readFileSync(ENV_PATH, "utf8").split("\n") : [];
  const seen = new Set<string>();
  const out = lines.map((line) => {
    const m = /^([A-Z0-9_]+)=/.exec(line);
    if (m && m[1]! in values) {
      seen.add(m[1]!);
      return `${m[1]}=${values[m[1]!]}`;
    }
    return line;
  });
  for (const [k, v] of Object.entries(values)) if (!seen.has(k)) out.push(`${k}=${v}`);
  writeFileSync(ENV_PATH, out.join("\n"), { mode: 0o600 });
  chmodSync(ENV_PATH, 0o600);
}
