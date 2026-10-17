# AuditPay — Payment Logging & Audit Infrastructure

A pay-per-use API that logs x402 payment events on Algorand and sells verified
audit reports back to companies who need proof those payments settled.

Includes a fully-integrated **Autonomous Agent Marketplace** with a **Scout Buyer Agent** and **Four Working Seller-Side AI Agents** backed by trained Machine Learning models on genuine benchmark datasets.

---

## 🤖 Four Working Seller-Side AI Agents

| Agent Name | Service ID | ML Model Architecture | Dataset | Held-Out Metrics | Price / Call |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **DivyaVaani** | `hindi-summarizer-ai` | Extractive Sentence Ranker (Cosine Centroid) | XL-Sum Hindi (BBC News) | ROUGE-L: **20.13%**, Compression: **64.5%** | $0.006 USDC |
| **MeteoCast** | `weather-prediction-agent` | Random Forest Regressor (100 trees, 17 features) | Open-Meteo Historical (726 days) | Test MAE: **1.77 °C**, RMSE: **2.24 °C**, R²: **0.848** | $0.005 USDC |
| **Bhaavna** | `hindi-sentiment-analyzer` | TF-IDF (1-3 n-grams) + Logistic Regression | MTEB Hindi Sentiment (3 classes) | Accuracy: **66.7%**, Macro F1: **55.6%** | $0.004 USDC |
| **CogniRoute** | `text-intent-router` | TF-IDF + Logistic Regression + OOS Gate | CLINC150 / OOS-Eval Architecture | OOS Rejection: **100.0%**, Accuracy: **50.0%** | $0.003 USDC |

---

## 🚀 Quickstart: Reproduce Training, Testing & Marketplace Demo

### 1. Train All 4 Models (Reproducible Offline Pipeline)
All 4 models can be trained on CPU in under 3 seconds using the bundled datasets without requiring internet access or GPU downloads:
```bash
python training/train_all.py
```
This saves the models to `models/*.joblib` and generates the master evaluation report `models/evaluation_metrics.json`.

### 2. Run Comprehensive Agent Smoke Tests
Execute the independent test runner to verify model loading, input validation, output schema, edge-case fallbacks, and latencies:
```bash
python evaluation/test_all_agents.py
```
*Expected result:* `ALL 4 SELLER-SIDE AI AGENTS PASSED SMOKE TESTS SUCCESSFULLY!`

### 3. Test Individual Agents via CLI Runner
```bash
# Agent 1: Hindi Summarization
python agents/cli_runner.py --agent hindi_summarizer --input "भारतीय अंतरिक्ष अनुसंधान संगठन ने आज एक ऐतिहासिक मिशन को सफलता पूर्वक पूरा किया है। वैज्ञानिकों ने उपग्रह को सटीक कक्षा में स्थापित किया।"

# Agent 2: Weather Prediction
python agents/cli_runner.py --agent weather_predictor --input '{"temperature_mean": 30.5, "temperature_max": 35.0, "relative_humidity_mean": 60.0}'

# Agent 3: Hindi Sentiment Analysis
python agents/cli_runner.py --agent hindi_sentiment --input "यह उत्पाद बहुत ही शानदार और उपयोगी है!"

# Agent 4: Intent Classification & Marketplace Service Routing
python agents/cli_runner.py --agent intent_classifier --input "Can you summarize this news article for me?"
```

### 4. Start Server & Open Interactive Marketplace
```bash
npm start
```
Open **[http://localhost:3000/marketplace.html](http://localhost:3000/marketplace.html)** in your browser:
- **Tab 1 (Services Catalog)**: Browse all marketplace services, compare specs, click **"Test Model"** on any AI service.
- **Tab 2 (Decision Transparency Log)**: Audit past autonomous purchases made by the Scout Buyer Agent.
- **Tab 3 (Agent Decision Simulator)**: Select candidate services, configure criteria weights, and run Scout live. When an AI service is selected, Scout executes the seller endpoint and returns real model output.
- **Tab 4 (Seller AI Agents Test Bench)**: Interactive demo screen for all 4 agents with pre-loaded prompt presets, real-time Devanagari text processing, and held-out evaluation reports.

---

## What's here

```
src/
  db.js            SQLite storage — one table, payment_logs
  server.js         Express app, wires up x402 payment gating
  routes/
    log.js          POST /log        — FREE, records a payment event
    audit.js         GET /audit/lookup   — FREE, single receipt (needs a real tx_id)
                      GET /audit/report   — FREE, aggregate report (needs your own
                                            wallet sign-in, or an admin key for all services)
scripts/
  test-client.js    A script that PAYS your own server, to prove it works
```

## Setup (do this once) — no real money involved anywhere below

Testnet ALGO and testnet USDC are free play-money, given out by public
"faucet" websites for developers to test with. You are not buying anything,
not linking a card, not spending real rupees at any point in this section.

1. **Install dependencies**
   ```
   npm install
   ```

2. **Generate wallet #1 — your service's wallet (the one that GETS PAID)**
   ```
   npm run generate-wallet
   ```
   This prints an address, a 25-word phrase, and a base64 private key —
   all generated locally on your machine, nothing sent anywhere. Save the
   output somewhere (a text file is fine for a hackathon).

3. **Generate wallet #2 — the "customer" wallet that will pay your service**
   Run the exact same command again. Running it twice gives you two
   completely independent accounts:
   ```
   npm run generate-wallet
   ```

4. **Fund both addresses with free testnet ALGO**
   Go to the [testnet ALGO dispenser](https://bank.testnet.algorand.network/),
   paste in wallet #1's address, submit. Repeat for wallet #2's address.
   No app, no login — just the address.

5. **Get testnet USDC for both addresses**
   Ask in the hackathon WhatsApp group for the current testnet USDC faucet
   link (these move around) — you'll paste in the same two addresses there.

6. **Copy `.env.example` to `.env`** and fill in:
   - `RESOURCE_SERVER_ALGORAND_ADDRESS` — wallet #1's **address**
   - `CLIENT_AVM_PRIVATE_KEY` — wallet #2's **base64 private key**

   Leave `FACILITATOR_URL` as it already is in the example file.

**Keep both 25-word phrases and the raw output somewhere safe, and never
paste them into any website except an official Algorand wallet if you later
choose to import one** — treat them like passwords, even on testnet.

### Optional: seeing these wallets in an app

You don't need Pera Wallet at all for this project — the script above IS
your wallet. If you'd still like a visual view (e.g. to watch the balance
change after a payment), you can import either account into Pera Wallet
later using its 25-word phrase, via whatever "Recover / Import Account"
option your version of the app currently has. This is optional and not
required for anything in this README.

### If you'd rather use Pera Wallet's own account instead of a generated one

Pera Wallet's menu structure changes between versions and we couldn't
reliably document one exact path — if you already have an account there and
want to use it, use its **Export Private Key** option (wherever it lives in
your version) to get a base64 key directly, which skips the mnemonic
conversion step. If it only offers to show you a recovery phrase, use
`npm run get-key -- "your 25 words"` to convert it (only works for a
25-word / Algo25-style phrase, not a 24-word Universal Wallet phrase).

## Running it

```
npm start
```

You should see:
```
Payment audit service listening on http://localhost:3000
```

In a second terminal, log a fake payment event (this route is free):
```
curl -X POST http://localhost:3000/log \
  -H "Content-Type: application/json" \
  -d '{
    "tx_id": "SOME_REAL_OR_FAKE_TESTNET_TX_ID",
    "service_name": "demo-gpu-marketplace",
    "payer_address": "SOME_TESTNET_ADDRESS",
    "amount": "500000",
    "asset": "USDC"
  }'
```

Read it back — this is free now, no wallet or payment needed:
```
curl "http://localhost:3000/audit/lookup?txId=SOME_REAL_OR_FAKE_TESTNET_TX_ID"
```

To actually prove the x402 **payment** loop works end to end (`/audit/lookup`
and `/audit/report` no longer need it — `/audit/certificate` is the route
that still does), try generating a certificate without paying first — you
should get a 402:
```
curl "http://localhost:3000/audit/certificate?service=demo-gpu-marketplace"
```

Then actually pay for it with the test client:
```
npm run test-client -- "/audit/certificate?service=demo-gpu-marketplace"
```

If that returns a generated certificate with a 200, **the entire payment loop
works end to end.** Everything after this point is just adding more features
on top of proven plumbing.

## What to build next, in order

1. Get the smoke test above working — this is 80% of the difficulty.
2. Seed a handful of realistic-looking logged transactions (different
   service names, amounts, timestamps) so `/audit/report` has something to
   aggregate — makes your demo look far more finished.
3. **Stretch goal (great judging talking point):** implement
   `verifyTxOnChain()` in `src/routes/log.js` for real, by querying the
   Algorand testnet indexer to confirm a `tx_id` genuinely exists before
   trusting a `/log` call. Right now it's a stub that always returns true.
4. Optional: a tiny static HTML page that hits `/audit/report` (with a
   session token from `/auth/login`, or an admin key) and renders a table —
   takes an hour, makes the demo far more visual.
5. Write up your "paying-user use case" clearly for the submission doc —
   who pays you, why, and how much per call.

## Troubleshooting

**`npm install` fails while building `better-sqlite3`, with errors mentioning
`v8::Object`, `GetPrototype`, or `node-gyp`:** you shouldn't hit this anymore
— this project now uses Node's own built-in `node:sqlite` module instead of
`better-sqlite3`, so there's no native code to compile at all. If you're on
an old copy of this project, re-download it, or just delete the
`better-sqlite3` line from `package.json`'s dependencies and re-run
`npm install`.

**You'll see a yellow `ExperimentalWarning: SQLite is an experimental
feature` line when the server starts.** That's expected and harmless —
Node labels this feature experimental but it works fine. Don't worry about it.

**`node:sqlite` not found / import fails:** you need Node 22.5 or newer.
Check with `node --version`. If you're on an older version, use `nvm install
22 && nvm use 22`, or ask a teammate on a newer install.

## Troubleshooting

- **`npm install` fails while compiling a native module**: this project uses
  Node's built-in `node:sqlite` specifically to avoid that — if you still
  hit a native-compile error, it's from something else pulled in as a
  dependency. Check the error mentions the actual package name and search
  for that specific issue.
- **You need Node 22.5 or newer** (`node --version` to check) since
  `node:sqlite` doesn't exist in older versions. If you're on something
  older, install a newer Node via [nvm](https://github.com/nvm-sh/nvm):
  `nvm install 22 && nvm use 22`.
- You'll see one `ExperimentalWarning: SQLite is an experimental feature`
  line when the server starts — that's expected and harmless, not a bug.

## Notes

- Prices are set with plain `"$0.02"` style strings — the SDK resolves this
  against testnet USDC automatically.
- `paymentMiddlewareFromConfig` needs internet access to reach the
  facilitator (`FACILITATOR_URL`) on startup — make sure you're online when
  you run `npm start`.
- Package versions are pinned to `@x402-avm/*@2.6.1`, confirmed working as
  of this scaffold's creation. If the onboarding workshop mentions a newer
  version, `npm install @x402-avm/express@latest` etc. to update.
