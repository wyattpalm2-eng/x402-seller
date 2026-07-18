# Getting discovered by buyer agents

How this seller gets into the two directories buyer agents actually query:
**x402scan Bazaar** (`x402scan.com`) and **Coinbase Agentic.Market** (`agentic.market`).
Researched July 2026. TL;DR: one is a submit-a-URL form, the other is automatic
once a real payment settles. **Both need a public HTTPS URL first** (see DEPLOY.md) —
neither can index `localhost:4021`.

---

## The hard prerequisite: a public URL

Every path below fails against localhost. A directory has to fetch your endpoint,
read its `402` challenge / catalog, and (for Coinbase) a facilitator has to settle
a payment against it. All of that requires a reachable public HTTPS origin.
So: **deploy first (DEPLOY.md), then register.**

Two more things to line up before listing on **mainnet** (recommended for real
discovery — testnet listings mostly get ignored):

- `NETWORK=eip155:8453` and `FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402`
- `PAY_TO=` set to the owner's real Base address (swap out the temporary
  `0x39538F214E6CAadF595220C5771DB45a87559a51`).

---

## 1. x402scan Bazaar — submit a URL (manual, fast, works on testnet too)

x402scan is the community explorer/index. Listing is **a submit form**, not automatic.

- Go to **https://www.x402scan.com/resources/register** (the page is titled "Add API").
- Paste your **public base URL** (e.g. `https://x402-seller.example.com`) or a
  specific resource URL.
- x402scan **fetches the URL and validates it returns a valid x402 schema** (the
  `402` challenge / `accepts` block). If it validates, it's **added to the resources
  list automatically** — no account or approval step.
- It reads pricing, network, `payTo`, and route metadata straight off your live
  `402` responses. Your `GET /catalog` route (already emits `payTo`, `network`,
  `facilitator`, and the endpoint list) makes this clean.

Honest caveats:
- If x402scan can't reach the URL or the schema doesn't validate, nothing lists.
  Test first: `curl -i https://YOUR_PUBLIC_URL/price?symbol=BTC` should return
  `HTTP 402` with a `PAYMENT-REQUIRED` header.
- A **quick tunnel URL works** for getting listed, but the URL dies when the tunnel
  restarts and the listing goes stale. Use a stable URL (PaaS or named tunnel) for
  anything you want to persist.

## 2. Coinbase Agentic.Market — automatic on first settlement (mainnet)

Agentic.Market is Coinbase's public directory of x402 services, backed by the
**CDP Facilitator's Bazaar discovery layer**. There is **no submit form and no
account** — you get indexed by *making a sale*.

How it actually works (July 2026):
- **There is no separate registration step. The CDP Facilitator catalogs your
  service the first time it *settles* a payment for that endpoint.** (verify alone
  is not enough — settlement is what triggers indexing.)
- To be catalog-able, your routes must **declare discovery metadata** using the
  official v2 extension **`@x402/extensions/bazaar`** (`bazaarResourceServerExtension`
  + `declareDiscoveryExtension()`): input params / **inputSchema**, **output schema**,
  a natural-language **description** (CDP rejects `description` > 500 chars), and a
  realistic **`output.example`**. Note whether inputs are GET query params or a POST body.
- The settlement payload sent to the facilitator must include **`paymentPayload.resource`**
  so CDP knows which resource to catalog.
- You must be on **mainnet through the CDP facilitator** (needs free CDP API keys
  from `portal.cdp.coinbase.com`). Testnet/`x402.org` settlements do not populate
  the Coinbase catalog.

What this seller needs before it can be auto-listed (current code does NOT do this yet):
- **Wire in `@x402/extensions/bazaar`** and attach `declareDiscoveryExtension()` to
  each paid route (this is a `src/` change, out of scope here — flag for the owner).
- Go live on mainnet + CDP facilitator.
- Get **one real settled payment** (self-buy a `$0.001` `/price` call from a funded
  buyer wallet). That single settle is what puts you in the catalog.

Until those exist, Agentic.Market discovery is not available to this seller — the
honest state today is: **x402scan works now via the submit form; Coinbase requires
a code change + a mainnet sale.**

---

## Ready-to-paste listing blurb

Use for the x402scan "Add API" description field, a README, a tweet, or the
Bazaar `description`. Replace `https://YOUR_PUBLIC_URL` and confirm `payTo`.

> **x402-seller — market data, priced per request, paid in USDC by agents.**
> A paywalled market-data API on Base. Hit any paid route with no payment and you
> get an HTTP 402 with exact pay instructions; an x402-capable client pays and
> retries automatically. Machine-readable catalog at `GET /catalog`.
> Base URL: `https://YOUR_PUBLIC_URL`  •  Network: Base mainnet  •  Pay to: `0x…`

Per-endpoint (prices from the live config):

| Endpoint | Price (USDC/call) | Returns | Status |
|---|---|---|---|
| `GET /price?symbol=BTC` | **$0.001** | Spot crypto price (Coinbase) | live |
| `GET /stock?ticker=AAPL` | **$0.002** | Stock/ETF quote (Stooq) | live |
| `GET /markets?limit=10` | **$0.005** | Top crypto market snapshot (CoinGecko) | live |
| `GET /signal?…` | **$0.01** (proposed) | Blended/enriched trade signal | **NOT LIVE — endpoint doesn't exist yet** |

Honesty note on `signal`: the owner asked for a `/signal` endpoint in the listing,
but the current `src/` serves only `price`, `stock`, and `markets`. **Do not list
`/signal` until it exists** — a directory that fetches it will get a 404 and may
reject or flag the whole listing. Ship the endpoint (a real, non-free signal is
also the only one of the four with an actual moat), then add the row. Suggested
price if/when built: **$0.01/call**.

One-liner (single field): *"Per-request market data for agents, paid in USDC on
Base via x402: crypto price $0.001, stock quote $0.002, market snapshot $0.005.
Catalog at /catalog."*

---

## Reality check

- The three live endpoints wrap **free** upstreams, so they're a demo, not a moat —
  an agent can get the same data free elsewhere. Expect little organic demand until
  you list something agents *can't* trivially get (the `/signal` endpoint, StockFit
  fundamentals, the calibrated weather model, private scrapes).
- Buyer-to-seller ratio favors sellers, but the market is early and small. The
  honest play: deploy, submit to x402scan today, wire the Bazaar extension + do one
  mainnet self-buy to hit Coinbase, then watch `payTo` and double down on whatever
  gets called.

## Sources

- [x402scan](https://www.x402scan.com/) · [Add API / register](https://www.x402scan.com/resources/register)
- [CDP x402 Bazaar (Discovery Layer)](https://docs.cdp.coinbase.com/x402/bazaar)
- [Introducing x402 Bazaar (Coinbase)](https://www.coinbase.com/developer-platform/discover/launches/x402-bazaar)
- [Introducing Agentic.Market (Coinbase)](https://www.coinbase.com/developer-platform/discover/launches/agentic-market)
- [Bazaar discovery concepts (x402 gitbook)](https://x402.gitbook.io/x402/core-concepts/bazaar-discovery-layer)
