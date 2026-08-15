/**
 * /yield/surface — ported from crew build S-022 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./yield-surface.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_YIELD_SURFACE = process.env.PRICE_YIELD_SURFACE || "$0.01";

export const yieldSurfaceRouter: Router = Router();
yieldSurfaceRouter.get("/yield/surface", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /yield/surface", priceToUsd(PRICE_YIELD_SURFACE), `${chain}`, async () =>
    handler({ chain }),
  );
});

export const yieldSurfaceRoutes = {
  "GET /yield/surface": {
    accepts: [{ scheme: "exact", price: PRICE_YIELD_SURFACE, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Risk-adjusted yield surface across Base and Ethereum lending, DEX, and restaking pools -- pulls real pool data from yields.llama.fi, computes IL-risk-adjusted APY and cross-protocol TVL context, sorted by adjusted return. One call replaces multiple API fetches plus stateful math.",
    mimeType: "application/json",
  },
};

export const yieldSurfaceCatalog = [
  {
    route: "GET /yield/surface",
    price: PRICE_YIELD_SURFACE,
    params: "?chain=base",
    desc: "Risk-adjusted yield surface across Base and Ethereum lending, DEX, and restaking pools -- pulls real pool data from yields.llama.fi, computes IL-risk-adjusted APY and cross-protocol TVL context, sorted by adjusted return. One call replaces multiple API fetches plus stateful math.",
  },
];

/** Validates query params before the handler runs. Runs after the paywall per @x402/express
 *  cancellation logic: a 400 here cancels settlement so the buyer is never charged.
 *  Per @Ollie's port step: the 6 boot probes hitting this endpoint with invalid
 *  chain values were returning 402 (paywall) instead of 400. Fix: reject unsupported
 *  chain values before the handler runs. */
export function validateYieldSurface(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase();
  const valid = ["base", "eth", "ethereum"];
  if (!valid.includes(chain)) {
    return "unsupported chain '" + String(q.chain) + "'. Use base or eth.";
  }
  return null;
}