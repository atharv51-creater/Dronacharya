import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getAddress, isAddress } from "viem";
import type { Address } from "./types.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let loaded = false;

/**
 * Loads the repo-root .env once. Variables already present in the process environment win,
 * so a deploy can override any value without editing the file.
 */
export function loadEnv(): void {
  if (loaded) return;
  loaded = true;
  const file = `${REPO_ROOT}.env`;
  if (existsSync(file)) process.loadEnvFile(file);
}

export function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : fallback;
}

export function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`missing required environment variable ${name} (see .env.example)`);
  return value;
}

export function envInt(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} must be an integer, got ${JSON.stringify(raw)}`);
  return value;
}

export function envBool(name: string, fallback: boolean): boolean {
  const raw = env(name);
  if (raw === undefined) return fallback;
  return ["1", "true", "yes", "on"].includes(raw.toLowerCase());
}

/** Reads a public address and returns it checksummed. */
export function requireAddress(name: string): Address {
  const value = requireEnv(name);
  if (!isAddress(value, { strict: false })) throw new Error(`${name} is not a valid EVM address`);
  return getAddress(value);
}
