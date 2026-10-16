// Structured logger with secret redaction. Every line passes through redact(), so a key that
// reaches a log call by mistake still never reaches the terminal or a log file.

import { bigintReplacer } from "./units.ts";

const SECRET_ENV = /(PRIVATE_KEY|API_KEY|SECRET|TOKEN|PASSWORD)/i;
// A 65-byte ECDSA signature (an EIP-3009 authorisation is replayable until used: treat it as a secret).
const SIGNATURE_RE = /0x[0-9a-fA-F]{130}\b/g;
// Google API keys (Gemini) and, in case one is ever pasted in, Anthropic keys.
const GOOGLE_KEY_RE = /AIza[0-9A-Za-z_-]{35}/g;
const ANTHROPIC_KEY_RE = /sk-ant-[A-Za-z0-9_-]{10,}/g;
const BEARER_RE = /(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/gi;

let secretValues: string[] | undefined;

function knownSecrets(): string[] {
  secretValues ??= Object.entries(process.env)
    .filter(([name, value]) => SECRET_ENV.test(name) && value && value.length >= 8)
    .map(([, value]) => value!.trim());
  return secretValues;
}

export function redact(text: string): string {
  let out = text;
  for (const secret of knownSecrets()) out = out.split(secret).join("[redacted]");
  return out
    .replace(SIGNATURE_RE, "0x[signature redacted]")
    .replace(GOOGLE_KEY_RE, "[redacted]")
    .replace(ANTHROPIC_KEY_RE, "[redacted]")
    .replace(BEARER_RE, "$1[redacted]");
}

type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export function createLogger(service: string): Logger {
  const min = ORDER[(process.env.LOG_LEVEL as Level) ?? "info"] ?? ORDER.info;
  const write = (level: Level, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[level] < min) return;
    const extra = fields && Object.keys(fields).length ? " " + JSON.stringify(fields, errorAwareReplacer) : "";
    const line = redact(`${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${service}] ${msg}${extra}`);
    (level === "error" || level === "warn" ? process.stderr : process.stdout).write(line + "\n");
  };
  return {
    debug: (m, f) => write("debug", m, f),
    info: (m, f) => write("info", m, f),
    warn: (m, f) => write("warn", m, f),
    error: (m, f) => write("error", m, f),
  };
}

function errorAwareReplacer(key: string, value: unknown) {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return bigintReplacer(key, value);
}
