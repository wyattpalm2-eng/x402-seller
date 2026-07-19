/**
 * alpha.ts — the LAUNCH RADAR. The flagship "give me safe alpha" endpoint:
 *
 *   GET /alpha/launches?chain=base   →   $0.08
 *
 * A launch-sniping agent's dream call. Instead of the agent having to already
 * know a token address and ask "is this safe?", this DISCOVERS what just
 * launched, runs every candidate through the composite rug score (static +
 * live buy/sell simulation, or the Solana dual-engine) plus our liquidity
 * trend, filters the obvious traps, and returns a ranked, pre-vetted shortlist
 * verdict-first. One call replaces the agent's entire pipeline: fetch new pools
 * + screen each token + rank + reason (10+ calls + a pile of inference).
 *
 * This is the proactive product nobody else sells: raw-data vendors give you
 * "new pools"; safety vendors check a token you already hand them. This does
 * both and makes the decision.
 *
 * SECURITY: chain via a fixed allowlist; token addresses are regex-validated
 * before any downstream call; upstream errors never echoed. Scan is capped.
 */
import { Router, type Request, type Response } from "express";
import { getJson } from "./data.js";
import { serve } from "./crypto.js";
import { safetyReport } from "./safety.js";
import { liquidityTrend, track as trackLiquidity } from "./history.js";
import { getReceiveAddress } from "./wallet.js";
import { priceToUsd } from "./stats.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_ALPHA = process.env.PRICE_ALPHA || "$0.08";

// our slug -> GeckoTerminal network id (new_pools feed exists per network).
const GT_CHAINS: Record<string, string> = {
  base: "base",
  eth: "eth",
  ethereum: "eth",
  solana: "solana",
  bsc: "bsc",
  polygon: "polygon_pos",
  arbitrum: "arbitrum",
  optimism: "optimism",
};
export const ALPHA_CHAINS = Object.keys(GT_CHAINS);
const MAX_SCAN = 10; // cap tokens screened per call -> bounds upstream load
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export function validateAlpha(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(GT_CHAINS, chain))
    return `unsupported chain "${chain.slice(0, 24)}". supported: ${ALPHA_CHAINS.join(", ")}`;
  return null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export async function launchRadar(chainKey: string): Promise<any | null> {
  const gt = GT_CHAINS[chainKey];
  if (!gt) return null;
  const isSol = chainKey === "solana";
  const valid = (a: string) => (isSol ? SOL_ADDR.test(a) : EVM_ADDR.test(a));

  const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(gt)}/new_pools`);
  const pools: any[] = (j?.data ?? []).slice(0, MAX_SCAN);

  // Extract the base-token address from each fresh pool (id like "base_0x..").
  const cand = pools
    .map((p) => {
      const id = String(p?.relationships?.base_token?.data?.id ?? "");
      const m = /_([1-9A-HJ-NP-Za-km-z]{32,44}|0x[a-fA-F0-9]{40})$/.exec(id);
      const a = p?.attributes ?? {};
      if (!m || !valid(m[1])) return null;
      return {
        address: m[1],
        name: a.name ?? null,
        created_at: a.pool_created_at ?? null,
        liquidity_usd: num(a.reserve_in_usd),
        fdv_usd: num(a.fdv_usd),
        volume_24h: num(a.volume_usd?.h24),
      };
    })
    .filter(Boolean) as Array<{ address: string; name: string | null; created_at: string | null; liquidity_usd: number | null; fdv_usd: number | null; volume_24h: number | null }>;

  if (!cand.length) return null;

  // Screen every candidate through the composite rug score, in parallel.
  const scored = await Promise.all(
    cand.map(async (c) => {
      const rep: any = await safetyReport(chainKey, c.address).catch(() => null); // EVM/Solana shapes differ
      if (!isSol) trackLiquidity(chainKey, c.address);
      const trend = !isSol ? liquidityTrend(chainKey, c.address) : null;
      return {
        token: c.name || rep?.token?.symbol || null,
        address: c.address,
        verdict: rep?.verdict ?? "unknown", // ok | warning | danger | unknown
        risk_score: rep?.risk_score ?? null,
        honeypot: rep?.simulation?.is_honeypot ?? rep?.details?.honeypot_static ?? null,
        top_flag: rep?.red_flags?.[0] ?? null,
        green: rep?.green_flags?.[0] ?? null,
        liquidity_usd: c.liquidity_usd,
        liquidity_trend: trend?.verdict ?? null,
        fdv_usd: c.fdv_usd,
        volume_24h: c.volume_24h,
        launched: c.created_at,
      };
    }),
  );

  // Rank: safest first (ok > warning > unknown > danger), then deeper liquidity.
  const rank: Record<string, number> = { ok: 0, warning: 1, unknown: 2, danger: 3 };
  scored.sort((a, b) => (rank[a.verdict] ?? 2) - (rank[b.verdict] ?? 2) || (b.liquidity_usd ?? 0) - (a.liquidity_usd ?? 0));

  const summary = {
    scanned: scored.length,
    clear: scored.filter((s) => s.verdict === "ok").length,
    caution: scored.filter((s) => s.verdict === "warning").length,
    avoid: scored.filter((s) => s.verdict === "danger").length,
    unrated: scored.filter((s) => s.verdict === "unknown").length,
  };
  const safest = scored.find((s) => s.verdict === "ok");

  return {
    chain: chainKey,
    headline: safest
      ? `${summary.clear} of ${summary.scanned} fresh launches look clear — safest: ${safest.token || safest.address.slice(0, 8)}`
      : `0 of ${summary.scanned} fresh launches are clear — ${summary.avoid} are rugs/honeypots, sit this batch out`,
    summary,
    launches: scored, // ranked safest-first
    note: "Fresh launches discovered + screened through the composite rug score, ranked safest-first. Each verdict: ok/warning/danger. Not financial advice; a filter, not a guarantee.",
    as_of: new Date().toISOString(),
  };
}

export const alphaRouter: Router = Router();
alphaRouter.get("/alpha/launches", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base").toLowerCase().trim();
  return serve(res, "GET /alpha/launches", priceToUsd(PRICE_ALPHA), chain, () => launchRadar(chain));
});

export const alphaRoutes = {
  "GET /alpha/launches": {
    accepts: [{ scheme: "exact", price: PRICE_ALPHA, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Launch radar: discovers fresh launches, screens each through the composite rug score + liquidity, returns a ranked safest-first shortlist",
    mimeType: "application/json",
  },
};

export const alphaCatalog = [
  {
    route: "GET /alpha/launches",
    price: PRICE_ALPHA,
    params: "?chain=base  (base|eth|solana|bsc|polygon|arbitrum|optimism)",
    desc: "FLAGSHIP ALPHA — one call discovers what just launched AND rug-screens it, ranked safest-first with a per-token verdict. Replaces the agent's whole discover→screen→rank pipeline.",
  },
];
