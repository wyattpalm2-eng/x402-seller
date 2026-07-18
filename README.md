# x402-seller

A paywalled market-data API that charges AI agents **USDC per request** via the
[x402 protocol](https://docs.cdp.coinbase.com/x402/welcome). This puts you on the
**seller** side of the agent economy (the scarce side: roughly 9 buyer agents for
every 1 seller as of early 2026).

It runs **today on Base Sepolia testnet with zero money and zero API keys**.
Going live is a one-line network change.

---

## What it does

**Market data**

| Route | Price | Returns | Source |
|---|---|---|---|
| `GET /price?symbol=BTC` | $0.001 | spot crypto price | Coinbase (free) |
| `GET /stock?ticker=AAPL` | $0.002 | stock/ETF quote | Yahoo Finance (free) |
| `GET /markets?limit=10` | $0.005 | top crypto snapshot | CoinGecko (free) |
| `GET /signal?symbol=BTC` | $0.01 | composite momentum verdict | blended |

**On-chain / DeFi suite (the moat)** — data agents can't trivially assemble themselves:

| Route | Price | Returns | Source |
|---|---|---|---|
| `GET /onchain/token?query=PEPE` | $0.005 | token price, liquidity, volume, 24h change, FDV, best pool | DexScreener (free) |
| `GET /onchain/trending?chain=base` | $0.005 | trending DEX pools | GeckoTerminal (free) |
| `GET /onchain/new?chain=base` | $0.01 | newly launched pools (launch hunting) | GeckoTerminal (free) |
| `GET /onchain/defi?chain=base` | $0.005 | chain TVL + top protocols | DeFiLlama (free) |

Chains: `base, eth, solana, bsc, polygon, arbitrum, optimism`. Token lookups accept
`?query=` (symbol/name) or `?chain=&address=` (contract).

**Free routes:** `GET /` `GET /health` `GET /catalog` `GET /stats` (live revenue/usage),
plus bot-discovery manifests `GET /.well-known/x402.json` and `GET /.well-known/agent.json`.

Hit a paid route with no payment and you get `HTTP 402` + instructions telling the
caller exactly how much USDC to pay, in what token, to which address. An
x402-capable client pays automatically and retries. The USDC lands in your wallet.
Malformed on-chain requests get a `400` **before** the paywall, so a bot never pays
for a doomed call.

---

## Quick start

```bash
npm install
npm start
```

Then, in another terminal, watch the paywall fire:

```bash
curl -i "http://localhost:4021/price?symbol=BTC"     # -> HTTP 402 Payment Required
curl -s  "http://localhost:4021/catalog"             # free: what's for sale + your pay-to address
```

The `PAYMENT-REQUIRED` response header is base64 JSON. Decoded, it's the payment
demand: amount, USDC contract, your `payTo` address, network, deadline.

---

## Your wallet (how you get paid)

- On first run, `npm run wallet` (also done automatically by the server) creates
  `wallet.json` and uses its address as your receive address.
- **`wallet.json` holds a private key. Back it up. Whoever has it controls the funds.**
  It's gitignored.
- When you have your own wallet, put its address in `.env` as `PAY_TO=` and
  `wallet.json` is ignored.
- To receive, you only need the **address**. The private key only matters when you
  want to move the USDC you've collected.

---

## See a full payment (testnet)

```bash
cp .env.example .env
npm run client          # prints a throwaway buyer address + private key
```

1. Fund that buyer address on **Base Sepolia**:
   - USDC: https://faucet.circle.com (select Base Sepolia)
   - a little ETH for gas: any Base Sepolia ETH faucet
2. Put the printed key in `.env` as `BUYER_PRIVATE_KEY=...`
3. `npm run client`

You'll see: `HTTP 402` → pay → `HTTP 200` + the data + the on-chain settlement,
and the USDC moves from the buyer wallet to your seller wallet.

---

## Going live (real money)

Edit `.env`:

```ini
NETWORK=eip155:8453                                   # Base mainnet
FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
PAY_TO=0xYourRealWalletAddress
```

Mainnet settlement uses Coinbase's facilitator, which needs **CDP API keys**
(free to create at https://portal.cdp.coinbase.com). Add them per the
[CDP x402 docs](https://docs.cdp.coinbase.com/x402/quickstart-for-sellers).
Everything else stays the same.

---

## Getting customers (discovery — the part that actually decides income)

The code is the easy 10%. Whether you make a dollar comes down to **selling data
agents want** and **being findable**. Two levers:

1. **List your endpoints where agents look.** Register on the discovery
   directories so buyer agents can find and call you automatically:
   - x402scan Bazaar: https://www.x402scan.com
   - Coinbase Agent.market (x402 app store)
   Your `GET /catalog` route already emits a machine-readable listing to make this easy.

2. **Sell something not free.** These default endpoints wrap free data, so they're
   a demo, not a moat. Swap in data agents can't trivially get: your StockFit
   fundamentals, your calibrated weather/station model, private scrapes, enriched
   or blended signals. Price by value, not by cost. That's where real demand lives.

Be realistic: this market is early and small. The honest play is to list a few
genuinely useful endpoints, watch `payTo` for inbound USDC, and double down on
whatever gets called.

---

## Layout

```
src/
  index.ts    server: routes, paywall wiring, storefront
  data.ts     the product: the data each endpoint returns (swap this out)
  wallet.ts   generates/loads your receive wallet
  client.ts   test buyer that pays and fetches (the demo)
```

## Known limitations (v0.1)

- **Paid-but-failed:** payment settles before the handler runs, so if an upstream
  source is down the buyer paid and got a 502. For production, check availability
  before settling or issue a refund.
- Testnet by default. No rate limiting, no caching, no persistence.
