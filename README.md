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

## Buy with three lines (any x402 client)

```ts
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(process.env.PK));
const r = await payFetch("https://x402-seller-m8nx.onrender.com/vet?chain=base&address=0x…");
// 402 → auto-pay USDC on Base → data. That's the whole integration.
```

## Endpoints

| Route | Price | What you get |
|---|---|---|
| `GET /alpha/launches?chain=` | $0.08 | **Launch radar** — discovers what just launched AND rug-screens every candidate in one call, ranked safest-first with a per-token verdict. Replaces the whole discover→screen→rank pipeline. EVM + Solana |
| `GET /vet?chain=&address=` | $0.05 | **Single-token go/no-go**: market + composite rug score + liquidity-drain trend → `clear/caution/avoid` + reasons. EVM + Solana |
| `GET /onchain/safety?chain=&address=` | $0.03 | Composite rug score: red/green flags, 0-100 risk, live-sim results, `needs_review` disagreement flag |
| `GET /screen?chain=&addresses=a,b,c` | $0.03 | Batch-vet up to 8 tokens, sorted safest-first + summary |
| `GET /onchain/liquidity?chain=&address=` | $0.01 | Liquidity-drain verdict from our self-collected reserve series: `draining_fast/draining/stable/growing` |
| `GET /brief?symbol=BTC` | $0.03 | Market regime in one call: spot + funding/OI + sentiment → `risk_on/risk_off/neutral` |
| `GET /derivs?symbol=BTC` | $0.01 | Perp funding (hourly + annualized), open interest, crowded-positioning signal |
| `GET /onchain/token` `/trending` `/new` `/defi` | $0.005–0.01 | Token snapshots, trending pools, fresh launches, chain TVL |
| `GET /price` `/stock` `/markets` `/signal` | $0.001–0.01 | Spot crypto, stocks/ETFs, market snapshot, momentum verdict |

**Free:** `/` · `/demo/vet` · `/track-record` · `/examples` · `/catalog` · `/llms.txt` ·
`/.well-known/x402.json` · `/.well-known/agent.json` · `/openapi.json` · `/health` · `/stats`

Verdict-first flat JSON everywhere: read field 1, act. Reasons included for audit. Malformed
requests are rejected **before** the paywall — your agent never pays for a doomed call.

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
