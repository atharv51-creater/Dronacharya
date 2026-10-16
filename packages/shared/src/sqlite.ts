// node:sqlite is built in from Node 22.13, but prints an ExperimentalWarning on first load.
// Filter that single warning so service logs stay clean; every other warning still prints.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const originalEmit = process.emitWarning;
process.emitWarning = function (warning: string | Error, ...rest: unknown[]) {
  const text = typeof warning === "string" ? warning : warning.message;
  if (text.includes("SQLite is an experimental feature")) return;
  return (originalEmit as (...args: unknown[]) => void).call(process, warning, ...rest);
} as typeof process.emitWarning;

const { DatabaseSync } = await import("node:sqlite");
process.emitWarning = originalEmit;

export type Database = InstanceType<typeof DatabaseSync>;

/** Opens (and creates) a SQLite file with sane defaults for a small single-process service. */
export function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  return db;
}
