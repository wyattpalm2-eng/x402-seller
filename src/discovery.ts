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
  "Decision-ready market + on-chain intelligence for autonomous agents. Keyless by design: " +
  "no signup, no API key, no rate-limit account — pay a cent per request in USDC (x402) and get " +
  "verdict-first JSON built to be cheap to reason over. ANSWER endpoints (/vet token due diligence, " +
  "/brief market regime) replace 2-3 raw API calls + signup walls + parsing tokens with one call. " +
  "Plus raw feeds: prices, stocks, DEX pools, new launches, rug checks, perp funding/OI.";
const WHY_PAY = [
  "keyless: an agent cannot fill signup forms or manage API keys — x402 payment IS the auth",
  "one call per decision: /vet and /brief merge multiple sources into a verdict, saving the caller's inference tokens",
  "verdict-first JSON: read field 1, act; reasons included for audit",
  "always-warm cache: no 429s, no free-tier throttling, stale-while-revalidate under the hood",
];

const P = {
  price: process.env.PRICE_CRYPTO || "$0.001",
  stock: process.env.PRICE_STOCK || "$0.002",
  markets: process.env.PRICE_MARKETS || "$0.005",
  signal: process.env.PRICE_SIGNAL || "$0.01",
  token: process.env.PRICE_ONCHAIN_TOKEN || "$0.005",
  trending: process.env.PRICE_ONCHAIN_TRENDING || "$0.005",
  newp: process.env.PRICE_ONCHAIN_NEW || "$0.01",
  defi: process.env.PRICE_ONCHAIN_DEFI || "$0.005",
  safety: process.env.PRICE_ONCHAIN_SAFETY || "$0.01",
  derivs: process.env.PRICE_DERIVS || "$0.01",
  vet: process.env.PRICE_VET || "$0.02",
  brief: process.env.PRICE_BRIEF || "$0.02",
};

interface Endpoint {
  method: "GET";
  path: string;
  price: string;
  description: string;
  input: Record<string, { type: string; required: boolean; default?: string; example?: string; enum?: string[] }>;
  output_example: any;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "GET", path: "/price", price: P.price,
    description: "Spot crypto price in USD.",
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
      query: { type: "string", required: false, example: "PEPE" },
      address: { type: "string", required: false, example: "0x6982508145454ce325 ...", },
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
    description: "Chain TVL and top DeFi protocols by TVL on that chain.",
    input: { chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "solana", "bsc", "polygon", "arbitrum", "optimism"] } },
    output_example: { chain: "base", tvl_usd: 4527177464, top_protocols: [{ name: "Aave V3", category: "Lending", tvl_on_chain_usd: 900000000 }], source: "defillama" },
  },
  {
    method: "GET", path: "/onchain/safety", price: P.safety,
    description: "Token rug/honeypot safety report: contract red flags (honeypot, taxes, hidden mint, LP lock), 0-100 risk score, ok/warning/danger verdict. EVM chains only.",
    input: {
      address: { type: "string", required: true, example: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism"] },
    },
    output_example: {
      chain: "eth", token: { symbol: "PEPE" }, verdict: "ok", risk_score: 0,
      red_flags: [], details: { honeypot: false, sell_tax_pct: 0, lp_locked: true, holder_count: 571757 },
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
    description: "ANSWER: one-call token due diligence. Merges DEX market structure + contract security into a verdict your agent can act on directly: clear / caution / avoid, with reasons. Replaces 2-3 raw lookups and the tokens to reconcile them.",
    input: {
      address: { type: "string", required: true, example: "0x6982508145454ce325ddbe47a25d4ec3d2311933" },
      chain: { type: "string", required: false, default: "base", enum: ["base", "eth", "bsc", "polygon", "arbitrum", "optimism"] },
    },
    output_example: {
      verdict: "caution", confidence: "high",
      why: ["security: blacklist function present", "market: thin liquidity ($8,400)"],
      token: { symbol: "PEPE" }, market: { price_usd: 0.0000271, liquidity_usd: 8400 },
      security: { risk_score: 25, red_flags: ["blacklist function present"] },
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
      version: "0.3.0",
      description: DESCRIPTION,
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
    version: "0.3.0",
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
    discovery: { x402: `${base}/.well-known/x402.json`, catalog: `${base}/catalog`, stats: `${base}/stats`, llms: `${base}/llms.txt`, openapi: `${base}/openapi.json` },
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
    "",
    `payTo: ${getReceiveAddress()}  network: ${NETWORK}  asset: USDC`,
  ];
  res.type("text/plain").send(lines.join("\n"));
});
