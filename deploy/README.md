# Deploying for judging (public HTTPS)

Sellers, the registry and the buyer agent must be reachable over public HTTPS for the whole judging window. Three ways to get there; **A** is the quickest and needs no domain.

| | Option | Public URLs | Needs |
|---|---|---|---|
| **A** | One tunnel → the built-in gateway | `https://<host>/registry`, `/scraper`, `/fx`, `/summary`, `/chaos`, `/buyer` | ngrok (free static domain) or cloudflared |
| **B** | Cloudflare named tunnel, one subdomain per service | `https://registry.<domain>`, `https://scraper.<domain>`, … | a domain on Cloudflare |
| **C** | A VPS with Caddy | either layout | a VPS + a domain |

The gateway (`apps/gateway`, port 8080) forwards each path prefix to its service unchanged. Every service is mounted under its prefix (taken from its `*_PUBLIC_URL`) **and** at `/`, so local tools keep working on `http://localhost:<port>`. The gateway hands each service the public `Host`. That matters because x402 builds each 402's `resource.url` from `Host`, so a buyer sees `https://<host>/scraper/scrape?page=1`, exactly the URL it called.

## A. One tunnel (recommended for the hackathon)

```bash
# 1. Point every service at its public URL (writes the *_PUBLIC_URL keys into .env)
npm run deploy:configure -- https://YOUR-NAME.ngrok-free.app

# 2. Start everything (registry, sellers, buyer agent, gateway on :8080)
npm start

# 3. Expose the gateway: pick one
ngrok http --domain=YOUR-NAME.ngrok-free.app 8080
cloudflared tunnel --url http://localhost:8080   # quick tunnel: a new URL every run, so re-run step 1 with it

# 4. Check it the way a judge will meet it
npm run deploy:check
```

`deploy:check` checks that:
- every service answers over HTTPS;
- every listing points at its public endpoint, never localhost;
- each seller's 402 names its public URL and its listed payTo;
- the public registry refuses a localhost listing;
- the public buyer API refuses calls without the token.

It also prints, and saves to `.data/deploy/public-urls.md`, the **Public URLs and wallets** table for the README.

Use a **static** hostname for judging: ngrok's free static domain or a named Cloudflare tunnel. A quick tunnel's URL changes on every restart, and listings would then point at a dead URL until you re-run step 1 and restart.

## B. Cloudflare named tunnel, subdomains

```bash
cloudflared tunnel create dronacharya
cloudflared tunnel route dns dronacharya registry.example.com     # repeat: scraper, fx, summary, chaos, buyer
cp deploy/cloudflared-config.example.yml deploy/cloudflared-config.yml   # set the tunnel id + your domain
npm run deploy:configure -- --subdomains example.com
npm start
cloudflared tunnel --config deploy/cloudflared-config.yml run dronacharya
npm run deploy:check
```

## C. VPS + Caddy

Copy `deploy/Caddyfile.example` and use either the single-hostname block (pointing at the gateway on :8080) or the subdomain blocks. Caddy obtains the certificates. Then run `deploy:configure` to match, `npm start` under a process manager (systemd, pm2 or `docker compose up -d`), and `deploy:check`.

## Docker

```bash
docker compose up --build                 # the stack; gateway on :8080, state in ./.data
docker compose --profile tunnel up        # plus a token-managed Cloudflare tunnel (CLOUDFLARE_TUNNEL_TOKEN in .env;
                                          # in the Cloudflare dashboard point the hostname at http://app:8080)
```

The image contains no secrets; `.env` is supplied at run time. *These Docker files were written for this project but could not be built on the development machine (Docker was not installed). Run `docker compose up --build` once before relying on them.*

## Judging-day checklist

- [ ] Fresh testnet wallets (`npm run wallets:new`). Fund the **buyer** with testnet USDC at <https://faucet.circle.com> (Base Sepolia); it needs no ETH.
- [ ] `GEMINI_API_KEY` set (the Hindi seller, plus the buyer's task reader and narrative).
- [ ] `npm run deploy:configure -- https://<static host>`, `npm start`, tunnel up, `npm run deploy:check` all green.
- [ ] `npm run judge`: every check PASS (the report goes to `.data/judge/`).
- [ ] Copy `.data/deploy/public-urls.md` into the README's "Public URLs and wallets" section.
- [ ] Give the judges the buyer console URL and `BUYER_API_TOKEN` (the API spends the buyer's USDC; remote calls need the token).
- [ ] Keep the machine awake and the tunnel running; `REGISTRY_ALLOW_LOOPBACK=false` (set by `deploy:configure`).

## Security notes

- **Only the buyer holds a key.** Sellers need only public payTo addresses, because the facilitator pays gas.
- **Remote calls to the buyer API always need the token.** Anything arriving through the gateway or a tunnel counts as remote even though its socket is on loopback; only direct local requests skip the token.
- **Listing hijacks are blocked.** Public registrations are insert-only, so nobody can overwrite your listings' payTo. Only the admin token (your own sellers and the judge pack) may update listings or list loopback endpoints.
- **Logs never show keys.** They redact every secret env value, Google and Anthropic API keys, bearer tokens and raw payment signatures.
