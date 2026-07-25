/**
 * /etf/flows — ported from crew build S-021 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./etf-flows.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_ETF_FLOWS = process.env.PRICE_ETF_FLOWS || "$0.01";

export const etfFlowsRouter: Router = Router();
etfFlowsRouter.get("/etf/flows", (req: Request, res: Response) => {
  const symbols = String(req.query.symbols ?? "");
  const days = String(req.query.days ?? "5");
  return serve(res, "GET /etf/flows", priceToUsd(PRICE_ETF_FLOWS), `${symbols},${days}`, async () =>
    handler({ symbols, days }),
  );
});

export const etfFlowsRoutes = {
  "GET /etf/flows": {
    accepts: [{ scheme: "exact", price: PRICE_ETF_FLOWS, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Daily net flow estimates for US spot BTC/ETH ETFs -- aggregates 10+ Yahoo Finance OHLCV feeds and computes volume-weighted flow so a bot avoids 10+ calls and manual flow math.",
    mimeType: "application/json",
  },
};

export const etfFlowsCatalog = [
  {
    route: "GET /etf/flows",
    price: PRICE_ETF_FLOWS,
    params: "?symbols=IBIT,FBTC,ARKB&days=5",
    desc: "Daily net flow estimates for US spot BTC/ETH ETFs -- aggregates 10+ Yahoo Finance OHLCV feeds and computes volume-weighted flow so a bot avoids 10+ calls and manual flow math.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateEtfFlows(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  if (!q.symbols) return "usage: /etf/flows?symbols=IBIT,FBTC,ARKB&days=5";
  return null;
}
