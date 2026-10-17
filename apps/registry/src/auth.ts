// Google sign-in sessions and wallet-proven seller registration, for the web UI.
//
//   POST /api/auth/google            { idToken }  -> { ok, token, user }   (audience = GOOGLE_CLIENT_ID; refuses all if unset)
//   GET  /api/auth/session           Bearer <token> -> { authenticated, user? }
//   POST /api/auth/logout
//   POST /api/auth/wallet-challenge  { serviceId, payTo } -> { message, expiresAt }   (session required, 10 min, one use)
//   POST /api/sellers/register       { listing, message, signature }                (session required)
//
// Sessions are random tokens held in memory for 12 hours. canRunScout comes from SCOUT_ALLOWED_EMAILS and
// isAdmin from ADMIN_EMAILS (both empty by default). The gateway asks /api/auth/session before letting a
// session spend the buyer's wallet; this module never spends anything itself.

import { randomBytes } from "node:crypto";
import express, { type Request, type Response } from "express";
import { OAuth2Client } from "google-auth-library";
import { getAddress, isAddress, type Hex } from "viem";
import { CHAIN_ID, env, type Logger } from "@dron/shared";
import { publicClient } from "@dron/x402-kit";
import type { ServiceStore } from "./db.ts";
import { validateListing } from "./validation.ts";

const SESSION_MS = 12 * 3600_000;
const CHALLENGE_MS = 10 * 60_000;

export interface SessionUser {
  email: string;
  name?: string;
  picture?: string;
  canRunScout: boolean;
  isAdmin: boolean;
}

const list = (name: string) =>
  new Set((env(name) ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));

export function createAuthRouter(opts: { store: ServiceStore; log: Logger; verifyIdToken?: (idToken: string, audience: string) => Promise<Record<string, unknown> | undefined>; verifySignature?: (address: Hex, message: string, signature: Hex) => Promise<boolean> }) {
  const { store, log } = opts;
  const sessions = new Map<string, { user: SessionUser; expires: number }>();
  const challenges = new Map<string, { email: string; serviceId: string; payTo: string; expires: number }>();
  const google = new OAuth2Client();
  const verifyIdToken =
    opts.verifyIdToken ??
    (async (idToken: string, audience: string) => (await google.verifyIdToken({ idToken, audience })).getPayload() as Record<string, unknown> | undefined);
  const verifySignature =
    opts.verifySignature ?? ((address: Hex, message: string, signature: Hex) => publicClient().verifyMessage({ address, message, signature }));

  const sweep = () => {
    const now = Date.now();
    for (const [k, v] of sessions) if (v.expires < now) sessions.delete(k);
    for (const [k, v] of challenges) if (v.expires < now) challenges.delete(k);
  };
  const sessionOf = (req: Request) => {
    sweep();
    const h = req.get("authorization") ?? "";
    return h.startsWith("Bearer ") ? sessions.get(h.slice(7).trim()) : undefined;
  };
  const needSession = (req: Request, res: Response) => {
    const s = sessionOf(req);
    if (!s) res.status(401).json({ error: "unauthorised", message: "Sign in with Google to continue" });
    return s;
  };

  const r = express.Router();

  r.post("/api/auth/google", async (req, res) => {
    const clientId = env("GOOGLE_CLIENT_ID");
    if (!clientId) {
      res.status(503).json({ error: "signin_not_configured", message: "Google sign-in is not configured on this server" });
      return;
    }
    const idToken = (req.body as { idToken?: unknown })?.idToken;
    if (typeof idToken !== "string" || idToken.length < 20) {
      res.status(400).json({ error: "invalid_request", message: "idToken required" });
      return;
    }
    let payload: Record<string, unknown> | undefined;
    try {
      payload = await verifyIdToken(idToken, clientId);
    } catch {
      payload = undefined;
    }
    const email = typeof payload?.email === "string" ? payload.email.toLowerCase() : "";
    if (!payload || !email || payload.email_verified !== true) {
      res.status(401).json({ error: "invalid_token", message: "Google sign-in could not be verified" });
      return;
    }
    const user: SessionUser = {
      email,
      name: typeof payload.name === "string" ? payload.name : undefined,
      picture: typeof payload.picture === "string" ? payload.picture : undefined,
      canRunScout: list("SCOUT_ALLOWED_EMAILS").has(email),
      isAdmin: list("ADMIN_EMAILS").has(email),
    };
    const token = randomBytes(32).toString("base64url");
    sessions.set(token, { user, expires: Date.now() + SESSION_MS });
    log.info("signed in", { canRunScout: user.canRunScout, isAdmin: user.isAdmin });
    res.json({ ok: true, token, user, expiresAt: new Date(Date.now() + SESSION_MS).toISOString() });
  });

  r.get("/api/auth/session", (req, res) => {
    const s = sessionOf(req);
    res.json(s ? { authenticated: true, user: s.user, expiresAt: new Date(s.expires).toISOString() } : { authenticated: false });
  });

  r.post("/api/auth/logout", (req, res) => {
    const h = req.get("authorization") ?? "";
    if (h.startsWith("Bearer ")) sessions.delete(h.slice(7).trim());
    res.json({ ok: true });
  });

  r.post("/api/auth/wallet-challenge", (req, res) => {
    const s = needSession(req, res);
    if (!s) return;
    const { serviceId, payTo } = (req.body ?? {}) as { serviceId?: unknown; payTo?: unknown };
    if (typeof serviceId !== "string" || !/^[a-z0-9][a-z0-9-]{1,62}$/.test(serviceId)) {
      res.status(400).json({ error: "invalid_request", message: "serviceId must be a lowercase slug" });
      return;
    }
    if (typeof payTo !== "string" || !isAddress(payTo, { strict: false })) {
      res.status(400).json({ error: "invalid_request", message: "payTo must be an EVM address" });
      return;
    }
    const wallet = getAddress(payTo);
    const issued = new Date().toISOString();
    const message = [
      "Dronacharya seller registration",
      `Service: ${serviceId}`,
      `Wallet: ${wallet}`,
      `Email: ${s.user.email}`,
      `Chain: ${CHAIN_ID}`,
      `Nonce: ${randomBytes(16).toString("hex")}`,
      `Issued: ${issued}`,
    ].join("\n");
    challenges.set(message, { email: s.user.email, serviceId, payTo: wallet, expires: Date.now() + CHALLENGE_MS });
    res.json({ message, expiresAt: new Date(Date.now() + CHALLENGE_MS).toISOString() });
  });

  r.post("/api/sellers/register", async (req, res) => {
    const s = needSession(req, res);
    if (!s) return;
    const { listing, message, signature } = (req.body ?? {}) as { listing?: Record<string, unknown>; message?: unknown; signature?: unknown };
    if (typeof message !== "string" || typeof signature !== "string" || !/^0x[0-9a-fA-F]+$/.test(signature)) {
      res.status(400).json({ error: "invalid_request", message: "message and signature are required" });
      return;
    }
    const challenge = challenges.get(message);
    challenges.delete(message); // one use, whatever happens next
    if (!challenge || challenge.expires < Date.now() || challenge.email !== s.user.email) {
      res.status(401).json({ error: "invalid_challenge", message: "Challenge expired, already used, or not yours: request a new one" });
      return;
    }
    if (!listing || listing.id !== challenge.serviceId || typeof listing.payTo !== "string" || !isAddress(listing.payTo, { strict: false }) || getAddress(listing.payTo) !== challenge.payTo) {
      res.status(400).json({ error: "challenge_mismatch", message: "listing id and payTo must match the signed challenge" });
      return;
    }
    let valid = false;
    try {
      valid = await verifySignature(challenge.payTo as Hex, message, signature as Hex);
    } catch {
      valid = false;
    }
    if (!valid) {
      res.status(401).json({ error: "bad_signature", message: "The signature does not prove control of the payTo wallet" });
      return;
    }
    const result = validateListing(listing, { admin: false, allowLoopback: false });
    if (!result.ok) {
      res.status(400).json({ error: "invalid_listing", details: result.errors });
      return;
    }
    if (store.save(result.listing, "public", false) === "conflict") {
      res.status(409).json({ error: "id_taken", message: `a service with id "${result.listing.id}" already exists` });
      return;
    }
    log.info("seller registered with wallet proof", { id: result.listing.id, payTo: result.listing.payTo });
    res.status(201).json({ ok: true, service: store.get(result.listing.id)!.listing, walletProof: { verified: true, address: challenge.payTo, timestamp: Date.now() } });
  });

  return r;
}
