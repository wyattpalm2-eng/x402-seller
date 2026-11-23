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
import { signalHistory } from "./truth-signal.js";
import { marketBrief } from "./composites.js";
import { topMarkets, fearGreed, cached, getJson } from "./data.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SIGNALS = process.env.PRICE_SIGNALS || "$0.03";
export const PRICE_BRIEFS = process.env.PRICE_BRIEFS || "$0.03";
export const PRICE_PULSE = process.env.PRICE_PULSE || "$0.02";
export const PRICE_MOVERS = process.env.PRICE_MOVERS || "$0.01";
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
    // What followed past calls of each verdict (graded ledger, /truth/signal).
    track_record: { bullish: signalHistory("bullish"), bearish: signalHistory("bearish"), neutral: signalHistory("neutral") },
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

/**
 * The liquid USD market from ONE Coinbase Exchange call (/products/stats: 24h open/high/low/last
 * and volume for every pair). It replaces CoinGecko for breadth and movers, which rate-limits
 * Render's shared IP. "Liquid" = at least MIN_DOLLAR_VOL of 24h volume, so a thin pair that moved
 * 40% on three trades never shows up as a "top gainer".
 */
const MIN_DOLLAR_VOL = Number(process.env.MOVERS_MIN_VOL_USD || 2_000_000);
const STABLE_RE = /^(USDT|USDC|DAI|PYUSD|EURC|USDS|GUSD|PAX|TUSD|FDUSD|USDE|RLUSD|USD1)$/;
type Mover = { symbol: string; change_24h_pct: number; price_usd: number; volume_24h_usd: number; range_position: number | null };
export async function liquidUniverse(): Promise<Mover[]> {
  const all: any = await cached("cb:allstats", () => getJson("https://api.exchange.coinbase.com/products/stats"));
  const out: Mover[] = [];
  for (const [pair, v] of Object.entries<any>(all ?? {})) {
    if (!pair.endsWith("-USD")) continue;
    const sym = pair.slice(0, -4);
    if (STABLE_RE.test(sym)) continue;
    const st = v?.stats_24hour ?? {};
    const open = Number(st.open), last = Number(st.last), hi = Number(st.high), lo = Number(st.low), vol = Number(st.volume);
    if (!(open > 0) || !(last > 0) || !Number.isFinite(vol)) continue;
    const dollarVol = vol * last;
    if (dollarVol < MIN_DOLLAR_VOL) continue;
    out.push({
      symbol: sym,
      change_24h_pct: Number((((last - open) / open) * 100).toFixed(2)),
      price_usd: last,
      volume_24h_usd: Math.round(dollarVol),
      range_position: hi > lo ? Number(((last - lo) / (hi - lo)).toFixed(2)) : null, // 0 = at the day's low, 1 = at its high
    });
  }
  return out;
}

/**
 * /markets fallback. CoinGecko ranks by market cap and is the primary source, but it rate-limits
 * Render's IP and a restart wipes the last-good cache, so right after a restart /markets could
 * answer nothing. This answers from Coinbase instead, ranked by 24h DOLLAR VOLUME, and says so in
 * `ranked_by` and `source`, because volume rank is not market-cap rank.
 */
export async function coinbaseMarkets(limit = 10) {
  const n = Math.min(Math.max(limit, 1), 50);
  const u = await liquidUniverse();
  if (u.length === 0) return null;
  const top = [...u].sort((a, b) => b.volume_24h_usd - a.volume_24h_usd).slice(0, n);
  return {
    count: top.length,
    coins: top.map((m, i) => ({
      id: m.symbol.toLowerCase(),
      symbol: m.symbol.toLowerCase(),
      name: m.symbol,
      price_usd: m.price_usd,
      market_cap: null,
      volume_24h_usd: m.volume_24h_usd,
      rank: i + 1,
      change_24h_pct: m.change_24h_pct,
    })),
    ranked_by: "24h dollar volume on Coinbase (market-cap source unavailable right now)",
    source: "coinbase",
    as_of: new Date().toISOString(),
  };
}

export async function marketMovers(limit = 5) {
  const u = await liquidUniverse();
  if (u.length < 10) return null;
  const n = Math.min(Math.max(limit, 1), 10);
  const sorted = [...u].sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const up = u.filter((m) => m.change_24h_pct > 0).length;
  const byVol = [...u].sort((a, b) => b.volume_24h_usd - a.volume_24h_usd);
  return {
    breadth_pct_up: Math.round((100 * up) / u.length),
    universe: `${u.length} Coinbase USD pairs with at least $${(MIN_DOLLAR_VOL / 1e6).toFixed(0)}M 24h volume`,
    top_gainers: sorted.slice(0, n),
    top_losers: sorted.slice(-n).reverse(),
    most_traded: byVol.slice(0, n).map((m) => ({ symbol: m.symbol, volume_24h_usd: m.volume_24h_usd, change_24h_pct: m.change_24h_pct })),
    note: "range_position: where price sits in its 24h high/low (0 = at the low, 1 = at the high). A top gainer already back near its low has given the move back.",
    as_of: new Date().toISOString(),
  };
}

export async function marketPulse() {
  const [briefs, movers, fng] = await Promise.all([
    each(PULSE_ASSETS, marketBrief),
    marketMovers(3).catch(() => null),
    fearGreed().catch(() => null),
  ]);
  // CoinGecko only if Coinbase's stats call failed.
  const markets = movers ? null : await topMarkets(50).catch(() => null);
  if (briefs.ok.length === 0 && !movers && !markets) return null;

  const coins: any[] = (markets?.coins ?? []).filter((c: any) => typeof c.change_24h_pct === "number");
  // Stablecoins sit at ~0% and would crowd the "calmest" end; they are not movers.
  const isStable = (c: any) =>
    /usd|eur|gbp|dai$/i.test(String(c.symbol)) || /stable|dollar|euro|tether/i.test(String(c.name)) ||
    (Math.abs(Number(c.price_usd) - 1) < 0.03 && Math.abs(c.change_24h_pct) < 1);
  const moving = coins.filter((c) => !isStable(c));
  const sorted = [...moving].sort((a, b) => b.change_24h_pct - a.change_24h_pct);
  const pick = (c: any) => ({ symbol: String(c.symbol).toUpperCase(), name: c.name, change_24h_pct: Number(c.change_24h_pct.toFixed(2)), price_usd: c.price_usd });
  const up = moving.filter((c) => c.change_24h_pct > 0).length;
  const breadth = movers ? movers.breadth_pct_up : moving.length ? Math.round((100 * up) / moving.length) : null;
  const universe = movers ? movers.universe : `top ${moving.length} coins by market cap`;

  const regime = overall(briefs.ok.map((b: any) => b.regime));
  const why: string[] = [];
  for (const b of briefs.ok as any[]) why.push(`${b.symbol}: ${b.regime.replace("_", " ")}${b.change_24h_pct != null ? ` (${b.change_24h_pct > 0 ? "+" : ""}${b.change_24h_pct}% 24h)` : ""}`);
  if (breadth != null) why.push(`breadth: ${breadth}% of ${universe} are up on the day`);
  if (fng?.value != null) why.push(`sentiment ${fng.value}/100 (${fng.label})`);

  return {
    regime, // risk_on | risk_off | neutral, read this first
    why,
    majors: briefs.ok,
    breadth_pct_up: breadth,
    top_gainers: movers ? movers.top_gainers : sorted.slice(0, 3).map(pick),
    top_losers: movers ? movers.top_losers : sorted.slice(-3).reverse().map(pick),
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
batchRouter.get("/movers", (req: Request, res: Response) => {
  const n = Number(req.query.limit ?? 5);
  return serve(res, "GET /movers", priceToUsd(PRICE_MOVERS), `top${n}`, () => marketMovers(Number.isFinite(n) ? n : 5));
});
batchRouter.get("/pulse", (_req: Request, res: Response) => serve(res, "GET /pulse", priceToUsd(PRICE_PULSE), "market", () => marketPulse()));

const D = {
  signals: "Up to 20 momentum verdicts (bullish / bearish / neutral) in ONE paid call, with a tally. Same compute as /signal, graded in public at /truth/signal. A whole watchlist for the price of three single calls.",
  briefs: "Up to 10 market-regime reads (risk_on / risk_off / neutral from price move, perp funding and sentiment) in ONE paid call, plus an overall verdict for the basket. Same compute as /brief.",
  movers: "Biggest 24h gainers and losers among actively traded coins (Coinbase USD pairs with at least $2M of 24h volume, so no three-trade 'pumps'), plus market breadth and the most-traded coins. Each mover says where price sits in its day range, so a gainer already back near its low is visible as one.",
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
  "GET /movers": accept(PRICE_MOVERS, D.movers),
};
export const batchCatalog = [
  { route: "GET /pulse", price: PRICE_PULSE, params: "", desc: D.pulse },
  { route: "GET /movers", price: PRICE_MOVERS, params: "?limit=5", desc: D.movers },
  { route: "GET /watchlist", price: PRICE_SIGNALS, params: "?symbols=BTC,ETH,SOL", desc: D.signals },
  { route: "GET /briefs", price: PRICE_BRIEFS, params: "?symbols=BTC,ETH,SOL", desc: D.briefs },
];

export function validateBatch(q: Record<string, any>, reqPath: string): string | null {
  if (reqPath === "/pulse") return null;
  if (reqPath === "/movers") {
    if (q.limit === undefined) return null;
    const n = Number(q.limit);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? null : "limit must be an integer from 1 to 10";
  }
  const max = reqPath === "/watchlist" ? MAX_SIGNALS : MAX_BRIEFS;
  const n = symbols(q.symbols).length;
  if (n === 0) return `symbols is required, comma-separated, e.g. ${reqPath}?symbols=BTC,ETH,SOL`;
  if (n > max) return `at most ${max} symbols per call`;
  return null;
}

export const batchDiscovery = [
  {
    method: "GET" as const,
    path: "/movers",
    price: PRICE_MOVERS,
    description: D.movers,
    input: { limit: { type: "integer", required: false, default: "5", example: "5" } } as Record<string, { type: string; required: boolean; default?: string; example?: string }>,
    output_example: {
      breadth_pct_up: 64,
      universe: "93 Coinbase USD pairs with at least $2M 24h volume",
      top_gainers: [{ symbol: "SOL", change_24h_pct: 3.6, price_usd: 72.56, volume_24h_usd: 126900000, range_position: 0.32 }],
      top_losers: [{ symbol: "ETH", change_24h_pct: -1.2, price_usd: 1719.14, volume_24h_usd: 418400000, range_position: 0.17 }],
    },
  },
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
