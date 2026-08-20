/**
 * /liquidation/risk?address=:address&chain=base — ported from crew build S-026 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./liquidation-risk.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_LIQUIDATION_RISK = process.env.PRICE_LIQUIDATION_RISK || "$0.01";

export const liquidationRiskRouter: Router = Router();
liquidationRiskRouter.get("/liquidation/risk?address=:address&chain=base", (req: Request, res: Response) => {
  const address = String(req.query.address ?? "");
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /liquidation/risk?address=:address&chain=base", priceToUsd(PRICE_LIQUIDATION_RISK), `${address},${chain}`, async () =>
    handler({ address, chain }),
  );
});

export const liquidationRiskRoutes = {
  "GET /liquidation/risk?address=:address&chain=base": {
    accepts: [{ scheme: "exact", price: PRICE_LIQUIDATION_RISK, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Multi-protocol liquidation-risk score across Aave V3 + Morpho Blue + Compound V3 on Base/Eth/Arb in a single signed call -- no multi-RPC assembly, no ABI encoding, no manual health-factor math.",
    mimeType: "application/json",
  },
};

export const liquidationRiskCatalog = [
  {
    route: "GET /liquidation/risk?address=:address&chain=base",
    price: PRICE_LIQUIDATION_RISK,
    params: "?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chain=base",
    desc: "Multi-protocol liquidation-risk score across Aave V3 + Morpho Blue + Compound V3 on Base/Eth/Arb in a single signed call -- no multi-RPC assembly, no ABI encoding, no manual health-factor math.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateLiquidationRisk(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  if (!q.address) return "usage: /liquidation/risk?address=:address&chain=base?address=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913&chain=base";
  if (q.chain !== undefined && !["base","eth","arb"].includes(String(q.chain))) return "chain must be one of: base, eth, arb";
  return null;
}
