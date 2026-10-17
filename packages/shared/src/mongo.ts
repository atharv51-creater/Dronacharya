// MongoDB Atlas connection, shared by the services that persist to it (registry, buyer agent).
// MONGODB_URI is a secret (it carries the password): it is read here only and never logged; error
// messages are scrubbed of credentials. MONGODB_DB picks the database (default "dronacharya"); use one
// database per deployment, because each registry treats its database as its own copy.

import { MongoClient, type Db } from "mongodb";
import { env } from "./env.ts";

let client: MongoClient | undefined;
let connecting: Promise<MongoClient> | undefined;

export function mongoConfigured(): boolean {
  return Boolean(env("MONGODB_URI"));
}

export function mongoDbName(): string {
  return env("MONGODB_DB", "dronacharya")!;
}

/** Removes user:password@ from anything that might echo the URI. */
export function scrubMongoError(err: unknown): string {
  return String((err as Error)?.message ?? err).replace(/mongodb(\+srv)?:\/\/[^@\s]+@/gi, "mongodb$1://***@").slice(0, 300);
}

/** The shared database handle; connects on first use and retries on the next call after a failure. */
export async function mongoDb(name = mongoDbName()): Promise<Db> {
  const uri = env("MONGODB_URI");
  if (!uri) throw new Error("MONGODB_URI is not set");
  if (!client) {
    connecting ??= new MongoClient(uri, { appName: "dronacharya", serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000, retryWrites: true })
      .connect()
      .then((c) => (client = c))
      .finally(() => (connecting = undefined));
    try {
      await connecting;
    } catch (err) {
      throw new Error(`MongoDB connection failed: ${scrubMongoError(err)}`);
    }
  }
  return client!.db(name);
}

export async function closeMongo(): Promise<void> {
  const c = client;
  client = undefined;
  await c?.close().catch(() => {});
}
