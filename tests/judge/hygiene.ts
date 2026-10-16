// Key hygiene, the way a judge checks it: the repository and its whole git history, the web bundle
// served to browsers, and the logs. Uses gitleaks when installed; always also runs an exact-value scan for
// every secret this deployment actually holds (a generic scanner cannot know those).

import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { REPO_ROOT } from "@dron/shared";

export interface HygieneFinding {
  where: string;
  what: string;
}

export interface HygieneReport {
  ok: boolean;
  gitleaks: "passed" | "failed" | "not installed";
  scanned: { historyCommits: number; files: number; bundleFiles: number; logFiles: number };
  findings: HygieneFinding[];
}

const PATTERNS: [RegExp, string][] = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "PEM private key"],
  [/AIza[0-9A-Za-z_-]{35}/, "Google API key"],
  [/sk-ant-[A-Za-z0-9_-]{20,}/, "Anthropic API key"],
  [/(?:PRIVATE_KEY|privateKey|private_key)["']?\s*[:=]\s*["']?0x[0-9a-fA-F]{64}/, "private key assignment"],
];

/** Secret values this deployment holds (from .env and .secrets/). */
export function knownSecretValues(): { name: string; value: string }[] {
  const out: { name: string; value: string }[] = [];
  const envFile = join(REPO_ROOT, ".env");
  if (existsSync(envFile)) {
    for (const line of readFileSync(envFile, "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.+)$/.exec(line.trim());
      if (m && /(PRIVATE_KEY|API_KEY|TOKEN|SECRET|PASSWORD)/.test(m[1]!) && m[2]!.trim().length >= 8) out.push({ name: m[1]!, value: m[2]!.trim() });
    }
  }
  const sellerKeys = join(REPO_ROOT, ".secrets/seller-keys.json");
  if (existsSync(sellerKeys)) {
    for (const [name, v] of Object.entries(JSON.parse(readFileSync(sellerKeys, "utf8")) as Record<string, { privateKey: string }>)) {
      out.push({ name: `${name} private key`, value: v.privateKey });
    }
  }
  return out;
}

function walk(dir: string, filter: (path: string) => boolean): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== "node_modules" && name !== ".git") out.push(...walk(p, filter));
    } else if (filter(p) && st.size < 5_000_000) out.push(p);
  }
  return out;
}

export function scanHygiene(opts: { logFiles?: string[] } = {}): HygieneReport {
  const findings: HygieneFinding[] = [];
  const secrets = knownSecretValues();
  const scanText = (where: string, text: string, patterns: boolean) => {
    for (const s of secrets) {
      if (text.includes(s.value)) findings.push({ where, what: `contains the value of ${s.name}` });
    }
    if (patterns) for (const [re, label] of PATTERNS) if (re.test(text)) findings.push({ where, what: label });
  };

  // 1. gitleaks (repo + history), if available.
  let gitleaks: HygieneReport["gitleaks"] = "not installed";
  if (spawnSync("gitleaks", ["version"], { stdio: "ignore" }).status === 0) {
    const run = spawnSync("gitleaks", ["git", "--redact", "--no-banner", "--exit-code", "1", REPO_ROOT], { encoding: "utf8" });
    gitleaks = run.status === 0 ? "passed" : "failed";
    if (run.status !== 0) findings.push({ where: "gitleaks git", what: (run.stdout + run.stderr).trim().slice(0, 500) });
  }

  // 2. Whole git history (every commit's diff).
  let historyCommits = 0;
  try {
    historyCommits = Number(execFileSync("git", ["-C", REPO_ROOT, "rev-list", "--all", "--count"], { encoding: "utf8" }).trim()) || 0;
    if (historyCommits > 0) scanText("git history", execFileSync("git", ["-C", REPO_ROOT, "log", "-p", "--all", "--no-color"], { encoding: "utf8", maxBuffer: 512 * 1024 * 1024 }), true);
  } catch {
    historyCommits = 0;
  }

  // 3. Every file git would commit (tracked + untracked-but-not-ignored).
  const files = execFileSync("git", ["-C", REPO_ROOT, "ls-files", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean)
    .filter((f) => f !== ".env.example" && f !== "package-lock.json");
  for (const f of files) {
    const p = join(REPO_ROOT, f);
    if (!existsSync(p) || statSync(p).size > 5_000_000) continue;
    scanText(f, readFileSync(p, "utf8"), !f.startsWith("tests/"));
  }

  // 4. The web bundle: everything served to browsers.
  const bundle = [...walk(join(REPO_ROOT, "apps"), (p) => p.includes(`${"/"}public${"/"}`)), ...walk(join(REPO_ROOT, "apps/web/dist"), () => true)];
  for (const p of bundle) scanText(`bundle: ${relative(REPO_ROOT, p)}`, readFileSync(p, "utf8"), true);

  // 5. Logs and local records (exact secret values only: tx hashes look like keys).
  const logs = [...walk(join(REPO_ROOT, ".data"), (p) => /\.(jsonl|json|log)$/.test(p)), ...(opts.logFiles ?? []).filter(existsSync)];
  for (const p of logs) {
    const text = readFileSync(p, "utf8");
    for (const s of secrets) if (text.includes(s.value)) findings.push({ where: `log: ${relative(REPO_ROOT, p)}`, what: `contains the value of ${s.name}` });
    if (/0x[0-9a-fA-F]{130}\b/.test(text)) findings.push({ where: `log: ${relative(REPO_ROOT, p)}`, what: "contains a raw payment signature" });
  }

  return { ok: findings.length === 0, gitleaks, scanned: { historyCommits, files: files.length, bundleFiles: bundle.length, logFiles: logs.length }, findings };
}
