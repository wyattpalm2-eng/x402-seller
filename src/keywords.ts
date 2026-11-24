/**
 * Plain-words labels put in FRONT of each paid route's description.
 *
 * Directories (x402scan, CDP Bazaar, PayAI, 402index) build their listings and their search from
 * these descriptions. A findability test on 2026-11-23 searched 402index for "rug", "honeypot",
 * "token safety", "market regime", "crypto price" and "wash trading" and this service was in the
 * top 20 for none of them: the descriptions explained the model, but did not use the words a buyer
 * types. Each label says what the route is in those words. They must stay literally true.
 *
 * Keys are paths with :params (the form used in `routes`); discovery paths use {params} and are
 * normalized below.
 */
export const LABELS: Record<string, string> = {
  "/vet": "Rug pull and honeypot check for any token (EVM + Solana).",
  "/onchain/safety": "Honeypot detector and rug pull risk score.",
  "/screen": "Batch rug pull and honeypot check, up to 8 tokens.",
  "/token/wash/:address": "Wash trading detector: is this token's volume fake?",
  "/alpha/launches": "New token launch scanner with a rug pull check on each.",
  "/token/risk/:address": "Token risk score, 0 to 100.",
  "/onchain/liquidity": "Liquidity pull detector: is this pool being drained right now?",
  "/token/concentration/:address": "Token holder concentration (whale check).",
  "/wallet/fingerprint/:address": "Wallet risk profile.",
  "/brief": "Crypto market regime: risk on or risk off.",
  "/briefs": "Crypto market regime for a basket of coins.",
  "/pulse": "Crypto market overview: regime, breadth, top movers, fear and greed.",
  "/movers": "Crypto top gainers and losers.",
  "/signal": "Crypto trading signal: bullish, bearish or neutral.",
  "/watchlist": "Crypto trading signals for a watchlist.",
  "/price": "Crypto price API.",
  "/prices": "Crypto prices API, many coins in one call.",
  "/markets": "Crypto market data: top coins with 24h change.",
  "/derivs": "Crypto funding rates and open interest.",
  "/depeg": "Stablecoin depeg monitor.",
  "/stablecoins/flows": "Stablecoin flows by chain: where money is moving.",
  "/x402/check": "x402 seller trust check: should my agent pay this endpoint?",
};

const norm = (p: string) => p.replace(/\{(\w+)\}/g, ":$1");

/** Prefix a description with its route's label, once. */
export function labeled(path: string, description: string): string {
  const label = LABELS[norm(path)];
  if (!label || description.startsWith(label)) return description;
  return `${label} ${description}`;
}
