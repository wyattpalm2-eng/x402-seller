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
  "Per-request market + on-chain data for AI agents, paid in USDC on Base via x402. " +
  "Crypto spot prices, stock quotes, market snapshots, a composite trade signal, and " +
  "an on-chain suite (token intelligence, trending + newly-launched DEX pools, DeFi TVL).";

const P = {
  price: process.env.PRICE_CRYPTO || "$0.001",
  stock: process.env.PRICE_STOCK || "$0.002",
  markets: process.env.PRICE_MARKETS || "$0.005",
  signal: process.env.PRICE_SIGNAL || "$0.01",
  token: process.env.PRICE_ONCHAIN_TOKEN || "$0.005",
  trending: process.env.PRICE_ONCHAIN_TRENDING || "$0.005",
  newp: process.env.PRICE_ONCHAIN_NEW || "$0.01",
  defi: process.env.PRICE_ONCHAIN_DEFI || "$0.005",
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
];

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
      output_example: e.output_example,
    })),
  });
});

discoveryRouter.get("/.well-known/agent.json", (req: Request, res: Response) => {
  const base = baseUrl(req);
  res.json({
    name: NAME,
    description: DESCRIPTION,
    version: "0.2.0",
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
      output_example: e.output_example,
    })),
    discovery: { x402: `${base}/.well-known/x402.json`, catalog: `${base}/catalog`, stats: `${base}/stats` },
    documentation: base,
  });
});
