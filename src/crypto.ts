/**
 * crypto.ts — on-chain / DeFi data aggregator. THE moat: real-time token,
 * liquidity, launch, and TVL data an agent can't trivially assemble itself,
 * stitched from free keyless sources (DexScreener, GeckoTerminal, DeFiLlama).
 *
 * SECURITY (SSRF + injection defense):
 *  - `chain` is resolved through a fixed ALLOWLIST → upstream slug. Unknown chains
 *    are rejected, so a caller can never steer a fetch to another host.
 *  - `address` must match a strict EVM/Solana regex; `query` a strict charset.
 *  - All interpolated values are additionally encodeURIComponent'd (belt + braces).
 *  - Handlers never echo upstream error text to the client (no internal leak).
 */
import { Router, type Request, type Response } from "express";
import { cached, getJson } from "./data.js";
import { getReceiveAddress } from "./wallet.js";
import { recordSale, priceToUsd } from "./stats.js";

const NETWORK = process.env.NETWORK?.trim() || "eip155:84532";

export const PRICE_TOKEN = process.env.PRICE_ONCHAIN_TOKEN || "$0.005";
export const PRICE_TRENDING = process.env.PRICE_ONCHAIN_TRENDING || "$0.005";
export const PRICE_NEW = process.env.PRICE_ONCHAIN_NEW || "$0.01";
export const PRICE_DEFI = process.env.PRICE_ONCHAIN_DEFI || "$0.005";

// ─── Allowlists / validators ────────────────────────────────────────────────
// our slug -> upstream identifiers. Anything NOT in this map is rejected.
const CHAINS: Record<string, { gt: string; ds: string; llama: string }> = {
  base: { gt: "base", ds: "base", llama: "Base" },
  eth: { gt: "eth", ds: "ethereum", llama: "Ethereum" },
  ethereum: { gt: "eth", ds: "ethereum", llama: "Ethereum" },
  solana: { gt: "solana", ds: "solana", llama: "Solana" },
  bsc: { gt: "bsc", ds: "bsc", llama: "BSC" },
  polygon: { gt: "polygon_pos", ds: "polygon", llama: "Polygon" },
  arbitrum: { gt: "arbitrum", ds: "arbitrum", llama: "Arbitrum" },
  optimism: { gt: "optimism", ds: "optimism", llama: "OP Mainnet" },
};
export const SUPPORTED_CHAINS = Object.keys(CHAINS);
const DEFAULT_CHAIN = "base";

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const QUERY_RE = /^[A-Za-z0-9 ._-]{1,32}$/;

export function chainInfo(input: unknown): { key: string; gt: string; ds: string; llama: string } | null {
  const c = String(input ?? DEFAULT_CHAIN).toLowerCase().trim();
  return Object.prototype.hasOwnProperty.call(CHAINS, c) ? { key: c, ...CHAINS[c] } : null;
}
export function isValidAddress(a: unknown): boolean {
  const s = String(a ?? "");
  return EVM_ADDR.test(s) || SOL_ADDR.test(s);
}
export function isValidQuery(q: unknown): boolean {
  return QUERY_RE.test(String(q ?? ""));
}

/**
 * Pre-paywall validation. Returns an error string for a malformed request so the
 * server can 400 it BEFORE charging — a bot never pays for a doomed call.
 */
export function validateOnchain(path: string, q: Record<string, any>): string | null {
  if (q.chain !== undefined && !chainInfo(q.chain)) {
    return `unsupported chain "${String(q.chain).slice(0, 24)}". supported: ${SUPPORTED_CHAINS.join(", ")}`;
  }
  if (path === "/onchain/token") {
    if (q.address === undefined && q.query === undefined) return "provide ?address= or ?query=";
    if (q.address !== undefined && !isValidAddress(q.address)) return "invalid token address";
    if (q.query !== undefined && !isValidQuery(q.query)) return "invalid query (1-32 chars: letters, digits, space, . _ -)";
  }
  return null;
}

// ─── Normalizers ──────────────────────────────────────────────────────────
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

function normalizeDsPair(p: any) {
  return {
    chain: p.chainId,
    token: { symbol: p.baseToken?.symbol, name: p.baseToken?.name, address: p.baseToken?.address },
    quote: p.quoteToken?.symbol,
    price_usd: num(p.priceUsd),
    liquidity_usd: num(p.liquidity?.usd),
    volume_24h: num(p.volume?.h24),
    price_change_pct: {
      m5: num(p.priceChange?.m5), h1: num(p.priceChange?.h1),
      h6: num(p.priceChange?.h6), h24: num(p.priceChange?.h24),
    },
    fdv: num(p.fdv),
    market_cap: num(p.marketCap),
    txns_24h: p.txns?.h24 ? { buys: num(p.txns.h24.buys), sells: num(p.txns.h24.sells) } : null,
    dex: p.dexId,
    pair_address: p.pairAddress,
    url: p.url,
  };
}

function bestPair(pairs: any[], dsChain?: string): any | null {
  const scoped = dsChain ? pairs.filter((p) => p?.chainId === dsChain) : pairs;
  const pool = scoped.length ? scoped : pairs;
  if (!pool.length) return null;
  return pool.reduce((best, p) => ((num(p?.liquidity?.usd) ?? 0) > (num(best?.liquidity?.usd) ?? 0) ? p : best), pool[0]);
}

function normalizeGtPool(d: any) {
  const a = d?.attributes ?? {};
  return {
    name: a.name,
    pool_address: a.address,
    price_usd: num(a.base_token_price_usd),
    liquidity_usd: num(a.reserve_in_usd),
    volume_24h: num(a.volume_usd?.h24),
    price_change_24h_pct: num(a.price_change_percentage?.h24),
    fdv: num(a.fdv_usd),
    market_cap: num(a.market_cap_usd),
    created_at: a.pool_created_at ?? null,
    txns_24h: a.transactions?.h24 ? { buys: num(a.transactions.h24.buys), sells: num(a.transactions.h24.sells) } : null,
  };
}

// ─── Data assembly ──────────────────────────────────────────────────────────
async function tokenSnapshot(address?: string, query?: string, chainKey?: string) {
  const ci = chainKey ? chainInfo(chainKey) : null;
  let pairs: any[] = [];
  if (address) {
    const j = await cached(`ds:tok:${address.toLowerCase()}`, () =>
      getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`),
    );
    pairs = j?.pairs ?? [];
  } else if (query) {
    const j = await cached(`ds:q:${query.toLowerCase()}`, () =>
      getJson(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`),
    );
    pairs = j?.pairs ?? [];
  }
  const p = bestPair(pairs, ci?.ds);
  if (!p) return null;
  return {
    query: address ?? query,
    ...normalizeDsPair(p),
    pairs_considered: pairs.length,
    source: "dexscreener",
    as_of: new Date().toISOString(),
  };
}

async function poolsFeed(chainKey: string, kind: "trending_pools" | "new_pools") {
  const ci = chainInfo(chainKey)!; // validated upstream
  const j = await cached(`gt:${kind}:${ci.gt}`, () =>
    getJson(`https://api.geckoterminal.com/api/v2/networks/${ci.gt}/${kind}`),
  );
  const pools = (j?.data ?? []).slice(0, 15).map(normalizeGtPool);
  return { chain: ci.key, count: pools.length, pools, source: "geckoterminal", as_of: new Date().toISOString() };
}

async function defiSnapshot(chainKey: string) {
  const ci = chainInfo(chainKey)!;
  const [chains, protocols] = await Promise.all([
    cached("llama:chains", () => getJson("https://api.llama.fi/v2/chains")),
    cached("llama:protocols", () => getJson("https://api.llama.fi/protocols")).catch(() => null),
  ]);
  const chainRow = (chains ?? []).find((c: any) => c?.name === ci.llama);
  let top: any[] = [];
  if (Array.isArray(protocols)) {
    top = protocols
      .filter((p: any) => p?.chainTvls && typeof p.chainTvls[ci.llama] === "number")
      .map((p: any) => ({ name: p.name, category: p.category, tvl_on_chain_usd: num(p.chainTvls[ci.llama]), url: p.url ?? null }))
      .sort((a, b) => (b.tvl_on_chain_usd ?? 0) - (a.tvl_on_chain_usd ?? 0))
      .slice(0, 5);
  }
  return { chain: ci.key, tvl_usd: num(chainRow?.tvl), top_protocols: top, source: "defillama", as_of: new Date().toISOString() };
}

// ─── Router ─────────────────────────────────────────────────────────────────
export const cryptoRouter: Router = Router();

async function serve(
  res: Response,
  route: string,
  priceUsd: number,
  label: string | undefined,
  fn: () => Promise<any>,
) {
  try {
    const data = await fn();
    if (data == null) return res.status(404).json({ error: "not_found", detail: "no data for that request" });
    recordSale(route, priceUsd, label);
    res.json(data);
  } catch (err: any) {
    console.error(`[onchain] ${route} error:`, err?.message ?? err); // detail stays server-side
    res.status(502).json({ error: "upstream_unavailable" });
  }
}

cryptoRouter.get("/onchain/token", (req, res) => {
  const address = req.query.address ? String(req.query.address) : undefined;
  const query = req.query.query ? String(req.query.query) : undefined;
  const chain = req.query.chain ? String(req.query.chain) : undefined;
  return serve(res, "GET /onchain/token", priceToUsd(PRICE_TOKEN), address ?? query, () =>
    tokenSnapshot(address, query, chain),
  );
});

cryptoRouter.get("/onchain/trending", (req, res) => {
  const chain = String(req.query.chain ?? DEFAULT_CHAIN);
  return serve(res, "GET /onchain/trending", priceToUsd(PRICE_TRENDING), chain, () => poolsFeed(chain, "trending_pools"));
});

cryptoRouter.get("/onchain/new", (req, res) => {
  const chain = String(req.query.chain ?? DEFAULT_CHAIN);
  return serve(res, "GET /onchain/new", priceToUsd(PRICE_NEW), chain, () => poolsFeed(chain, "new_pools"));
});

cryptoRouter.get("/onchain/defi", (req, res) => {
  const chain = String(req.query.chain ?? DEFAULT_CHAIN);
  return serve(res, "GET /onchain/defi", priceToUsd(PRICE_DEFI), chain, () => defiSnapshot(chain));
});

// ─── x402 paywall config + catalog (shapes match index.ts) ──────────────────
function accept(price: string, description: string) {
  return {
    accepts: [{ scheme: "exact", price, network: NETWORK, payTo: getReceiveAddress() }],
    description,
    mimeType: "application/json",
  };
}

export const cryptoRoutes = {
  "GET /onchain/token": accept(PRICE_TOKEN, "On-chain token snapshot: price, liquidity, volume, 24h change, FDV"),
  "GET /onchain/trending": accept(PRICE_TRENDING, "Trending DEX pools for a chain"),
  "GET /onchain/new": accept(PRICE_NEW, "Newly launched DEX pools for a chain (launch hunting)"),
  "GET /onchain/defi": accept(PRICE_DEFI, "Chain TVL + top DeFi protocols"),
};

export const cryptoCatalog = [
  { route: "GET /onchain/token", price: PRICE_TOKEN, params: "?query=PEPE  |  ?chain=base&address=0x…", desc: "Token snapshot: price/liquidity/volume/24h/FDV (DexScreener)" },
  { route: "GET /onchain/trending", price: PRICE_TRENDING, params: "?chain=base", desc: "Trending DEX pools (GeckoTerminal)" },
  { route: "GET /onchain/new", price: PRICE_NEW, params: "?chain=base", desc: "Newly launched pools — launch hunting (GeckoTerminal)" },
  { route: "GET /onchain/defi", price: PRICE_DEFI, params: "?chain=base", desc: "Chain TVL + top protocols (DeFiLlama)" },
];
