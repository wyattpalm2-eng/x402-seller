/**
 * premium.ts — one PREMIUM paid endpoint with real edge.
 *
 *   GET /signal?symbol=BTC   →   $0.01
 *
 * A composite market signal that blends three free, keyless signals into a
 * single verdict an agent would actually pay for (vs. re-deriving it itself):
 *   (a) current spot price          — Coinbase (crypto) / Yahoo (equities fallback)
 *   (b) 24h % change                — CoinGecko markets (crypto) / Yahoo prev-close
 *   (c) a simple momentum score     — blended, bounded to -1..1
 *
 * This file is fully self-contained and adds NO new npm deps. It reuses the
 * proven fetchers in ./data.ts (Coinbase spot, CoinGecko markets, Yahoo) so the
 * numbers match the existing paid routes.
 *
 * An integrator wires this in without touching index.ts:
 *     import { premiumRouter, premiumRoutes, premiumCatalog } from "./premium.js";
 *     app.get("/health", ...); app.get("/catalog", ...);        // free routes first
 *     app.use(paymentMiddleware({ ...routes, ...premiumRoutes }, resourceServer));
 *     app.use(premiumRouter);                                    // paid handler after paywall
 *     const catalog = [...CATALOG, ...premiumCatalog];
 *
 * ── BONUS: StockFit /fundamentals (NOT wired here, by design) ───────────────
 * A Bearer key exists at ../the_desk/data/stockfit.key (starts "fl_..."). StockFit
 * is an MCP-not-REST service, so a future /fundamentals endpoint would NOT fetch()
 * it directly from this process: it would run a tiny server-side MCP client that
 * loads that key, calls a StockFit fundamentals tool (P/E, margins, earnings), and
 * folds the result into a `components.fundamentals` block — priced higher (e.g.
 * $0.05) since it's paid, non-free data. No MCP is imported now: this endpoint
 * stays keyless and self-contained. Wiring MCP is a separate task.
 */

import { Router, type Request, type Response } from "express";
import { cryptoPrice, stockQuote, topMarkets } from "./data.js";
import { getReceiveAddress } from "./wallet.js";
import { recordSale, priceToUsd } from "./stats.js";

// Price per call — kept here so the integrator sees one source of truth.
export const PREMIUM_PRICE = process.env.PRICE_SIGNAL || "$0.01";

// ─── Signal math ───────────────────────────────────────────────────────────

/** Clamp to the closed interval [lo, hi]. */
function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Momentum score in [-1, 1] from the 24h move and (when available) the coin's
 * position inside its 24h high/low range.
 *
 *  - `changeComponent` maps the 24h % change through tanh so a ±5% day ≈ ±0.76,
 *    saturating gracefully on big moves instead of blowing past the bound.
 *  - `rangeComponent` is where price sits between the 24h low and high, recentred
 *    to [-1, 1] (near the high = +, near the low = −). Undefined ⇒ contributes 0.
 *
 * The two are averaged (range weighted lighter) and re-clamped to [-1, 1].
 */
function momentumScore(
  change24hPct: number | undefined,
  price: number | undefined,
  low24h: number | undefined,
  high24h: number | undefined,
): { momentum: number; changeComponent: number; rangeComponent: number | null } {
  const chg = Number.isFinite(change24hPct as number) ? (change24hPct as number) : 0;
  const changeComponent = Math.tanh(chg / 5); // ±5% ⇒ ~±0.76

  let rangeComponent: number | null = null;
  if (
    Number.isFinite(price as number) &&
    Number.isFinite(low24h as number) &&
    Number.isFinite(high24h as number) &&
    (high24h as number) > (low24h as number)
  ) {
    const pos = ((price as number) - (low24h as number)) / ((high24h as number) - (low24h as number)); // 0..1
    rangeComponent = clamp(pos * 2 - 1, -1, 1); // -1 at low, +1 at high
  }

  const momentum =
    rangeComponent === null
      ? clamp(changeComponent, -1, 1)
      : clamp(changeComponent * 0.7 + rangeComponent * 0.3, -1, 1);

  return { momentum: Number(momentum.toFixed(4)), changeComponent: Number(changeComponent.toFixed(4)), rangeComponent };
}

function verdictFor(momentum: number): "bullish" | "bearish" | "neutral" {
  if (momentum >= 0.15) return "bullish";
  if (momentum <= -0.15) return "bearish";
  return "neutral";
}

// ─── Data assembly ──────────────────────────────────────────────────────────

interface SignalInputs {
  price_usd: number;
  change_24h_pct?: number;
  low_24h?: number;
  high_24h?: number;
  source: string;
  base: string;
}

/** Is this symbol an equity/ETF ticker rather than a crypto asset? */
function looksLikeEquity(sym: string): boolean {
  // Crypto pairs contain "-" (BTC-USD) or are known short crypto tickers.
  if (sym.includes("-")) return false;
  const crypto = new Set(["BTC", "ETH", "SOL", "XRP", "ADA", "DOGE", "AVAX", "DOT", "LINK", "MATIC", "LTC", "BCH", "USDC", "USDT", "BNB", "TRX", "SHIB", "TON", "NEAR", "ARB", "OP"]);
  if (crypto.has(sym)) return false;
  // 3-5 letter alpha ticker with no crypto match ⇒ treat as equity.
  return /^[A-Z]{1,5}$/.test(sym);
}

/**
 * Gather price + 24h change + range for a symbol from the free sources.
 * Crypto: Coinbase spot for the exact price, CoinGecko markets for the 24h %
 * change and high/low. Equities: Yahoo quote (price, prev-close change).
 */
async function gatherInputs(symbol: string): Promise<SignalInputs> {
  const sym = symbol.toUpperCase();

  if (looksLikeEquity(sym)) {
    const q = await stockQuote(sym);
    return {
      price_usd: Number(q.price),
      change_24h_pct: typeof q.change_pct === "number" ? q.change_pct : undefined,
      low_24h: typeof q.day_low === "number" ? q.day_low : undefined,
      high_24h: typeof q.day_high === "number" ? q.day_high : undefined,
      source: "yahoo",
      base: String(q.symbol ?? sym),
    };
  }

  // Crypto path. Fetch spot (Coinbase, required) and 24h context (CoinGecko,
  // best-effort) in PARALLEL instead of one-then-the-other.
  const base = sym.includes("-") ? sym.split("-")[0] : sym;
  const [spot, markets] = await Promise.all([
    cryptoPrice(sym),
    topMarkets(50).catch(() => null), // context is optional; a spot price alone still signals
  ]);

  let change24h: number | undefined;
  const low24h: number | undefined = undefined;
  const high24h: number | undefined = undefined;
  const match = markets
    ? (markets.coins as any[]).find(
        (c) => String(c.symbol).toUpperCase() === base || String(c.id).toUpperCase() === base,
      )
    : undefined;
  if (match && typeof match.change_24h_pct === "number") {
    change24h = match.change_24h_pct;
    // CoinGecko markets(per_page=50) omits intraday high/low here, so range stays
    // undefined and momentum leans on the 24h change.
  }

  return {
    price_usd: Number(spot.price_usd),
    change_24h_pct: change24h,
    low_24h: low24h,
    high_24h: high24h,
    source: change24h === undefined ? "coinbase" : "coinbase+coingecko",
    base,
  };
}

/**
 * Is the momentum input actually present? momentumScore() coerces a missing
 * 24h change to 0 (line ~65), and CoinGecko's markets feed carries no intraday
 * high/low — so when that lookup fails, momentum is EXACTLY 0 by construction
 * and the verdict is a constant "neutral" with zero information content.
 *
 * That is a hollow answer, not a signal. Found 2026-07-23 by the Truth Engine
 * itself: nine consecutive ledger rows with momentum exactly 0, while the same
 * code run off-Render returned real verdicts — CoinGecko rate-limits Render's
 * SHARED egress IP (same defect class as the Open-Meteo weather quota). Callers
 * must never be billed for it; see gateConsensus() for the sibling gate.
 */
function hasMomentumContext(inputs: SignalInputs, rangeComponent: number | null): boolean {
  return Number.isFinite(inputs.change_24h_pct as number) || rangeComponent !== null;
}

/**
 * The EXACT signal compute, exported so the Truth Engine grades the same code
 * path buyers pay for (doctrine: every endpoint grades itself — no shadow
 * implementation that could quietly diverge from the paid one).
 *
 * Returns null when there is no real momentum input, so the Truth Engine skips
 * the slot rather than recording a hollow "neutral" as if it were a prediction.
 * A ledger polluted with non-verdicts would corrupt the very honesty mechanism.
 */
export async function signalVerdict(symbol: string): Promise<{
  symbol: string;
  price_usd: number;
  momentum: number;
  verdict: "bullish" | "bearish" | "neutral";
} | null> {
  const inputs = await gatherInputs(symbol);
  if (!Number.isFinite(inputs.price_usd)) return null;
  const { momentum, rangeComponent } = momentumScore(inputs.change_24h_pct, inputs.price_usd, inputs.low_24h, inputs.high_24h);
  if (!hasMomentumContext(inputs, rangeComponent)) return null;
  return { symbol: inputs.base, price_usd: inputs.price_usd, momentum, verdict: verdictFor(momentum) };
}

// ─── Router ─────────────────────────────────────────────────────────────────

export const premiumRouter: Router = Router();

premiumRouter.get("/signal", async (req: Request, res: Response) => {
  const symbol = String(req.query.symbol || "BTC").trim() || "BTC";
  try {
    const inputs = await gatherInputs(symbol);

    if (!Number.isFinite(inputs.price_usd)) {
      // Nothing settled yet at the transport layer here in the wired app, so a
      // clean 502 is the right signal to the buyer's client.
      return res.status(502).json({ error: "upstream_unavailable", detail: `no price for "${symbol}"` });
    }

    const { momentum, changeComponent, rangeComponent } = momentumScore(
      inputs.change_24h_pct,
      inputs.price_usd,
      inputs.low_24h,
      inputs.high_24h,
    );

    // No momentum input ⇒ momentum is 0 by construction and the verdict is a
    // constant "neutral" — a hollow answer. 502 BEFORE recordSale, so the
    // payment is cancelled (>=400) and the caller is NOT billed for junk.
    if (!hasMomentumContext(inputs, rangeComponent)) {
      return res.status(502).json({
        error: "upstream_unavailable",
        detail: "24h change/range context is unavailable right now, so no real momentum can be computed — returning nothing rather than billing you for a hollow 'neutral'. Retry shortly.",
      });
    }

    // Sanitize: never emit bare NaN/Infinity — browser JSON.parse rejects them.
    const safe = (n: number | undefined): number | null =>
      typeof n === "number" && Number.isFinite(n) ? n : null;

    recordSale("GET /signal", priceToUsd(PREMIUM_PRICE), inputs.base);
    return res.json({
      symbol: inputs.base,
      price_usd: safe(inputs.price_usd),
      change_24h_pct: safe(inputs.change_24h_pct),
      momentum, // -1..1
      verdict: verdictFor(momentum),
      components: {
        change_component: changeComponent, // tanh(change/5), -1..1
        range_component: rangeComponent, // position in 24h range, or null
        weights: rangeComponent === null ? { change: 1 } : { change: 0.7, range: 0.3 },
      },
      source: "x402-seller",
      as_of: new Date().toISOString(),
    });
  } catch (err: any) {
    console.error(`[signal] error:`, err?.message ?? err); // detail stays server-side
    return res.status(502).json({ error: "upstream_unavailable" });
  }
});

// ─── x402 wiring fragments (match index.ts shapes) ──────────────────────────

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;

/**
 * Paywall routes fragment — same shape as `accept()` in index.ts, and it resolves
 * its own payTo via getReceiveAddress() so it is correct when merged raw:
 *     app.use(paymentMiddleware({ ...routes, ...premiumRoutes }, resourceServer));
 */
export const premiumRoutes = {
  "GET /signal": {
    accepts: [{ scheme: "exact", price: PREMIUM_PRICE, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Composite market signal (spot + 24h change + momentum verdict)",
    mimeType: "application/json",
  },
};

/** Catalog entry — matches CATALOG's shape in index.ts. */
export const premiumCatalog = [
  {
    route: "GET /signal",
    price: PREMIUM_PRICE,
    params: "?symbol=BTC",
    desc: "Composite market signal: spot + 24h change + momentum → bullish/bearish/neutral",
  },
];
