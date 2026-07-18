/**
 * derivs.ts — perp derivatives intelligence. Premium endpoint:
 *
 *   GET /derivs?symbol=BTC   →   $0.01
 *
 * Live funding rate, open interest, and mark/24h move for a perpetual, plus a
 * positioning signal: extreme funding = a crowded trade (squeeze fuel). This is
 * exactly the derivatives-extremes input trading agents buy.
 *
 * Source: Hyperliquid public info API (free, keyless, POST). The whole
 * meta+contexts payload is fetched once and cached (SWR), so every symbol is
 * served from one upstream call.
 *
 * SECURITY: symbol is regex-bound pre-paywall; the upstream URL and body are
 * constants (no user input reaches the request), so no SSRF surface at all.
 */
import { Router, type Request, type Response } from "express";
import { cached } from "./data.js";
import { getReceiveAddress } from "./wallet.js";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_DERIVS = process.env.PRICE_DERIVS || "$0.01";

const SYMBOL_RE = /^[A-Z0-9]{1,12}$/;

/** Pre-paywall validation: 400 before charging for a doomed call. */
export function validateDerivs(q: Record<string, any>): string | null {
  const s = String(q.symbol ?? "BTC").toUpperCase().trim();
  if (!SYMBOL_RE.test(s)) return "invalid symbol (1-12 chars A-Z 0-9)";
  return null;
}

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** One cached fetch of the full perp universe; constant URL + body. */
async function hyperliquidUniverse(): Promise<{ names: string[]; ctxs: any[] }> {
  return cached("hl:metaAndAssetCtxs", async () => {
    const res = await fetch("https://api.hyperliquid.xyz/info", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "metaAndAssetCtxs" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`hyperliquid ${res.status}`);
    const [meta, ctxs] = await res.json();
    return { names: (meta?.universe ?? []).map((u: any) => String(u?.name ?? "")), ctxs: ctxs ?? [] };
  });
}

export async function derivsSnapshot(symbol: string) {
  const sym = symbol.toUpperCase().trim();
  const { names, ctxs } = await hyperliquidUniverse();
  const i = names.indexOf(sym);
  if (i < 0 || !ctxs[i]) return null;
  const c = ctxs[i];

  const mark = num(c.markPx);
  const prevDay = num(c.prevDayPx);
  const change24hPct =
    mark !== null && prevDay !== null && prevDay !== 0 ? Number((((mark - prevDay) / prevDay) * 100).toFixed(3)) : null;

  const fundingHourly = num(c.funding); // hourly rate, e.g. 0.0000125
  const fundingAnnualPct = fundingHourly !== null ? Number((fundingHourly * 24 * 365 * 100).toFixed(2)) : null;
  const oi = num(c.openInterest);
  const oiUsd = oi !== null && mark !== null ? Math.round(oi * mark) : null;

  // Positioning read: sustained |annualized funding| beyond ~30% = a crowded
  // side paying heavily to stay in — classic squeeze fuel.
  let signal: "crowded_long" | "crowded_short" | "neutral" = "neutral";
  if (fundingAnnualPct !== null && fundingAnnualPct > 30) signal = "crowded_long";
  if (fundingAnnualPct !== null && fundingAnnualPct < -30) signal = "crowded_short";

  return {
    symbol: sym,
    mark_price: mark,
    change_24h_pct: change24hPct,
    funding: {
      hourly_rate: fundingHourly,
      annualized_pct: fundingAnnualPct,
      note: "positive = longs pay shorts",
    },
    open_interest: { contracts: oi, usd: oiUsd },
    volume_24h_usd: num(c.dayNtlVlm),
    signal, // crowded_long | crowded_short | neutral
    universe_size: names.length,
    as_of: new Date().toISOString(),
  };
}

export const derivsRouter: Router = Router();

derivsRouter.get("/derivs", (req: Request, res: Response) => {
  const symbol = String(req.query.symbol ?? "BTC");
  return serve(res, "GET /derivs", priceToUsd(PRICE_DERIVS), symbol.toUpperCase().slice(0, 12), () =>
    derivsSnapshot(symbol),
  );
});

// x402 paywall fragment + catalog entry (shapes match index.ts)
export const derivsRoutes = {
  "GET /derivs": {
    accepts: [{ scheme: "exact", price: PRICE_DERIVS, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Perp derivatives intel: funding rate, open interest, crowded-positioning signal",
    mimeType: "application/json",
  },
};

export const derivsCatalog = [
  {
    route: "GET /derivs",
    price: PRICE_DERIVS,
    params: "?symbol=BTC",
    desc: "Perp funding rate + open interest + crowded-long/short squeeze signal",
  },
];
