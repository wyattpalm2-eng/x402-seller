/**
 * /token/risk/:address — ported from crew build S-011 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./token-risk.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_TOKEN_RISK = process.env.PRICE_TOKEN_RISK || "$0.05";

export const tokenRiskRouter: Router = Router();
tokenRiskRouter.get("/token/risk/:address", (req: Request, res: Response) => {
  const address = String(req.params.address ?? "");
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /token/risk/:address", priceToUsd(PRICE_TOKEN_RISK), `${address},${chain}`, async () =>
    handler({ chain, address }),
  );
});

export const tokenRiskRoutes = {
  "GET /token/risk/:address": {
    accepts: [{ scheme: "exact", price: PRICE_TOKEN_RISK, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Composite on-chain token risk score for any Base or Ethereum token: fuses holder concentration from Transfer-log sampling, Sourcify verification status, contract bytecode analysis, and DexScreener liquidity/volume into one 0-100 score. Five separate API calls and the scoring logic, collapsed into one.",
    mimeType: "application/json",
  },
};

export const tokenRiskCatalog = [
  {
    route: "GET /token/risk/:address",
    price: PRICE_TOKEN_RISK,
    params: "?chain=base",
    desc: "Composite on-chain token risk score for any Base or Ethereum token: fuses holder concentration from Transfer-log sampling, Sourcify verification status, contract bytecode analysis, and DexScreener liquidity/volume into one 0-100 score. Five separate API calls and the scoring logic, collapsed into one.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateTokenRisk(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  const seg0 = String(reqPath || "").slice("/token/risk/".length).split("/")[0];
  if (!seg0) return "usage: /token/risk/:address?chain=base";
  if (!/^0x[a-fA-F0-9]{40}$/.test(seg0)) return "address is malformed. usage: /token/risk/:address?chain=base";
  if (q.chain !== undefined && !["base","eth"].includes(String(q.chain))) return "chain must be one of: base, eth";
  return null;
}
