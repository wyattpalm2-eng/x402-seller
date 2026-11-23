# x402-seller — rug protection for autonomous trading agents

**Live:** https://x402-seller-m8nx.onrender.com · Base mainnet · no signup, no API key — pay per call in USDC via [x402](https://github.com/coinbase/x402)

Your agent is about to ape into a token. One bad ape costs its whole position.
This API answers **"is this a rug?"** in one call, with evidence:

- **Composite rug score** — [GoPlus](https://gopluslabs.io) static analysis **fused with a live
  [Honeypot.is](https://honeypot.is) buy/sell simulation** (it actually executes a simulated trade),
  a serial-rugger check, hard honeypot gates, and a `needs_review` flag when the two engines disagree.
- **Solana too** — dual-engine (GoPlus-Solana + [RugCheck](https://rugcheck.xyz)): mint/freeze
  authorities, holder concentration, LP burn. Different chain, different rug physics, same design.
- **Liquidity-drain detector** — we poll pool reserves over time and answer *"is liquidity leaving
  right now?"* — the earliest sign of a rug in progress. **This time-series exists nowhere for free**;
  you can't backfill history you didn't collect.
- **[Public self-graded track record](https://x402-seller-m8nx.onrender.com/track-record)** — every 30
  minutes we score fresh Base launches with the exact paid scorer, then grade ourselves against what
  actually happened. Hits **and misses** published. Evidence, not claims.

## Try it free, right now

```bash
# one real /vet per hour, full paid output (chain=base|eth|bsc|polygon|arbitrum|optimism|solana)
curl "https://x402-seller-m8nx.onrender.com/demo/vet?chain=eth&address=0x6982508145454Ce325dDbE47a25d4ec3d2311933"

# the receipts: our verdicts graded against real outcomes (free)
curl "https://x402-seller-m8nx.onrender.com/track-record"

# sample output for every endpoint (free)
curl "https://x402-seller-m8nx.onrender.com/examples"
```

## Buy in a few lines (any x402 client)

```ts
import { wrapFetchWithPaymentFromConfig } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: "eip155:8453", client: new ExactEvmScheme(privateKeyToAccount(process.env.PK)) }],
});
const r = await payFetch("https://x402-seller-m8nx.onrender.com/vet?chain=base&address=0x…");
// 402 → auto-pay USDC on Base → data. That's the whole integration.
```

## Endpoints

<!-- pricing:start -->
Generated from the live [/catalog](https://x402-seller-m8nx.onrender.com/catalog) by `scripts/readme-pricing.mts` (32 paid routes). The 402 challenge is the price of record; this table is a copy of it.

| Route | Price | What you get |
|---|---|---|
| `GET /onchain/safety?chain=base&address=0x…` | $0.05 | Composite rug score (EVM + Solana): static analysis + LIVE buy/sell simulation (EVM) / dual-engine authority+LP analysis (Solana) + serial-rugger check → ok/warning/danger with a disagreement flag |
| `GET /screen?chain=base&addresses=0x..,0x..` | $0.05 | Batch safety screen up to 8 tokens: verdict + risk each, per-token verdicts (unordered), with a clear/caution/avoid summary |
| `GET /vet?chain=base&address=0x…` | $0.05 | One-call token go/no-go: fuses market + composite rug score (static + live buy/sell simulation + serial-rugger) + our self-collected liquidity-drain trend → clear/caution/avoid with reasons. |
| `GET /vet/deployer/:address?chain=base` | $0.05 | Deployer trust score (0-100) for a Base EVM address, computed from our own graded track_record.jsonl (token launch history, rug rate, relauncher flag). |
| `GET /briefs?symbols=BTC,ETH,SOL` | $0.03 | Up to 10 market-regime reads (risk_on / risk_off / neutral from price move, perp funding and sentiment) in ONE paid call, plus an overall verdict for the basket. |
| `GET /token/wash/:address?chain=base` | $0.03 | Is this token's trading volume real? |
| `GET /watchlist?symbols=BTC,ETH,SOL` | $0.03 | Up to 20 momentum verdicts (bullish / bearish / neutral) in ONE paid call, with a tally. |
| `GET /prices?symbols=BTC,ETH,SOL` | $0.02 | Up to 20 spot crypto prices in one call |
| `GET /pulse` | $0.02 | The whole crypto market in one answer: overall risk_on / risk_off regime from BTC, ETH and SOL briefs, market breadth (% of top coins up), top 3 gainers and losers, and sentiment, each with reasons. |
| `GET /stablecoins/flows?limit=15` | $0.02 | Is stablecoin money moving onto or off each chain? |
| `GET /alpha/launches?chain=base  (base\|eth\|solana\|bsc\|polygon\|arbitrum\|optimism)` | $0.01 | One call discovers what just launched AND rug-screens it, ranked by liquidity depth (deepest first), with a per-token rug verdict. |
| `GET /brief?symbol=BTC` | $0.01 | Market regime in one call: risk_on/risk_off/neutral + reasons (spot, funding, OI, sentiment) |
| `GET /depeg` | $0.01 | Is any major USD stablecoin off its $1 peg right now? |
| `GET /derivs?symbol=BTC` | $0.01 | Perp funding rate + open interest + crowded-long/short squeeze signal |
| `GET /etf/flows?symbols=IBIT,FBTC,ARKB&days=5` | $0.01 | Daily net flow estimates for US spot BTC/ETH ETFs -- aggregates 10+ Yahoo Finance OHLCV feeds and computes volume-weighted flow so a bot avoids 10+ calls and manual flow math. |
| `GET /markets?limit=10` | $0.01 | Top crypto market snapshot |
| `GET /movers?limit=5` | $0.01 | Biggest 24h gainers and losers among actively traded coins (Coinbase USD pairs with at least $2M of 24h volume, so no three-trade 'pumps'), plus market breadth and the most-traded coins. |
| `GET /onchain/defi?chain=base` | $0.01 | Chain TVL + top protocols |
| `GET /onchain/liquidity?chain=base&address=0x…` | $0.01 | Liquidity-drain detector from a self-collected reserve time-series (exists nowhere free): draining_fast/draining/stable/growing + %-change |
| `GET /onchain/new?chain=base` | $0.01 | Newly launched pools — launch hunting |
| `GET /onchain/token?query=PEPE  \|  ?chain=base&address=0x…` | $0.01 | Token snapshot: price, liquidity, volume, 24h change, FDV, best pool |
| `GET /onchain/trending?chain=base` | $0.01 | Trending DEX pools |
| `GET /price?symbol=BTC` | $0.01 | Spot crypto price in USD |
| `GET /signal?symbol=BTC` | $0.01 | Composite market signal: spot + 24h change + momentum → bullish/bearish/neutral |
| `GET /stock?ticker=AAPL` | $0.01 | Stock/ETF quote |
| `GET /token/concentration/:address?chain=base` | $0.01 | Returns Gini coefficient, top-10% share, HHI, and Shannon entropy for a token's holder distribution, computed from real on-chain ERC-20 Transfer events fetched from a public Base/Ethereum RPC. |
| `GET /token/risk/:address?chain=base` | $0.01 | Composite on-chain token risk score for any Base or Ethereum token: fuses holder concentration from Transfer-log sampling, Sourcify verification status, contract bytecode analysis, and DexScreener liquidity/volume into one 0-100 score. |
| `GET /wallet/fingerprint/:address?chain=base` | $0.01 | Composite wallet fingerprint (0-100) for any Base or Ethereum address: aggregates native balance, tx count, contract bytecode, ERC-20 token holdings, and DeFi protocol exposure (DefiLlama). |
| `GET /weather/consensus?lat=40.71&lon=-74.01` | $0.01 | Cross-source weather consensus + agreement score (keyless: Open-Meteo + NOAA + 7Timer). |
| `GET /wx/ag/:lat/:lon` | $0.01 | Agricultural risk metrics from Open-Meteo: 13 hourly variables synthesized into a computed ag-risk score 0-100 with drought/excess-precip/high-wind/high-VPD/low-soil-moisture flags. |
| `GET /wx/storm?lat=30.26&lon=-97.74` | $0.01 | Storm risk for any coordinate: resolves NOAA/NWS active-alert GeoJSON polygons with real point-in-polygon math, blends in wind and severity, and returns one scored risk verdict. |
| `GET /yield/surface?chain=base` | $0.01 | Risk-adjusted yield surface across Base and Ethereum lending, DEX, and restaking pools -- pulls real pool data from yields.llama.fi, computes IL-risk-adjusted APY and cross-protocol TVL context, sorted by adjusted return. |
<!-- pricing:end -->

**Free:** `/` · `/demo/vet` · `/track-record` · `/examples` · `/catalog` · `/llms.txt` ·
`/.well-known/x402.json` · `/.well-known/agent.json` · `/openapi.json` · `/health` · `/stats`

Verdict-first flat JSON everywhere: read field 1, act. Reasons included for audit. A malformed
request still gets its 402 first (so crawlers can price every route), but a paid request that fails
validation returns 400 and the payment is cancelled: your agent is never charged for a doomed call.

## Why pay when the underlying sources are free?

Honest answer: the *snapshots* are free — the **judgment and the history are not**.

1. The liquidity time-series is self-collected. There is no free API for "liquidity 1 hour ago."
2. The composite catches what single sources miss: static-only scanners miss simulated sell-traps;
   simulation-only misses authority/mint risks. Disagreement between engines is itself signal (`needs_review`).
3. One $0.05 call replaces 4+ fetches plus the inference tokens your agent burns reconciling them.
4. It's keyless. Your agent can't fill signup forms — it *can* pay 5 cents.
5. [The track record is public](https://x402-seller-m8nx.onrender.com/track-record), misses included.
   Judge the scorer by its record, not this README.

## The Truth Engine — every endpoint grades itself

The track record isn't a feature, it's the operating system. **Everything sold here grades
itself against reality in public, forever** — and the ledgers are git-snapshotted, so a
verdict can't be rewritten after reality grades it:

| What | Graded against | Live ledger |
|---|---|---|
| Rug verdicts on fresh launches | what actually happened 6h later | [/accuracy](https://x402-seller-m8nx.onrender.com/accuracy) · [/track-record](https://x402-seller-m8nx.onrender.com/track-record) |
| `/weather/consensus` day-max forecasts (6 fixed cities, daily) | the independent ERA5 archive, 2 days later | [/truth/weather](https://x402-seller-m8nx.onrender.com/truth/weather) |
| `/signal` + `/brief` market calls (2×/day) | realized spot movement, 24h later | [/truth/signal](https://x402-seller-m8nx.onrender.com/truth/signal) |

If the market-call hit rate converges to ~50%, the page will say the signal has no edge —
publishing that possibility is what makes every other number credible. Doctrine + all
ledgers: [/truth](https://x402-seller-m8nx.onrender.com/truth). Who runs this (an autonomous
AI crew, one human gate) + the real books, live: [/company](https://x402-seller-m8nx.onrender.com/company).

## Use as an MCP tool (Claude Code, Cursor, any MCP client)

Rug-checking + launch radar as agent tools. Two ways in:

**Hosted (no install)** — add the remote MCP server, free demo tools out of the box:

```bash
claude mcp add --transport http x402-seller https://x402-seller-m8nx.onrender.com/mcp
```

Tools: `vet_token` · `launch_radar` · `rug_check` · `track_record` · `catalog` (shared free daily demo budget; unlimited via the paid HTTP API). Published to the [official MCP Registry](https://registry.modelcontextprotocol.io) as `io.github.wyattpalm2-eng/x402-seller`.

**Local (self-hosted, pays for itself)** — clone and run the stdio server, add a burner key for unlimited paid calls:

```bash
git clone https://github.com/wyattpalm2-eng/x402-seller && cd x402-seller && npm install
claude mcp add rug-check -- npx -y tsx mcp/server.mts
```

Tools: `vet_token` · `launch_radar` · `rug_check` · `liquidity_trend` · `market_brief` · `track_record` · `catalog`.

- **No config:** works immediately — `vet_token` routes through the free demo (1 real call/hour),
  `track_record`/`catalog` are always free.
- **`X402_BUYER_PK=0x…`** (a burner wallet with a few dollars of USDC on Base): every tool goes
  unlimited, settling ~$0.01–0.05 per call via x402 automatically. No account anywhere.
- **`X402_SELLER_URL=…`**: point the tools at your own self-hosted instance.

## Run your own

```bash
npm install && npm start                            # localhost:4021, Base Sepolia by default
NETWORK=eip155:8453 PAY_TO=0xYourWallet npm start   # mainnet — keyless facilitators, no CDP account needed
```

One-click deploy: [`render.yaml`](render.yaml) blueprint. The server registers three redundant
keyless facilitators (PayAI, xpay, 0xarchive) on mainnet — no facilitator account required.

Prove the full payment loop end-to-end (needs a burner wallet with ~$1 USDC on Base):

```bash
BUYER_PK=0x<burner-key> npx tsx scripts/selfbuy.mts
```

## Architecture notes

- Node/TS + Express + `@x402/express`. Three redundant facilitators registered in one
  `x402ResourceServer` — any one advertising Base-mainnet `exact` keeps settlement alive.
- Stale-while-revalidate cache with in-flight dedup in front of every upstream: a paying buyer
  never blocks on a cold upstream or eats a 502 while a recent value exists.
- SSRF-safe: chain allowlists, strict address regexes, `encodeURIComponent` everywhere, upstream
  errors never echoed to clients. Receive-only — the server holds **no private key**.
- Junk never billed: sources throw on non-finite prices/empty payloads → uncharged 502; malformed
  input 400s before the paywall.
- `/track-record` and `/onchain/liquidity` ledgers are in-memory + JSONL on free-tier ephemeral
  disk: depth compounds while the service runs and resets on redeploy. Documented, not hidden.

## Layout

```
src/
  index.ts       server: paywall wiring, free routes, demo, storefront
  safety.ts      EVM composite rug score (GoPlus × Honeypot.is + agreement factor)
  solsafety.ts   Solana composite (GoPlus-Solana × RugCheck)
  history.ts     liquidity time-series poller + drain detector
  record.ts      the self-graded public track record
  composites.ts  /vet and /brief answer endpoints
  crypto.ts      on-chain aggregator (DexScreener/GeckoTerminal/DeFiLlama)
  funnel.ts      who viewed (402) vs who bought — demand telemetry
scripts/
  selfbuy.mts    one-command real x402 purchase (settlement proof)
```

MIT. Built to be forked — if you'd rather run your own than pay ours, the code is all here.
The moat isn't the code, it's the collected history and the graded record.
