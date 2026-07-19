/**
 * composites.ts — decision-ready ANSWER endpoints. The reason an agent pays us
 * instead of stitching free APIs itself:
 *
 *   GET /vet?chain=base&address=0x…   →  $0.02
 *     "Should my agent touch this token?" Market data + contract security in ONE
 *     call, verdict-first: clear / caution / avoid, with reasons.
 *
 *   GET /brief?symbol=BTC             →  $0.02
 *     "What's the market regime right now?" Spot + 24h move + perp funding/OI +
 *     fear&greed in ONE call, verdict-first: risk_on / risk_off / neutral.
 *
 * Design rule: VERDICT FIRST, small flat JSON. The buyer is an LLM agent that
 * pays for its own inference — every token it spends parsing us is its money.
 * One $0.02 answer beats three free calls + signup walls + rate limits + the
 * reasoning tokens to merge them.
 *
 * SECURITY: same allowlist/regex validation as the underlying modules; both
 * sub-fetches run in parallel; no user input reaches any URL unvalidated.
 */
import { Router, type Request, type Response } from "express";
import { cryptoPrice, fearGreed } from "./data.js";
import { tokenSnapshot, serve } from "./crypto.js";
import { safetyReport, validateSafety, SAFETY_CHAINS } from "./safety.js";
import { derivsSnapshot } from "./derivs.js";
import { liquidityTrend, track as trackLiquidity } from "./history.js";
import { getReceiveAddress } from "./wallet.js";
import { priceToUsd } from "./stats.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_VET = process.env.PRICE_VET || "$0.05";
export const PRICE_BRIEF = process.env.PRICE_BRIEF || "$0.03";

const SYMBOL_RE = /^[A-Z0-9-]{1,12}$/;

// ─── Pre-paywall validators (400 before charge) ─────────────────────────────
export function validateVet(q: Record<string, any>): string | null {
  return validateSafety(q); // same contract: EVM chain allowlist + address required
}
export function validateBrief(q: Record<string, any>): string | null {
  const s = String(q.symbol ?? "BTC").toUpperCase().trim();
  if (!SYMBOL_RE.test(s)) return "invalid symbol (1-12 chars A-Z 0-9 -)";
  return null;
}

// ─── /vet — one-call token due diligence ────────────────────────────────────
export async function vetToken(chainKey: string, address: string) {
  const [market, security] = await Promise.all([
    tokenSnapshot(address, undefined, chainKey).catch(() => null),
    safetyReport(chainKey, address).catch(() => null),
  ]);
  if (!market && !security) return null;

  const why: string[] = [];
  let verdict: "clear" | "caution" | "avoid" = "clear";

  // Security dominates: a honeypot with great liquidity is still a honeypot.
  if (security) {
    if (security.verdict === "danger") verdict = "avoid";
    else if (security.verdict === "warning") verdict = "caution";
    why.push(...security.red_flags.map((f: string) => `security: ${f}`));
    // Static vs live-simulation disagreement must never read as "clear".
    if (security.needs_review) {
      if (verdict === "clear") verdict = "caution";
      why.push("security: static and live-sim checks disagree — treat as unverified");
    }
  } else {
    verdict = "caution";
    why.push("security: no contract report available — treat as unverified");
  }

  // Market sanity on top.
  const liq = market?.liquidity_usd ?? null;
  if (liq !== null && liq < 10_000) {
    if (verdict === "clear") verdict = "caution";
    why.push(`market: thin liquidity ($${Math.round(liq).toLocaleString()})`);
  }
  const vol = market?.volume_24h ?? null;
  if (vol !== null && liq !== null && liq > 0 && vol / liq > 20) {
    if (verdict === "clear") verdict = "caution";
    why.push("market: 24h volume >20x liquidity — churn/wash pattern");
  }
  if (!market) why.push("market: no DEX pair found");

  // Live liquidity trend (our self-collected series). A pool whose liquidity is
  // draining is a rug/exit in progress even when the contract looks clean —
  // this is the signal no static check and no free API can give.
  trackLiquidity(chainKey, address); // ensure we keep collecting for next time
  const liqTrend = liquidityTrend(chainKey, address);
  if (liqTrend) {
    const chg = liqTrend.change_pct_1h ?? liqTrend.change_pct_window;
    if (liqTrend.verdict === "draining_fast") {
      verdict = "avoid";
      why.push(`liquidity: draining fast (${chg}% over ${liqTrend.window_minutes}m) — possible rug in progress`);
    } else if (liqTrend.verdict === "draining") {
      if (verdict === "clear") verdict = "caution";
      why.push(`liquidity: trending down (${chg}% over ${liqTrend.window_minutes}m)`);
    }
  }

  // Confidence: how much of the picture we actually had.
  const confidence = market && security ? "high" : "low";
  if (verdict === "clear" && why.length === 0) why.push("no red flags across contract security, live simulation, and liquidity trend");

  return {
    verdict, // clear | caution | avoid — read this first
    confidence,
    why,
    token: security?.token ?? market?.token ?? null,
    chain: chainKey,
    address: address.toLowerCase(),
    market: market
      ? {
          price_usd: market.price_usd,
          liquidity_usd: market.liquidity_usd,
          volume_24h: market.volume_24h,
          change_24h_pct: market.price_change_pct?.h24 ?? null,
          dex: market.dex,
        }
      : null,
    security: security
      ? {
          risk_score: security.risk_score,
          needs_review: security.needs_review,
          confidence: security.confidence,
          red_flags: security.red_flags,
          simulation: security.simulation,
          details: security.details,
        }
      : null,
    liquidity_trend: liqTrend, // null until we've collected enough history
    as_of: new Date().toISOString(),
  };
}

// ─── /brief — one-call market regime read ───────────────────────────────────
export async function marketBrief(symbol: string) {
  const sym = symbol.toUpperCase().trim();
  const [spot, derivs, fng] = await Promise.all([
    cryptoPrice(sym).catch(() => null),
    derivsSnapshot(sym.replace(/-USD$/, "")).catch(() => null),
    fearGreed().catch(() => null),
  ]);
  if (!spot && !derivs) return null;

  const why: string[] = [];
  let score = 0; // >0 risk_on, <0 risk_off

  const chg = derivs?.change_24h_pct ?? null;
  if (chg !== null) {
    score += chg > 2 ? 1 : chg < -2 ? -1 : 0;
    why.push(`24h move ${chg > 0 ? "+" : ""}${chg}%`);
  }
  const fundAnn = derivs?.funding?.annualized_pct ?? null;
  if (fundAnn !== null) {
    if (derivs?.signal === "crowded_long") { score -= 1; why.push(`funding ${fundAnn}% annualized — longs crowded (squeeze risk)`); }
    else if (derivs?.signal === "crowded_short") { score += 1; why.push(`funding ${fundAnn}% annualized — shorts crowded (squeeze fuel up)`); }
    else why.push(`funding ${fundAnn}% annualized — balanced`);
  }
  if (fng?.value != null) {
    score += fng.value >= 70 ? -1 : fng.value <= 30 ? 1 : 0; // contrarian read
    why.push(`sentiment ${fng.value}/100 (${fng.label})`);
  }

  const regime: "risk_on" | "risk_off" | "neutral" = score >= 2 ? "risk_on" : score <= -2 ? "risk_off" : "neutral";

  return {
    regime, // read this first
    symbol: sym.replace(/-USD$/, ""),
    why,
    price_usd: spot?.price_usd ?? derivs?.mark_price ?? null,
    change_24h_pct: chg,
    derivatives: derivs
      ? { funding_annualized_pct: fundAnn, open_interest_usd: derivs.open_interest?.usd ?? null, positioning: derivs.signal }
      : null,
    sentiment: fng ?? null,
    as_of: new Date().toISOString(),
  };
}

// ─── Router ─────────────────────────────────────────────────────────────────
export const compositesRouter: Router = Router();

compositesRouter.get("/vet", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base").toLowerCase().trim();
  const address = String(req.query.address ?? "");
  return serve(res, "GET /vet", priceToUsd(PRICE_VET), address.slice(0, 12), () => vetToken(chain, address));
});

compositesRouter.get("/brief", (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "BTC");
  return serve(res, "GET /brief", priceToUsd(PRICE_BRIEF), symbol.toUpperCase().slice(0, 12), () => marketBrief(symbol));
});

// ─── x402 fragments + catalog (shapes match index.ts) ───────────────────────
function accept(price: string, description: string) {
  return {
    accepts: [{ scheme: "exact", price, network: NETWORK, payTo: getReceiveAddress() }],
    description,
    mimeType: "application/json",
  };
}

export const compositesRoutes = {
  "GET /vet": accept(PRICE_VET, "Flagship one-call token go/no-go: market + composite rug score (static + live sim) + liquidity-drain trend → clear/caution/avoid"),
  "GET /brief": accept(PRICE_BRIEF, "One-call market regime brief: spot + funding/OI + sentiment → risk_on/risk_off verdict"),
};

export const compositesCatalog = [
  {
    route: "GET /vet",
    price: PRICE_VET,
    params: "?chain=base&address=0x…",
    desc: "FLAGSHIP ANSWER — one-call token go/no-go: fuses market + composite rug score (static + live buy/sell simulation + serial-rugger) + our self-collected liquidity-drain trend → clear/caution/avoid with reasons. Replaces 4+ lookups and the reasoning to merge them.",
  },
  {
    route: "GET /brief",
    price: PRICE_BRIEF,
    params: "?symbol=BTC",
    desc: "ANSWER endpoint — market regime in one call: risk_on/risk_off/neutral + reasons (spot, funding, OI, sentiment)",
  },
];

export { SAFETY_CHAINS };
