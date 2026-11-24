/**
 * Every paid route's default price, in ONE place.
 *
 * Prices used to be defined twice: once where each route charged, and again in discovery.ts for
 * openapi.json / x402.json. The copies drifted: the discovery files advertised /vet at $0.005 while
 * it charged $0.05, and /screen at $0.01 while it charged $0.05. Every module now reads from here,
 * so the price an agent is quoted in a directory is the price it is charged. A PRICE_* environment
 * variable still overrides a default.
 *
 * 2026-11-24 re-price, from on-chain revenue of the 352 crypto sellers in Coinbase's Bazaar and
 * PayAI: sellers at $0.005 or less took about 77% of the category's revenue, and the category
 * leader charges ~$0.002. Everyday market answers moved to $0.003, batches to $0.005, /vet to $0.02.
 */
export const DEFAULT_PRICES = {
  // everyday market answers
  PRICE_CRYPTO: "$0.003", // /price
  PRICE_STOCK: "$0.003",
  PRICE_MARKETS: "$0.003",
  PRICE_SIGNAL: "$0.003",
  PRICE_BRIEF: "$0.003",
  PRICE_MOVERS: "$0.003",
  PRICE_PULSE: "$0.003",
  PRICE_DEPEG: "$0.003",
  PRICE_STABLE_FLOWS: "$0.003",
  PRICE_DERIVS: "$0.003",
  PRICE_ONCHAIN_TOKEN: "$0.003",
  PRICE_ONCHAIN_TRENDING: "$0.003",
  PRICE_ONCHAIN_NEW: "$0.003",
  PRICE_ONCHAIN_DEFI: "$0.003",
  // batches
  PRICE_CRYPTO_BATCH: "$0.005", // /prices
  PRICE_SIGNALS: "$0.005", // /watchlist
  PRICE_BRIEFS: "$0.005",
  // token judgment
  PRICE_VET: "$0.02",
  PRICE_ONCHAIN_SAFETY: "$0.05",
  PRICE_SCREEN: "$0.05",
  PRICE_TOKEN_WASH: "$0.03",
  PRICE_ALPHA: "$0.01",
  PRICE_ONCHAIN_LIQUIDITY: "$0.01",
  PRICE_TOKEN_RISK: "$0.01",
  PRICE_TOKEN_CONCENTRATION: "$0.01",
  PRICE_WALLET_FINGERPRINT: "$0.01",
  PRICE_DEPLOYER_REPUTATION: "$0.05",
  PRICE_X402_CHECK: "$0.005",
  // other data
  PRICE_WEATHER: "$0.01",
  PRICE_WX_AG: "$0.01",
  PRICE_AG_METRICS: "$0.01",
  PRICE_STORM_RISK: "$0.01",
  PRICE_ETF_FLOWS: "$0.01",
  PRICE_YIELD_SURFACE: "$0.01",
} as const;

export type PriceKey = keyof typeof DEFAULT_PRICES;

/** The price for a route: its PRICE_* environment override if set, else the default above. */
export function price(key: PriceKey): string {
  const v = process.env[key]?.trim();
  return v || DEFAULT_PRICES[key];
}
