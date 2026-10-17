# Dronacharya frontend

The user interface for Dronacharya, the pay-per-call agent economy: Overview, Agent Arena, Scout Console, Marketplace (registry), Transactions (ledger), Reconciliation and Wallets. React 19, TypeScript, Vite and Tailwind CSS 4.

This folder contains **only the frontend**. It talks to the Dronacharya backend (registry, buyer agent, sellers) over HTTP and holds no keys or secrets.

## Where to put it in your repo

Add this folder to your existing backend repo as `frontend/`:

```
your-repo/
├── apps/            (backend, already in GitHub)
├── packages/        (backend, already in GitHub)
├── frontend/        <- this folder
└── package.json     (backend root; leave it unchanged)
```

It has its own `package.json`, so it does not touch the backend's workspaces or root config.

> If your GitHub repo already contains a root-level `src/`, `index.html` and `vite.config.ts` from AI Studio, they are the same UI as this folder. Keep one copy, not both.

## Run it

```bash
cd frontend
cp .env.example .env.local
npm install
npm run dev          # http://localhost:5173
```

Start the backend first. The dev server forwards `/api/...` to it:

- **Separate services** (`npm run start:all` in the repo root): leave `DEV_API_TARGET` empty. `/api/tasks/*` goes to the buyer on port 4200 and every other `/api/*` goes to the registry on port 4000.
- **Unified server** (`server.ts` on port 3000): set `DEV_API_TARGET=http://localhost:3000`.

Other commands:

```bash
npm run typecheck    # tsc
npm run build        # production build into dist/
npm run preview      # serve dist/ locally
```

## Environment variables

| Variable | Reaches the browser? | Purpose |
|---|---|---|
| `VITE_API_BASE_URL` | Yes | Backend URL for API calls. Empty means same origin (dev proxy, or backend serving `dist/`). |
| `VITE_GOOGLE_CLIENT_ID` | Yes | Google OAuth client ID. Public by design. |
| `DEV_API_TARGET`, `DEV_REGISTRY_URL`, `DEV_BUYER_URL` | No | Dev proxy targets, read only by `vite.config.ts`. |

Never put private keys, `BUYER_API_TOKEN`, `REGISTRY_ADMIN_TOKEN` or `GEMINI_API_KEY` in this folder. Anything starting with `VITE_` is shipped to every visitor.

## Backend endpoints this UI calls

All calls go through `src/api/client.ts`.

| Endpoint | Served by |
|---|---|
| `GET /api/meta` | registry or unified server (buyer address and example tasks come from the unified server) |
| `GET /api/services`, `GET /api/services/:id`, `POST /api/services` | registry |
| `GET /api/ledger`, `GET /api/ledger/stream` (SSE), `GET /api/ledger/reconcile` | registry |
| `GET /api/sessions`, `GET /api/wallets` | registry |
| `GET/POST /api/tasks`, `GET /api/tasks/:id`, `GET /api/tasks/:id/events` (SSE), `POST /api/tasks/:id/start`, `/topup`, `/cancel` | buyer agent |
| `POST /api/auth/google`, `GET /api/auth/session`, `POST /api/auth/logout`, `POST /api/auth/demo` | **only the AI Studio `server.ts`** |
| `POST /api/sellers/register` | **only the AI Studio `server.ts`** |

The last two rows do not exist in the standalone backend apps. Without the AI Studio `server.ts` (or equivalent routes), Google sign-in, wallet-proof registration and running Scout from the UI will fail.

## Known issues to fix before judging

These come from the AI Studio version this was extracted from and are left unchanged here:

1. **Automatic demo login.** `src/api/client.ts` calls `POST /api/auth/demo` before any authenticated POST. If the backend has that route, every visitor gets a session that can spend the buyer wallet. Remove the route on the backend and the auto-call here.
2. **Throwaway wallet proof.** `generateProof` in `src/components/MarketplaceView.tsx` creates a random wallet in the browser, signs with it and sets it as `payTo`, then discards the key. The proof is meaningless and payments to that seller go to an address nobody controls. Replace it with a server challenge signed by the user's own wallet.
3. **Scripted Agent Arena.** `src/components/AgentArena.tsx` plays a fixed script with realistic-looking but fake transaction hashes, not real events, and is not labelled as simulated. Drive it from `GET /api/tasks/:id/events` and label any sample data as "Simulated — not on chain".
4. **Fallback Google client ID.** `src/components/Header.tsx` uses `"demo-client-id"` when `VITE_GOOGLE_CLIENT_ID` is missing. Hide the sign-in button instead.
