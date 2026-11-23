/**
 * Batch and whole-market versions of the routes agents actually buy.
 *
 * The demand ledger and PayAI's settlement-driven listing agree on what sells: the cheap market
 * answers (/brief, /markets, /signal, /price), not the deep token checks. An agent managing a
 * watchlist pays for those one symbol at a time. These routes answer the same question for the
 * whole list, or the whole market, in one payment, using the EXACT functions behind the single
 * routes (signalVerdict, marketBrief), so there is no second implementation to drift.
 *
 *   /watchlist?symbols=BTC,ETH,SOL up to 20 momentum verdicts           $0.03
 *   (not /signals: that path is the free signal-lift report in index.ts)
 *   /briefs?symbols=BTC,ETH,SOL    up to 10 regime reads + an overall   $0.03
 *   /pulse                         the whole market in one answer       $0.02
 */
import { Router, type Request, type Response } from "express";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { getReceiveAddress } from "./wallet.js";
import { signalVerdict } from "./premium.js";
import { marketBrief } from "./composites.js";
import { topMarkets, fearGreed } from "./data.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SIGNALS = process.env.PRICE_SIGNALS || "$0.03";
export const PRICE_BRIEFS = process.env.PRICE_BRIEFS || "$0.03";
export const PRICE_PULSE = process.env.PRICE_PULSE || "$0.02";
const MAX_SIGNALS = 20;
const MAX_BRIEFS = 10;
const PULSE_ASSETS = ["BTC", "ETH", "SOL"];

function symbols(raw: unknown): string[] {
  const list = String(raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase().replace(/[^A-Z0-9-]/g, "").slice(0, 12))
    .filter(Boolean);
  return [...new Set(list)];
}

/** One answer per symbol; a symbol that cannot be read lands in `errors` instead of failing the batch. */
async function each<T>(syms: string[], fn: (s: string) => Promise<T | null>) {
  const settled = await Promise.allSettled(syms.map((s) => fn(s)));
  const ok: T[] = [];
  const errors: { symbol: string; error: string }[] = [];
  settled.forEach((r, i) => {
    if (r.status === "fulfilled" && r.value != null) ok.push(r.value);
    else errors.push({ symbol: syms[i], error: "no reading (unknown symbol or upstream busy)" });
  });
  return { ok, errors };
}

export async function signalsBatch(syms: string[]) {
  const { ok, errors } = await each(syms, signalVerdict);
  if (ok.length === 0) return null; // never bill for an empty batch
  const tally = { bullish: 0, bearish: 0, neutral: 0 };
  for (const s of ok) tally[s.verdict]++;
  return {
    count: ok.length,
    tally,
    signals: ok,
    errors,
    method: "Same compute as /signal: 24h change and intraday range folded into a momentum score in [-1, 1], bucketed bullish / bearish / neutral. Graded in public at /truth/signal.",
    as_of: new Date().toISOString(),
  };
}

function overall(regimes: string[]) {
  const on = regimes.filter((r) => r === "risk_on").length;
  const off = regimes.filter((r) => r === "risk_off").length;
  if (on > off && on >= regimes.length / 2) return "risk_on";
  if (off > on && off >= regimes.length / 2) return "risk_off";
  return "neutral";
}

export async function briefsBatch(syms: string[]) {
  const { ok, errors } = await each(syms, marketBrief);
  if (ok.length === 0) return null;
  return {
    overall: overall(ok.map((b: any) => b.regime)), // read this first
    count: ok.length,
    briefs: ok,
    errors,
    as_of: new Date().toISOString(),
  };
}

export async function marketPulse() {
  const [briefs, markets, fng] = await Promise.all([
    each(PULSE_ASSETS, marketBrief),
    topMarkets(50).catch(() => null),
    fearGreed().catch(() => null),
  ]);
  if (briefs.ok.length === 0 && !markets) return null;

  const coins: any[] = (markets?.coins ?? []).filter((c: any) => typeof c.change_24h_pct === "number");
  // Stablecoins sit at ~0% and would crowd the "calmest" end; they are not movers.
  const isStable = (c: any) =>
    /usd|eur|gbp|dai$/i.test(String(c.symbol)) || /stable|dollar|euro|tether/i.test(String(c.name)) ||
    (Math.abs(Number(c.price_usd) - 1) < 0.03 && Math.abs(c.change_24h_pct) < 1);
  const moving = coins.filter((c) => !isStable(c));
  const sorted = [...moving].sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const pick = (c: any) => ({ symbol: String(c.symbol).toUpperCase(), name: c.name, change_24h_pct: Number(c.change_24h_pct.toFixed(2)), price_usd: c.price_usd });
  const up = moving.filter((c) => c.change_24h_pct > 0).length;
  const breadth = moving.length ? Math.round((100 * up) / moving.length) : null;

  const regime = overall(briefs.ok.map((b: any) => b.regime));
  const why: string[] = [];
  for (const b of briefs.ok as any[]) why.push(`${b.symbol}: ${b.regime.replace("_", " ")}${b.change_24h_pct != null ? ` (${b.change_24h_pct > 0 ? "+" : ""}${b.change_24h_pct}% 24h)` : ""}`);
  if (breadth != null) why.push(`breadth: ${breadth}% of the top ${moving.length} coins are up on the day`);
  if (fng?.value != null) why.push(`sentiment ${fng.value}/100 (${fng.label})`);

  return {
    regime, // risk_on | risk_off | neutral, read this first
    why,
    majors: briefs.ok,
    breadth_pct_up: breadth,
    top_gainers: sorted.slice(0, 3).map(pick),
    top_losers: sorted.slice(-3).reverse().map(pick),
    sentiment: fng ?? null,
    errors: briefs.errors,
    as_of: new Date().toISOString(),
  };
}

export const batchRouter: Router = Router();
batchRouter.get("/watchlist", (req: Request, res: Response) => {
  const s = symbols(req.query.symbols);
  return serve(res, "GET /watchlist", priceToUsd(PRICE_SIGNALS), s.join(",").slice(0, 40), () => signalsBatch(s));
});
batchRouter.get("/briefs", (req: Request, res: Response) => {
  const s = symbols(req.query.symbols);
  return serve(res, "GET /briefs", priceToUsd(PRICE_BRIEFS), s.join(",").slice(0, 40), () => briefsBatch(s));
});
batchRouter.get("/pulse", (_req: Request, res: Response) => serve(res, "GET /pulse", priceToUsd(PRICE_PULSE), "market", () => marketPulse()));

const D = {
  signals: "Up to 20 momentum verdicts (bullish / bearish / neutral) in ONE paid call, with a tally. Same compute as /signal, graded in public at /truth/signal. A whole watchlist for the price of three single calls.",
  briefs: "Up to 10 market-regime reads (risk_on / risk_off / neutral from price move, perp funding and sentiment) in ONE paid call, plus an overall verdict for the basket. Same compute as /brief.",
  pulse: "The whole crypto market in one answer: overall risk_on / risk_off regime from BTC, ETH and SOL briefs, market breadth (% of top coins up), top 3 gainers and losers, and sentiment, each with reasons. The call to make before any trade.",
};
const accept = (price: string, description: string) => ({
  accepts: [{ scheme: "exact", price, network: NETWORK, payTo: getReceiveAddress() }],
  description,
  mimeType: "application/json",
});
export const batchRoutes = {
  "GET /watchlist": accept(PRICE_SIGNALS, D.signals),
  "GET /briefs": accept(PRICE_BRIEFS, D.briefs),
  "GET /pulse": accept(PRICE_PULSE, D.pulse),
};
export const batchCatalog = [
  { route: "GET /pulse", price: PRICE_PULSE, params: "", desc: D.pulse },
  { route: "GET /watchlist", price: PRICE_SIGNALS, params: "?symbols=BTC,ETH,SOL", desc: D.signals },
  { route: "GET /briefs", price: PRICE_BRIEFS, params: "?symbols=BTC,ETH,SOL", desc: D.briefs },
];

export function validateBatch(q: Record<string, any>, reqPath: string): string | null {
  if (reqPath === "/pulse") return null;
  const max = reqPath === "/watchlist" ? MAX_SIGNALS : MAX_BRIEFS;
  const n = symbols(q.symbols).length;
  if (n === 0) return `symbols is required, comma-separated, e.g. ${reqPath}?symbols=BTC,ETH,SOL`;
  if (n > max) return `at most ${max} symbols per call`;
  return null;
}

export const batchDiscovery = [
  {
    method: "GET" as const,
    path: "/pulse",
    price: PRICE_PULSE,
    description: D.pulse,
    input: {} as Record<string, { type: string; required: boolean; example?: string }>,
    output_example: {
      regime: "neutral",
      why: ["BTC: neutral (+0.4% 24h)", "ETH: risk off (-3.1% 24h)", "SOL: neutral (+1.2% 24h)", "breadth: 38% of the top 45 coins are up on the day", "sentiment 41/100 (Fear)"],
      breadth_pct_up: 38,
      top_gainers: [{ symbol: "HYPE", change_24h_pct: 8.41 }],
      top_losers: [{ symbol: "PEPE", change_24h_pct: -9.02 }],
    },
  },
  {
    method: "GET" as const,
    path: "/watchlist",
    price: PRICE_SIGNALS,
    description: D.signals,
    input: { symbols: { type: "string", required: true, example: "BTC,ETH,SOL" } },
    output_example: { count: 3, tally: { bullish: 1, bearish: 1, neutral: 1 }, signals: [{ symbol: "BTC", price_usd: 61205.26, momentum: 0.21, verdict: "neutral" }], errors: [] },
  },
  {
    method: "GET" as const,
    path: "/briefs",
    price: PRICE_BRIEFS,
    description: D.briefs,
    input: { symbols: { type: "string", required: true, example: "BTC,ETH,SOL" } },
    output_example: { overall: "neutral", count: 3, briefs: [{ regime: "neutral", symbol: "BTC", why: ["24h move +0.4%", "funding 9.1% annualized — balanced"] }], errors: [] },
  },
];
