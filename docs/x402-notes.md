# x402 v2 notes (build step 1 findings)

What we confirmed about the SDK and the testnet facilitator, by reading the installed source (`@x402/*` 2.28.0) and by running against `https://x402.org/facilitator` on 16 Oct 2026. Everyone touching payments should read this.

## Versions

| Package | Version | Notes |
|---|---|---|
| `@x402/core`, `@x402/evm`, `@x402/express`, `@x402/fetch`, `@x402/extensions` | 2.28.0 | pinned exactly |
| `@x402/paywall` | not installed | optional peer of `@x402/express`; only renders HTML paywalls for browsers and pulls in ~800 packages |

## Facilitator (`GET https://x402.org/facilitator/supported`)

- Supports x402 v2 `exact` on `eip155:84532` (our path). Also `upto` (metered, useful for the pay-per-token stretch goal) and `batch-settlement` on the same network.
- Signer (gas payer) for `eip155:*`: `0xd407e409E34E0b9afb99EcCeb609bDbcD5e7f1bf`. Settlement transactions on Basescan come from this address; the USDC `Transfer` inside goes buyer → payTo.
- A signed payment from an unfunded wallet is rejected at verify with `invalid_exact_evm_insufficient_balance`. The seller answers 402 with that error in `PAYMENT-REQUIRED`, the handler never runs, and nothing settles.

## Wire format (as produced by our sellers)

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "http://localhost:4101/scrape?page=1", "description": "...", "mimeType": "application/json", "serviceName": "shelf-scraper" },
  "accepts": [{
    "scheme": "exact", "network": "eip155:84532", "amount": "5000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e", "payTo": "0xA098...12E0",
    "maxTimeoutSeconds": 60,
    "extra": { "assetTransferMethod": "eip3009", "name": "USDC", "version": "2" }
  }]
}
```

- Headers: `PAYMENT-REQUIRED` (402), `PAYMENT-SIGNATURE` (client retry), `PAYMENT-RESPONSE` (success). All base64 JSON. v1's `X-PAYMENT` is also read by our replay guard, but we only register v2 schemes.
- `resource.url` comes from the request (`req.protocol` + host + original URL). Behind a tunnel, Express needs `trust proxy` (set to `loopback` in the kit) so it shows the public https URL.
- `extra.name` / `extra.version` are the USDC EIP-712 domain (`"USDC"`, `"2"` on Base Sepolia; mainnet USDC uses `"USD Coin"`, another reason the asset is a constant).

## Order of operations in `@x402/express` v2 (verified in source)

1. Route match (`"GET /scrape"`), then build requirements and the 402 if there is no payment header.
2. Decode the payment, match it to an advertised requirement, **verify with the facilitator before the handler** (the `exact` + `eip3009` flow is `authorization`, whose `verifyBeforeHandler` is true).
3. Run the handler with `res.write`/`res.end` **buffered**.
4. If the handler's status is **≥ 400**: no settlement; the buffered error is sent as is.
5. Otherwise **settle**; on success set `PAYMENT-RESPONSE` and flush the body; on settle failure discard the body and send the failure response.

So "no service, no charge" reduces to: every failure must be a status ≥ 400. The kit enforces that with a deadline (504) and output self-validation (500).

## What the SDK does NOT do (and the kit adds)

| Gap | Consequence | Kit's answer |
|---|---|---|
| No replay cache in the resource server | 5 parallel copies of one signature all pass verify (the nonce is still unused on-chain), all run the handler, all race to settle; only the chain stops the duplicates | `ReplayStore`: one synchronous SQLite `INSERT ... ON CONFLICT DO NOTHING` on `(network, asset, payer, nonce)` **before** verify. Losers get 409 and the handler never runs |
| No input validation | A malformed request could be paid for, then fail | Ajv validation before the 402 (400) |
| No handler deadline | A hung handler holds a verified authorisation until it expires | `timeoutMs` (default 20 s, must leave ≥ 15 s of the 60 s window for settlement) → 504 |
| No output contract | A seller could settle garbage | Output validated against the seller's own listed schema → 500, never settled |

## Client side (how the buyer, `packages/x402-kit/src/buyer`, uses the SDK)

- `new x402Client()` + `registerExactEvmScheme(client, { signer: viemAccount })`; `wrapFetchWithPayment(fetch, client)` is the stock one-liner (used by `npm run spike`).
- For full control use `x402HTTPClient`: `getPaymentRequiredResponse(getHeader, body)` → `client.createPaymentPayload(paymentRequired)` → `encodePaymentSignatureHeader(payload)`; read results with `getPaymentSettleResponse(getHeader)`.
- Hooks: `registerPolicy(fn)` filters/transforms `accepts` before selection (the price check belongs here); `onBeforePaymentCreation` can return `{ abort: true, reason }` (budget reservation belongs here); there is also `spendControls` in `x402ClientConfig`.
- Default selector picks `accepts[0]`; our sellers always list Base Sepolia first.
- The EIP-3009 payload is `payload.authorization = { from, to, value, validAfter, validBefore, nonce }` plus `payload.signature`. `validBefore` ≈ now + `maxTimeoutSeconds`. USDC's `authorizationState(from, nonce)` tells you on-chain whether it was used (`authorizationUsed()` in `x402-kit/chain.ts`).

## Gotchas hit while building

- Hindi vowel signs are Unicode combining marks (`\p{M}`), not letters: count `[\p{L}\p{M}]` when measuring how much of a text is Devanagari.
- `node:sqlite` prints an ExperimentalWarning on load; `packages/shared/src/sqlite.ts` filters exactly that one warning.
- `frankfurter.app` now redirects to `api.frankfurter.dev/v1`; we call the new host directly.
- `books.toscrape.com/robots.txt` is a 404, which means everything is allowed; we still check it, cache it for a day, and refuse if a future robots.txt disallows a path.
- Catalogue pages don't include descriptions; the scraper fetches each product page (≤ 6 at a time, cached for 24 h). A cold page takes about 4 s and a cached one 0 ms.

## Buyer decisions (build step 4)

- **One `x402Client` per buyer**, registered for `eip155:84532` only, with `setSpendControls({ maxAmountPerPayment: "$0.10" })` (the SDK default is `$1`).
- **Signing guard:** `onBeforePaymentCreation` aborts unless the selected option's fingerprint (scheme, network, asset, payTo, amount, window) was approved by the price check for an in-flight call. The signer is also handed a `PaymentRequired` whose `accepts` holds only that option.
- **After signing**, the authorisation is re-checked (`value`, `to`, `from`) before it is sent; a mismatch is never sent.
- **Pending first:** the ledger row (with the nonce) is recorded as `pending` before the paid request leaves the process, so a crash mid-call leaves a row that can be resolved from the chain.
- **Hold, don't guess:** a signed authorisation that did not settle is released only after `validBefore + 15 s` *and* `authorizationState(buyer, nonce) == false`. With `maxTimeoutSeconds: 60` that is about 75 s. Live run on 16 Oct 2026 against an unfunded wallet: the facilitator rejected the payment (`invalid_exact_evm_insufficient_balance`), the reservation was held, and 75 s later the chain confirmed the authorisation unused and the budget was released.
- **Recovering a receipt:** if a seller settles without sending `PAYMENT-RESPONSE`, the tx hash comes from USDC's `AuthorizationUsed(authorizer, nonce)` log (`findAuthorizationTx`).
- **Connection refused / DNS failure** means the signature never left the machine, so the reservation is released at once; any other transport error after sending is treated as unclear (`pending`).

## Steps 6-8 findings

- **`eth_getLogs` on `https://sepolia.base.org` is limited to 200 blocks per call** (error `-32614`, "eth_getLogs is limited to a 200 range"). That is about 6.7 minutes of chain. `transfersFrom()` and `findAuthorizationTx()` scan in windows of `RPC_LOGS_MAX_RANGE` (default 200) with bounded parallelism and retries. A 2,000-block reconciliation is 10 calls, about 1 s.
- **resource.url comes from the raw `Host` header** plus `req.originalUrl` (`ExpressAdapter.getUrl()`), not `X-Forwarded-Host`. The gateway therefore sets the upstream `Host` to the public host (from `X-Forwarded-Host` when a tunnel rewrote `Host`), and every service runs with `trust proxy = loopback` so `req.protocol` is `https`.
- **Route matching uses `req.path`**, which is relative to the Express mount point. So a seller mounted at `/scraper` still matches `GET /scrape`, while resource.url keeps the full `/scraper/scrape?page=1`.
- **Gemini SDK** (`@google/genai` 2.26.0): `GoogleGenAI` reads `GEMINI_API_KEY`. Structured output is `responseMimeType: "application/json"` + `responseJsonSchema`. Safety blocks arrive as `promptFeedback.blockReason` or a candidate `finishReason` (`SAFETY`, `RECITATION`, ...), and `MAX_TOKENS` means truncated. All of these, plus HTTP errors (`ApiError.status`), become an `LlmError` kind that the seller turns into a 5xx, so it never settles.

- **Gemini latency decides the model** (measured 17 Oct 2026, same 2-text Hindi structured request): `gemini-3.5-flash-lite` 3.2 s and 3.9 s; `gemini-3.8-flash` 90.6 s at its default thinking level and over 45 s at `LOW` (`MINIMAL` is rejected with 400). A seller has 40 s to deliver inside a 60 s payment window, so gemini-3.5-flash-lite is the default.
- **Gemini billing errors**: a project without credits answers `402 Your prepayment credits are depleted`; the helper maps it to `unavailable` (seller 503, never charged). Credits belong to the Google project, not the key.
