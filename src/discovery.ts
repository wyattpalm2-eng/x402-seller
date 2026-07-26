/**
 * discovery.ts — makes the API discoverable and usable BY BOTS.
 *
 * Serves two machine-readable manifests that directories/crawlers and agents
 * read to auto-find the service and know exactly how to call each endpoint:
 *   GET /.well-known/x402.json   — x402 resource manifest (prices, schemas, examples)
 *   GET /.well-known/agent.json  — agent card (skills, pricing, wallet, docs)
 *
 * URLs are built from the incoming request, so the manifests are correct on
 * localhost, a tunnel, or a real deploy without any config.
 */
import { Router, type Request, type Response } from "express";
import { getReceiveAddress } from "./wallet.js";

const NETWORK = process.env.NETWORK?.trim() || "eip155:84532";
const FACILITATOR = process.env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
const IS_MAINNET = NETWORK === "eip155:8453";
const NAME = "x402-seller";
const DESCRIPTION =
  "Rug protection and decision-ready intelligence for autonomous trading agents. Keyless by design: " +
  "no signup, no API key — pay a cent per request in USDC (x402). The /alpha/launches LAUNCH RADAR " +
  "discovers what just launched AND rug-screens every candidate in one call, ranked safest-first — the " +
  "proactive 'give me safe alpha' call. /vet gives a single-token go/no-go " +
  "in ONE call by fusing a COMPOSITE rug score (GoPlus static analysis + a LIVE Honeypot.is buy/sell " +
  "simulation + serial-rugger check) with our SELF-COLLECTED liquidity-drain trend — a rug-in-progress " +
  "signal that exists nowhere for free because it requires collecting reserves over time. One call is " +
  "cheaper than the inference tokens you'd burn stitching 4 free APIs, and it stops your agent losing its " +
  "whole position to a honeypot. Also: /onchain/liquidity drain detector, /screen batch watchlist check, " +
  "/brief market regime, and raw feeds (prices, stocks, DEX pools, launches, perp funding/OI).";
const WHY_PAY = [
  "public self-graded track record at /track-record (free): our scorer graded against real outcomes, misses included — evidence, not claims",
  "avoid catastrophic loss: /vet + /onchain/safety catch honeypots and draining liquidity BEFORE your agent apes in — one bad ape costs more than 10,000 calls",
  "data that isn't free anywhere: a LIVE buy/sell simulation and a self-collected liquidity-drain time-series — not a re-wrap of a public snapshot",
  "keyless: an agent cannot fill signup forms or manage API keys — x402 payment IS the auth",
  "one call per decision: /vet fuses 4+ sources into a verdict, so you spend a cent instead of the inference tokens to reconcile them yourself",
  "verdict-first JSON: read field 1 (clear/caution/avoid), act; reasons + a needs_review disagreement flag included for audit",
];

const P = {
  price: process.env.PRICE_CRYPTO || "$0.01",
  stock: process.env.PRICE_STOCK || "$0.01",
  markets: process.env.PRICE_MARKETS || "$0.01",
  signal: process.env.PRICE_SIGNAL || "$0.01",
  token: process.env.PRICE_ONCHAIN_TOKEN || "$0.01",
  trending: process.env.PRICE_ONCHAIN_TRENDING || "$0.01",
  newp: process.env.PRICE_ONCHAIN_NEW || "$0.01",
  defi: process.env.PRICE_ONCHAIN_DEFI || "$0.01",
  safety: process.env.PRICE_ONCHAIN_SAFETY || "$0.01",
  liquidity: process.env.PRICE_ONCHAIN_LIQUIDITY || "$0.01",
  derivs: process.env.PRICE_DERIVS || "$0.01",
  vet: process.env.PRICE_VET || "$0.01",
  brief: process.env.PRICE_BRIEF || "$0.01",
  screen: process.env.PRICE_SCREEN || "$0.01",
  alpha: process.env.PRICE_ALPHA || "$0.01",
  weather: process.env.PRICE_WEATHER || "$0.01",
  // Crew-ported endpoints. These were live and sellable for a day while being INVISIBLE to every
  // x402 crawler, because the porter wired index.ts but not this spec — /catalog listed them,
  // /.well-known/x402.json did not, and the manifest is what directories actually ingest.
  agMetrics: process.env.PRICE_AG_METRICS || "$0.01",
  stormRisk: process.env.PRICE_STORM_RISK || "$0.01",
  walletFingerprint: process.env.PRICE_WALLET_FINGERPRINT || "$0.01",
  tokenRisk: process.env.PRICE_TOKEN_RISK || "$0.01",
  tokenConcentration: process.env.PRICE_TOKEN_CONCENTRATION || "$0.01",
  etfFlows: process.env.PRICE_ETF_FLOWS || "$0.01",
};

export interface Endpoint {
  method: "GET";
  path: string;
  price: string;
  description: string;
  input: Record<string, { type: string; required: boolean; default?: string; example?: string; enum?: string[] }>;
  output_example: any;
}

// Exported so index.ts can derive per-route Bazaar discovery extensions from the
// SAME spec that feeds /.well-known/x402.json — one source of truth, no drift.
export const ENDPOINTS: Endpoint[] = [
  {
    method: "GET", path: "/weather/consensus", price: P.weather,
    description: "Cross-source weather consensus: blends Open-Meteo + NOAA/NWS + 7Timer into one temperature plus an agreement score (how much the models agree). Keyless — one call instead of stitching 3 free weather APIs and reconciling them yourself. First endpoint built by the autonomous crew and ported through the bridge.",
    input: { lat: { type: "number", required: true, example: "40.71" }, lon: { type: "number", required: true, example: "-74.01" } },
    output_example: { query: { lat: 40.71, lon: -74.01 }, consensus: { blendedTempC: 26, agreementScore: 53, sourceCount: 2, stdevC: 2.35 }, sources: [{ source: "open-meteo", tempC: 23.6 }, { source: "noaa-nws", tempC: 28.3 }, { source: "7timer", error: "timeout" }] },
  },
  {
    method: "GET", path: "/alpha/launches", price: P.alpha,
    description: "LAUNCH RADAR — one call discovers what just launched AND rug-screens every candidate through the composite score (static + live buy/sell simulation, or the Solana dual-engine) + liquidity, returning a ranked safest-first shortlist with a per-token verdict. Replaces an agent's whole discover→screen→rank pipeline (10+ calls). The proactive 'give me safe alpha' call for launch-sniping agents.",
    input: { chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] } },
    output_example: {
      chain: "base", headline: "2 of 10 fresh launches look clear — safest: BONKFI",
      summary: { scanned: 10, clear: 2, caution: 3, avoid: 4, unrated: 1 },
      launches: [
        { token: "BONKFI", address: "0x…", verdict: "ok", risk_score: 10, honeypot: false, top_flag: null, liquidity_usd: 82000, liquidity_trend: "growing", launched: "2026-07-19T12:40:00Z" },
        { token: "SCAMZ", address: "0x…", verdict: "danger", risk_score: 100, honeypot: true, top_flag: "HONEYPOT: live sell simulation FAILED", liquidity_usd: 5400 },
      ],
    },
  },
  {
    method: "GET", path: "/wx/storm", price: P.stormRisk,
    description: "STORM RISK for any coordinate on Earth — resolves NOAA/NWS active-alert GeoJSON polygons with real point-in-polygon geometry, blends in wind speed and alert severity, and returns ONE scored risk verdict. Replaces the whole pipeline an agent would otherwise build: fetch the alert feed, parse multi-ring GeoJSON, run point-in-polygon per alert, reconcile severity vocabularies, and merge a second wind source. Independently scored 9/10 by a bot-buyer panel: 'paying $0.04 to instantly bypass complex GeoJSON parsing, point-in-polygon math, and multiple API orchestration is a highly efficient time-saver.' Keyless, no signup, works worldwide (richest inside US NWS coverage). For logistics routing, drone/flight go-no-go, field-ops scheduling and insurance triggers.",
    input: {
      lat: { type: "number", required: true, example: "30.26", default: undefined },
      lon: { type: "number", required: true, example: "-97.74", default: undefined },
    },
    output_example: {
      query: { lat: 30.26, lon: -97.74 },
      risk: { score: 62, level: "elevated", headline: "1 active severe alert covers this point" },
      alerts: [{ event: "Severe Thunderstorm Warning", severity: "Severe", urgency: "Expected", certainty: "Likely", containsPoint: true }],
      wind: { speedKph: 41, gustKph: 67 },
      computedAt: "2026-07-25T03:16:45Z",
    },
  },
  {
    method: "GET", path: "/wx/ag/{lat}/{lon}", price: P.agMetrics,
    description: "AGRICULTURAL RISK METRICS for any coordinate — pulls 13 hourly variables from Open-Meteo (4 soil-moisture layers, 2 soil temperatures, ET0 reference evapotranspiration, wind and gusts, humidity, temperature) and synthesizes them into a computed 0-100 ag-risk score with explicit flags for drought, excess precipitation, high wind, high VPD and low soil moisture. Also returns derived VPD, GDD and ET0. Replicating this means 8+ hourly API calls plus the vapour-pressure-deficit and growing-degree-day math, then reconciling it into one decision. For irrigation scheduling, spray-window selection, harvest timing, crop-insurance triggers and farm-robot go/no-go.",
    input: {
      lat: { type: "number", required: true, example: "40.71" },
      lon: { type: "number", required: true, example: "-74.00" },
    },
    output_example: {
      query: { lat: 40.71, lon: -74.0 },
      agRisk: { score: 38, level: "moderate", flags: ["high_vpd"] },
      derived: { vpdKpa: 1.82, gddToday: 14.2, et0MmDay: 4.6 },
      soil: { moisture0_1cm: 0.21, moisture1_3cm: 0.24, temp0cm: 24.8 },
      wind: { speedKph: 18, gustKph: 31 },
      computedAt: "2026-07-25T04:40:00Z",
    },
  },
  {
    method: "GET", path: "/token/risk/{address}", price: P.tokenRisk,
    description: "COMPOSITE TOKEN RISK SCORE (0-100) for any Base or Ethereum token, computed from five independent on-chain signals and fused into one verdict: holder concentration sampled from real Transfer event logs, Sourcify source-verification status, contract bytecode analysis, DexScreener liquidity + 24h volume + transaction counts, and supply distribution across recent recipients. Collapses 5+ separate API calls and the scoring logic an agent would have to write and maintain into a single request. The address is validated BEFORE the paywall, so a malformed address returns 400 and is never charged.",
    input: {
      address: { type: "string", required: true, example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth"] },
    },
    output_example: {
      query: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" },
      token: { name: "USD Coin", symbol: "USDC", decimals: 6 },
      risk: { score: 8, level: "low", flags: [] },
      signals: { verified: true, holderConcentrationPct: 12.4, liquidityUsd: 41200000, volume24hUsd: 8800000, bytecodeSizeBytes: 2842 },
      computedAt: "2026-07-25T03:16:45Z",
    },
  },
  {
    method: "GET", path: "/wallet/fingerprint/{address}", price: P.walletFingerprint,
    description: "COMPOSITE WALLET FINGERPRINT (0-100) for any Base or Ethereum address: aggregates native balance, transaction count, contract bytecode (is it an EOA or a contract?), ERC-20 token holdings, and DeFi protocol exposure via DefiLlama into one profile plus a score. Four or more RPC round-trips and the cross-source synthesis, collapsed into one call. Use it to profile a counterparty before trading with them, triage an airdrop list, or check whether an address is a fresh burner or an established participant. Address is validated pre-paywall — a malformed address is a 400, never a charge.",
    input: {
      address: { type: "string", required: true, example: "0x4200000000000000000000000000000000000006" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth"] },
    },
    output_example: {
      query: { address: "0x4200000000000000000000000000000000000006", chain: "base" },
      profile: { isContract: true, txCount: 184220, nativeBalanceEth: 0.0, tokenCount: 12 },
      defi: { protocolsTouched: 3, topProtocol: "aerodrome" },
      fingerprint: { score: 71, label: "established contract, high activity" },
      computedAt: "2026-07-25T03:16:45Z",
    },
  },
  {
    method: "GET", path: "/token/concentration/{address}", price: P.tokenConcentration,
    description: "HOLDER CONCENTRATION ANALYTICS for any Base or Ethereum token: fetches real ERC-20 Transfer events from a public RPC, aggregates per-address balances, and computes four statistical measures of holder distribution -- Gini coefficient, top-10% share, Herfindahl-Hirschman Index (HHI), and Shannon entropy. A bot that tries this itself must maintain paginated event parsing across thousands of logs, aggregate transfers per address, and implement the statistical math -- real work that takes ongoing maintenance to keep accurate. One call returns the full concentration profile. Address is validated pre-paywall -- a malformed address is a 400, never a charge.",
    input: {
      address: { type: "string", required: true, example: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth"] },
    },
    output_example: {
      query: { address: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", chain: "base" },
      token: { name: "USD Coin", symbol: "USDC", decimals: 6 },
      concentration: {
        gini: 0.98,
        top10pctShare: 0.85,
        hhi: 7200,
        shannonEntropy: 3.42,
        totalHolders: 184320,
        totalSupply: "2589012034.000000",
      },
      verdict: "highly concentrated",
      computedAt: "2026-07-25T11:42:00Z",
    },
  },
  {
    method: "GET", path: "/price", price: P.price,
    description: "Spot crypto price in USD from CoinGecko, normalized to one call. Saves an agent stitching price feeds from multiple tickers or managing a CoinGecko key; the price is the work completed, not a raw feed to process further.",
    input: { symbol: { type: "string", required: false, default: "BTC", example: "ETH" } },
    output_example: { symbol: "BTC-USD", price_usd: 63950.12, source: "coinbase" },
  },
  {
    method: "GET", path: "/stock", price: P.stock,
    description: "Stock/ETF quote (price, change, day high/low, volume).",
    input: { ticker: { type: "string", required: false, default: "AAPL", example: "TSLA" } },
    output_example: { symbol: "AAPL", price: 333.74, change_pct: 0.14, currency: "USD", source: "yahoo" },
  },
  {
    method: "GET", path: "/markets", price: P.markets,
    description: "Top crypto market snapshot by market cap.",
    input: { limit: { type: "integer", required: false, default: "10", example: "10" } },
    output_example: { count: 10, coins: [{ symbol: "btc", price_usd: 63944, rank: 1, change_24h_pct: 0.5 }], source: "coingecko" },
  },
  {
    method: "GET", path: "/signal", price: P.signal,
    description: "Composite market signal: spot + 24h change + momentum → bullish/bearish/neutral verdict.",
    input: { symbol: { type: "string", required: false, default: "BTC", example: "ETH" } },
    output_example: { symbol: "BTC", price_usd: 63950, change_24h_pct: 0.5, momentum: 0.42, verdict: "bullish" },
  },
  {
    method: "GET", path: "/onchain/token", price: P.token,
    description: "On-chain token snapshot: price, liquidity, 24h volume, multi-window price change, FDV, best pool. Query by symbol/name or by contract address.",
    input: {
      // query is marked required so directory crawlers (x402scan) probe with a real
      // value and get the 402 challenge; the server still also accepts address-only
      // calls (see validateOnchain) — the description documents both paths.
      query: { type: "string", required: true, example: "PEPE" },
      address: { type: "string", required: false, example: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] },
    },
    output_example: {
      query: "PEPE", chain: "ethereum", token: { symbol: "PEPE", address: "0x6982…" },
      price_usd: 0.0000271, liquidity_usd: 14000000, volume_24h: 5200000,
      price_change_pct: { h1: 0.3, h24: -4.6 }, dex: "uniswap", source: "dexscreener",
    },
  },
  {
    method: "GET", path: "/onchain/trending", price: P.trending,
    description: "Trending DEX pools for a chain (name, price, liquidity, 24h volume + change, txns).",
    input: { chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] } },
    output_example: { chain: "base", count: 15, pools: [{ name: "BRIAN / ETH", price_usd: 0.01, liquidity_usd: 250000, price_change_24h_pct: 12.3 }], source: "geckoterminal" },
  },
  {
    method: "GET", path: "/onchain/new", price: P.newp,
    description: "Newly launched DEX pools for a chain — launch hunting. Same shape as trending.",
    input: { chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] } },
    output_example: { chain: "base", count: 15, pools: [{ name: "NEWCOIN / WETH", created_at: "2026-07-18T02:00:00Z", liquidity_usd: 42000 }], source: "geckoterminal" },
  },
  {
    method: "GET", path: "/onchain/defi", price: P.defi,
    description: "One call returns the full DeFi landscape for a chain -- total TVL, top protocols ranked by TVL with category breakdowns (lending, DEX, restaking), and 7-day TVL trend. Aggregates DefiLlama across all protocols on the chain so a bot avoids querying DefiLlama's 4+ endpoints per chain, parsing the protocol list, and computing rankings itself.",
    input: { chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] } },
    output_example: { chain: "base", tvl_usd: 4527177464, top_protocols: [{ name: "Aave V3", category: "Lending", tvl_on_chain_usd: 900000000 }], source: "defillama" },
  },
  {
    method: "GET", path: "/onchain/safety", price: P.safety,
    description: "COMPOSITE rug/honeypot score: fuses GoPlus static analysis with a LIVE Honeypot.is buy/sell simulation, plus a serial-rugger check, hard-zero honeypot gates, and an agreement factor that flags when the two methods disagree. Returns ok/warning/danger + a 0-100 risk score + red/green flags + the raw simulation. More trustworthy than any single free feed. On Solana, fuses GoPlus-Solana + RugCheck (mint/freeze authorities, holder concentration, LP burn) — same dual-engine design.",
    input: {
      address: { type: "string", required: true, example: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism", "solana"] },
    },
    output_example: {
      chain: "eth", token: { symbol: "PEPE" }, verdict: "ok", risk_score: 10, confidence: "high", needs_review: false,
      red_flags: ["blacklist function present"], green_flags: ["passed live buy & sell simulation", "0% simulated buy & sell tax", "source code verified", "ownership renounced"],
      simulation: { is_honeypot: false, simulated: true, buy_tax_pct: 0, sell_tax_pct: 0, risk: "low" },
      sources: ["goplus (static)", "honeypot.is (dynamic sim)"],
    },
  },
  {
    method: "GET", path: "/onchain/liquidity", price: P.liquidity,
    description: "Liquidity-DRAIN detector from a SELF-COLLECTED reserve time-series (exists nowhere for free — we poll pool reserves over time). Answers 'is liquidity leaving this pool right now?' — the earliest sign of a rug or dump in progress. Returns draining_fast/draining/stable/growing + %-change over 1h and the observed window. First call on a cold token returns 404 (uncharged) and starts tracking it; call again once history has built. EVM chains only.",
    input: {
      address: { type: "string", required: true, example: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism"] },
    },
    output_example: {
      verdict: "draining_fast", chain: "base", address: "0x4ed4…", liquidity_usd_now: 812000,
      change_pct_1h: -31.4, change_pct_window: -44.2, window_minutes: 190, data_points: 63,
      note: "liquidity falling fast — possible rug/exit in progress",
    },
  },
  {
    method: "GET", path: "/derivs", price: P.derivs,
    description: "Perp derivatives intel: live funding rate (hourly + annualized), open interest, 24h move, and a crowded-long/short positioning signal.",
    input: { symbol: { type: "string", required: false, default: "BTC", example: "ETH" } },
    output_example: {
      symbol: "BTC", mark_price: 63943, change_24h_pct: 0.4,
      funding: { hourly_rate: 0.0000125, annualized_pct: 10.95 },
      open_interest: { contracts: 39322, usd: 2514265000 }, signal: "neutral",
    },
  },
  {
    method: "GET", path: "/vet", price: P.vet,
    description: "FLAGSHIP ANSWER: one-call token go/no-go. Fuses DEX market structure + the COMPOSITE rug score (static + LIVE buy/sell simulation + serial-rugger) + our self-collected LIQUIDITY-DRAIN trend into one verdict your agent acts on directly: clear / caution / avoid, with reasons. Replaces 4+ raw lookups and the inference to reconcile them; catches honeypots and rugs-in-progress a single free feed misses. Supports EVM chains AND Solana.",
    input: {
      address: { type: "string", required: true, example: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism", "solana"] },
    },
    output_example: {
      verdict: "avoid", confidence: "high",
      why: ["security: high simulated sell tax 35%", "liquidity: draining fast (-31.4% over 190m) — possible rug in progress"],
      token: { symbol: "SCAMCOIN" }, market: { price_usd: 0.0000041, liquidity_usd: 812000 },
      security: { risk_score: 40, needs_review: false, red_flags: ["high simulated sell tax 35%"], simulation: { is_honeypot: false, sell_tax_pct: 35 } },
      liquidity_trend: { verdict: "draining_fast", change_pct_1h: -31.4, window_minutes: 190 },
    },
  },
  {
    method: "GET", path: "/brief", price: P.brief,
    description: "ANSWER: one-call market regime read for a symbol. Spot + 24h move + perp funding/OI + market sentiment distilled to risk_on / risk_off / neutral with reasons. One call arms a trading agent's context window.",
    input: { symbol: { type: "string", required: false, default: "BTC", example: "ETH" } },
    output_example: {
      regime: "neutral", symbol: "BTC",
      why: ["24h move +0.4%", "funding 10.95% annualized — balanced", "sentiment 25/100 (Extreme Fear)"],
      price_usd: 63950, derivatives: { funding_annualized_pct: 10.95, positioning: "neutral" },
      sentiment: { value: 25, label: "Extreme Fear" },
    },
  },
  {
    method: "GET", path: "/screen", price: P.screen,
    description: "ANSWER: batch rug/safety screen. Give a chain and up to 8 token addresses; get each token's verdict + risk score sorted safest-first, plus a clear/caution/avoid summary. Screen a watchlist or the newest launches in one call.",
    input: {
      addresses: { type: "string", required: true, example: "0x6982508145454ce325ddbe47a25d4ec3d2311933,0x4200000000000000000000000000000000000006" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism"] },
    },
    output_example: { chain: "base", summary: { screened: 2, clear: 1, caution: 1, avoid: 0 }, tokens: [{ symbol: "WETH", verdict: "ok", risk_score: 0 }] },
  },
  {
    method: "GET", path: "/etf/flows", price: P.etfFlows,
    description: "Skip parsing 10+ SEC filings and Yahoo Finance feeds yourself -- one call returns volume-weighted net flow estimates for US spot BTC/ETH ETFs with same-day freshness (SEC N-PORT lags T+30). Aggregates 10+ OHLCV sources and does the flow math so a bot saves ~15 minutes of multi-source fetch + computation per query.",
    input: {
      symbols: { type: "string", required: true, example: "IBIT,FBTC,ARKB" },
      days: { type: "string", required: false, default: "5", example: "5" },
    },
    output_example: { as_of: "2026-07-25", symbols_queried: ["IBIT", "FBTC", "ARKB"], total_net_flow_usd: 125000000, per_symbol: [{ symbol: "IBIT", net_flow_usd: 80000000, close: 57.32, volume: 12000000 }, { symbol: "FBTC", net_flow_usd: 30000000, close: 55.10, volume: 4500000 }, { symbol: "ARKB", net_flow_usd: 15000000, close: 52.80, volume: 2100000 }], source: "Yahoo Finance OHLCV", methodology: "volume-weighted price-action estimate" },
  },
];

/** priceStr "$0.01" -> decimal string "0.01" (OpenAPI x-payment-info uses decimal USD; the
 *  runtime 402's accepts[].amount stays atomic units elsewhere — different formats by design). */
function decimalPrice(priceStr: string): string {
  return priceStr.replace(/^\$/, "");
}

/** Build the OpenAPI 3.1 discovery document x402scan requires at GET /openapi.json. */
function buildOpenApi(base: string) {
  const paths: Record<string, any> = {};
  for (const e of ENDPOINTS) {
    const parameters = Object.entries(e.input).map(([name, spec]) => ({
      name,
      in: "query",
      required: !!spec.required,
      schema: { type: spec.type, ...(spec.enum ? { enum: spec.enum } : {}), ...(spec.default ? { default: spec.default } : {}) },
      ...(spec.example ? { example: spec.example } : {}),
    }));
    paths[e.path] = {
      get: {
        operationId: e.path.replace(/^\//, "").replace(/\//g, "_"),
        summary: e.description.split(".")[0],
        description: e.description,
        parameters,
        "x-payment-info": {
          protocols: [{ scheme: "exact", network: NETWORK, asset: "USDC" }],
          price: { mode: "fixed", currency: "USD", amount: decimalPrice(e.price) },
        },
        responses: {
          "200": {
            description: "Paid response",
            content: { "application/json": { schema: { type: "object" }, example: e.output_example } },
          },
          "402": { description: "Payment required (x402)" },
        },
      },
    };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: NAME,
      version: "0.4.0",
      description: DESCRIPTION,
      // Presence of contact.email in the openapi.json served at our own domain is
      // how x402scan verifies listing ownership (only the operator controls this).
      contact: { name: NAME, email: "wyattpalm2+x402@gmail.com", url: "https://github.com/wyattpalm2-eng/x402-seller" },
      "x-guidance":
        "Keyless x402 API. GET any path with no payment for the 402 challenge, pay the quoted USDC amount " +
        `on ${IS_MAINNET ? "Base mainnet" : "Base Sepolia"}, retry with X-PAYMENT. Prefer /vet and /brief for ` +
        "decision-ready single-call answers over composing the raw feeds yourself. See /llms.txt for a plain-text guide.",
    },
    servers: [{ url: base }],
    paths,
  };
}

function baseUrl(req: Request): string {
  // Pin to PUBLIC_BASE_URL when set (recommended once you have a stable domain) so
  // a spoofed Host header can't rewrite the advertised resource URLs. Falls back to
  // the request's proto/host for local + tunnel use.
  const pinned = process.env.PUBLIC_BASE_URL?.trim();
  if (pinned) return pinned.replace(/\/+$/, "");
  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "http";
  const host = req.headers.host || `localhost:${process.env.PORT || 4021}`;
  return `${proto}://${host}`;
}

export const discoveryRouter: Router = Router();

discoveryRouter.get("/.well-known/x402.json", (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    x402Version: 2,
    name: NAME,
    description: DESCRIPTION,
    why_pay: WHY_PAY,
    network: NETWORK,
    asset: "USDC",
    payTo: getReceiveAddress(),
    facilitator: FACILITATOR,
    resources: ENDPOINTS.map((e) => ({
      resource: `${base}${e.path}`,
      method: e.method,
      accepts: [{ scheme: "exact", network: NETWORK, price: e.price, asset: "USDC", payTo: getReceiveAddress() }],
      description: e.description,
      mimeType: "application/json",
      input: e.input,
      output_example: e.output_example.source ? { ...e.output_example, source: "x402-seller" } : e.output_example,
    })),
  });
});

discoveryRouter.get("/.well-known/agent.json", (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    name: NAME,
    description: DESCRIPTION,
    why_pay: WHY_PAY,
    version: "0.4.0",
    url: base,
    protocols: ["x402"],
    provider: { wallet: getReceiveAddress(), network: NETWORK, mainnet: IS_MAINNET },
    pricing: { currency: "USDC", model: "per-request", settlement: "x402 on Base" },
    skills: ENDPOINTS.map((e) => ({
      name: e.path.replace(/^\//, "").replace(/\//g, "_"),
      endpoint: `${base}${e.path}`,
      method: e.method,
      price: e.price,
      description: e.description,
      input: e.input,
      output_example: e.output_example.source ? { ...e.output_example, source: "x402-seller" } : e.output_example,
    })),
    discovery: { x402: `${base}/.well-known/x402.json`, catalog: `${base}/catalog`, stats: `${base}/stats`, llms: `${base}/llms.txt`, openapi: `${base}/openapi.json`, examples: `${base}/examples`, track_record: `${base}/track-record` },
    repository: "https://github.com/wyattpalm2-eng/x402-seller",
    documentation: base,
  });
});

// llms.txt — the AI-readable docs convention. LLM crawlers and agents fetch this
// first; it is the sales pitch and the integration manual in one plain-text file.
// OpenAPI discovery doc — the canonical contract x402scan (and other directory
// crawlers) fetch at GET /openapi.json to validate and list this service.
discoveryRouter.get("/openapi.json", (req: Request, res: Response) => {
  res.json(buildOpenApi(baseUrl(req)));
});

// FREE try-before-you-buy showroom: every paid endpoint with a realistic SAMPLE
// output, so an evaluating agent can see exactly what it gets before paying.
// Samples are static examples (not live data) — the paywall still guards the real thing.
discoveryRouter.get("/examples", (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    note: "Free samples so you can evaluate before paying. These are illustrative, not live — call the endpoint (and pay the quoted USDC) for real-time data.",
    network: NETWORK,
    endpoints: ENDPOINTS.map((e) => ({
      call: `${e.method} ${base}${e.path}`,
      price: e.price,
      description: e.description,
      input: e.input,
      sample_output: e.output_example,
    })),
  });
});

// 402index.io domain-verification proof (public domain-proof token, not a secret).
// Verified domains get instant approval + self-service editing on the directory.
discoveryRouter.get("/.well-known/402index-verify.txt", (_req: Request, res: Response) => {
  res.type("text/plain").send("81e436127078c2aa3a02c6397f75eb1a99298d7c584e6a366daf6f077d468367");
});

// favicon — x402scan flags its absence; makes the marketplace listing look real.
// Tiny inline SVG "$" mark, no binary asset needed.
discoveryRouter.get("/favicon.ico", (_req: Request, res: Response) => {
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">` +
    `<rect width="32" height="32" rx="6" fill="#111"/>` +
    `<text x="16" y="23" font-size="20" font-family="monospace" fill="#4ade80" text-anchor="middle">$</text></svg>`;
  res.type("image/svg+xml").set("Cache-Control", "public, max-age=86400").send(svg);
});

discoveryRouter.get("/llms.txt", (req: Request, res: Response) => {
  const base = baseUrl(req);
  const lines = [
    `# ${NAME}`,
    "",
    `> ${DESCRIPTION}`,
    "",
    "## The Truth Engine (why you can trust the numbers)",
    "Every endpoint here grades itself against reality in public, forever — hits AND misses:",
    `- rug scorer:   ${base}/track-record (human: ${base}/accuracy) — verdicts on fresh launches graded 6h later`,
    `- weather:      ${base}/truth/weather — day-max forecasts graded vs the independent ERA5 archive`,
    `- market calls: ${base}/truth/signal — /signal + /brief verdicts graded 24h later vs realized spot`,
    `- index:        ${base}/truth · all ledgers git-snapshotted (a verdict can't be rewritten after reality grades it)`,
    `Who runs this + the real books (live on-chain revenue): ${base}/company`,
    "",
    "## Why pay instead of using free APIs",
    ...WHY_PAY.map((w) => `- ${w}`),
    "",
    "## How to pay (x402)",
    "1. GET any paid endpoint with no payment -> HTTP 402 + PAYMENT-REQUIRED header (base64 JSON: amount, USDC contract, payTo, network).",
    `2. Pay that amount in USDC on ${IS_MAINNET ? "Base mainnet" : "Base Sepolia testnet"} and retry with the X-PAYMENT header (any x402 client library does this automatically, e.g. @x402/fetch).`,
    "3. Response is verdict-first JSON. No account, no API key, ever.",
    "",
    "## Endpoints",
    ...ENDPOINTS.map((e) => `- ${e.method} ${base}${e.path} — ${e.price} — ${e.description}`),
    "",
    "## Machine-readable",
    `- x402 manifest: ${base}/.well-known/x402.json`,
    `- agent card:    ${base}/.well-known/agent.json`,
    `- catalog:       ${base}/catalog`,
    `- free samples:  ${base}/examples  (see every endpoint output before paying)`,
    `- track record:  ${base}/track-record  (our verdicts graded against real outcomes — hits AND misses, free)`,
    "",
    `payTo: ${getReceiveAddress()}  network: ${NETWORK}  asset: USDC`,
  ];
  res.type("text/plain").send(lines.join("\n"));
});
