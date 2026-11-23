/**
 * Stablecoin answers, computed from DefiLlama's open stablecoin data (stablecoins.llama.fi).
 *
 *   /depeg              is any major USD stablecoin off its peg right now?        $0.01
 *   /stablecoins/flows  is stablecoin money moving onto or off each chain?       $0.02
 *
 * DefiLlama publishes this data openly for reuse; what we sell is the judgment on top (peg status
 * with thresholds and redemption pressure; per-chain net flow with a verdict), not the raw feed.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { getReceiveAddress } from "./wallet.js";
import { cached, getJson } from "./data.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_DEPEG = process.env.PRICE_DEPEG || "$0.01";
export const PRICE_STABLE_FLOWS = process.env.PRICE_STABLE_FLOWS || "$0.02";

const MIN_SUPPLY_USD = 500_000_000; // ignore tiny stablecoins: their "price" is often a stale quote
const WATCH_PCT = 0.2;
const DEPEG_PCT = 0.5;

const usd = (o: any) => Number(o?.peggedUSD);
const pct = (now: number, prev: number) => (prev > 0 && Number.isFinite(now) ? Number((((now - prev) / prev) * 100).toFixed(2)) : null);

async function assets(): Promise<any[]> {
  const j: any = await cached("llama:stablecoins", () => getJson("https://stablecoins.llama.fi/stablecoins?includePrices=true"));
  return (j?.peggedAssets ?? []).filter((a: any) => a.pegType === "peggedUSD");
}

export async function depegReport() {
  const list = (await assets())
    .map((a) => ({ a, supply: usd(a.circulating) }))
    .filter(({ a, supply }) => supply >= MIN_SUPPLY_USD && Number.isFinite(Number(a.price)))
    .sort((x, y) => y.supply - x.supply);
  if (list.length === 0) return null;

  const coins = list.map(({ a, supply }) => {
    const price = Number(a.price);
    const dev = Number(((price - 1) * 100).toFixed(3));
    const status = Math.abs(dev) >= DEPEG_PCT ? "depegged" : Math.abs(dev) >= WATCH_PCT ? "watch" : "on_peg";
    return {
      symbol: a.symbol,
      name: a.name,
      price_usd: Number(price.toFixed(5)),
      deviation_pct: dev,
      status,
      mechanism: a.pegMechanism ?? null,
      supply_usd: Math.round(supply),
      // A run shows up as supply leaving before (or while) the price slips.
      supply_change_1d_pct: pct(supply, usd(a.circulatingPrevDay)),
      supply_change_7d_pct: pct(supply, usd(a.circulatingPrevWeek)),
    };
  });

  const off = coins.filter((c) => c.status !== "on_peg");
  const runs = coins.filter((c) => (c.supply_change_7d_pct ?? 0) <= -10);
  const verdict = coins.some((c) => c.status === "depegged") ? "alert" : off.length || runs.length ? "watch" : "all_clear";
  const why: string[] = [];
  for (const c of off) why.push(`${c.symbol} at $${c.price_usd} (${c.deviation_pct > 0 ? "+" : ""}${c.deviation_pct}% from peg)`);
  // Say what the data shows, not why: a big drop can be redemptions or a supply migration.
  for (const c of runs) why.push(`${c.symbol} supply fell ${Math.abs(c.supply_change_7d_pct as number)}% in 7 days`);
  if (!why.length) why.push(`all ${coins.length} USD stablecoins over $${MIN_SUPPLY_USD / 1e6}M supply are within ${WATCH_PCT}% of $1`);

  return {
    verdict, // all_clear | watch | alert, read this first
    why,
    thresholds: { watch_pct: WATCH_PCT, depeg_pct: DEPEG_PCT, min_supply_usd: MIN_SUPPLY_USD },
    coins,
    source: "DefiLlama stablecoins (open data), judgment by x402-seller",
    as_of: new Date().toISOString(),
  };
}

export async function stableFlows(limit = 15) {
  const all = await assets();
  if (all.length === 0) return null;
  const by = new Map<string, { now: number; d1: number; d7: number; d7n: number }>();
  for (const a of all) {
    for (const [chain, v] of Object.entries<any>(a.chainCirculating ?? {})) {
      const now = usd(v?.current);
      if (!Number.isFinite(now)) continue;
      const b = by.get(chain) ?? { now: 0, d1: 0, d7: 0, d7n: 0 };
      b.now += now;
      const p1 = usd(v?.circulatingPrevDay);
      b.d1 += Number.isFinite(p1) ? p1 : now; // missing history counts as no change, never as a flow
      const p7 = usd(v?.circulatingPrevWeek);
      if (Number.isFinite(p7)) { b.d7 += p7; b.d7n += now; }
      by.set(chain, b);
    }
  }
  const n = Math.min(Math.max(limit, 1), 30);
  const chains = [...by.entries()]
    .filter(([, b]) => b.now >= 50_000_000)
    .sort((x, y) => y[1].now - x[1].now)
    .slice(0, n)
    .map(([chain, b]) => {
      const net1 = b.now - b.d1;
      const c1 = pct(b.now, b.d1);
      const c7 = b.d7 > 0 ? pct(b.d7n, b.d7) : null;
      // The verdict is the 7-day trend; one day is noise (and can point the other way). Only a chain
      // with no week-ago history falls back to the 1-day move.
      const basis = c7 ?? c1 ?? 0;
      const cut = c7 != null ? 2 : 0.75;
      const verdict = basis >= cut ? "inflow" : basis <= -cut ? "outflow" : "flat";
      return { chain, stablecoin_supply_usd: Math.round(b.now), net_flow_1d_usd: Math.round(net1), change_1d_pct: c1, change_7d_pct: c7, verdict };
    });

  const inflow = chains.filter((c) => c.verdict === "inflow").map((c) => c.chain);
  const outflow = chains.filter((c) => c.verdict === "outflow").map((c) => c.chain);
  const total = chains.reduce((s, c) => s + c.stablecoin_supply_usd, 0);
  const totalNet = chains.reduce((s, c) => s + c.net_flow_1d_usd, 0);
  return {
    summary: {
      inflow_chains: inflow,
      outflow_chains: outflow,
      net_flow_1d_usd: Math.round(totalNet),
      read: totalNet > 0 ? "stablecoin supply grew in the last day: dry powder entering on-chain" : totalNet < 0 ? "stablecoin supply shrank in the last day: money leaving on-chain markets" : "flat",
    },
    chains,
    method: "Sum of every USD stablecoin's supply per chain now vs a day and a week ago. Verdict follows the 7-day change: inflow at +2% or more, outflow at -2% or less (1-day at ±0.75% only when no week-ago data). Stablecoin growth on a chain is money arriving ready to trade.",
    total_supply_usd: Math.round(total),
    source: "DefiLlama stablecoins (open data), judgment by x402-seller",
    as_of: new Date().toISOString(),
  };
}

export const stableRouter: Router = Router();
stableRouter.get("/depeg", (_req: Request, res: Response) => serve(res, "GET /depeg", priceToUsd(PRICE_DEPEG), "usd", () => depegReport()));
stableRouter.get("/stablecoins/flows", (req: Request, res: Response) => {
  const n = Number(req.query.limit ?? 15);
  return serve(res, "GET /stablecoins/flows", priceToUsd(PRICE_STABLE_FLOWS), `top${n}`, () => stableFlows(Number.isFinite(n) ? n : 15));
});

const D = {
  depeg: "Is any major USD stablecoin off its $1 peg right now? Every USD stablecoin over $500M supply with price, deviation, status (on_peg / watch / depegged) and 1d/7d supply change, so a redemption run shows before the price breaks. Verdict all_clear / watch / alert with reasons.",
  flows: "Is stablecoin money moving onto or off each chain? Stablecoin supply per chain now vs 1 day and 7 days ago, net dollar flow, and an inflow / outflow / flat verdict per chain. Stablecoin growth on a chain is money arriving ready to trade.",
};
const accept = (price: string, description: string) => ({
  accepts: [{ scheme: "exact", price, network: NETWORK, payTo: getReceiveAddress() }],
  description,
  mimeType: "application/json",
});
export const stableRoutes = {
  "GET /depeg": accept(PRICE_DEPEG, D.depeg),
  "GET /stablecoins/flows": accept(PRICE_STABLE_FLOWS, D.flows),
};
export const stableCatalog = [
  { route: "GET /depeg", price: PRICE_DEPEG, params: "", desc: D.depeg },
  { route: "GET /stablecoins/flows", price: PRICE_STABLE_FLOWS, params: "?limit=15", desc: D.flows },
];
export function validateStable(q: Record<string, any>, reqPath: string): string | null {
  if (reqPath !== "/stablecoins/flows" || q.limit === undefined) return null;
  const n = Number(q.limit);
  return Number.isInteger(n) && n >= 1 && n <= 30 ? null : "limit must be an integer from 1 to 30";
}
type In = Record<string, { type: string; required: boolean; default?: string; example?: string }>;
export const stableDiscovery = [
  {
    method: "GET" as const,
    path: "/depeg",
    price: PRICE_DEPEG,
    description: D.depeg,
    input: {} as In,
    output_example: { verdict: "all_clear", why: ["all 14 USD stablecoins over $500M supply are within 0.2% of $1"], coins: [{ symbol: "USDT", price_usd: 0.9989, deviation_pct: -0.11, status: "on_peg", supply_change_7d_pct: 0.4 }] },
  },
  {
    method: "GET" as const,
    path: "/stablecoins/flows",
    price: PRICE_STABLE_FLOWS,
    description: D.flows,
    input: { limit: { type: "integer", required: false, default: "15", example: "15" } } as In,
    output_example: { summary: { inflow_chains: ["Base"], outflow_chains: ["Tron"], net_flow_1d_usd: 412000000 }, chains: [{ chain: "Base", stablecoin_supply_usd: 4810000000, change_1d_pct: 0.9, change_7d_pct: 3.1, verdict: "inflow" }] },
  },
];
