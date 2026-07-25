/**
 * /token/concentration/:address — ported from crew build S-020 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./token-concentration.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_TOKEN_CONCENTRATION = process.env.PRICE_TOKEN_CONCENTRATION || "$0.01";

export const tokenConcentrationRouter: Router = Router();
tokenConcentrationRouter.get("/token/concentration/:address", (req: Request, res: Response) => {
  const address = String(req.params.address ?? "");
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /token/concentration/:address", priceToUsd(PRICE_TOKEN_CONCENTRATION), `${address},${chain}`, async () =>
    handler({ address, chain }),
  );
});

export const tokenConcentrationRoutes = {
  "GET /token/concentration/:address": {
    accepts: [{ scheme: "exact", price: PRICE_TOKEN_CONCENTRATION, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Returns Gini coefficient, top-10% share, HHI, and Shannon entropy for a token's holder distribution, computed from real on-chain ERC-20 Transfer events fetched from a public Base/Ethereum RPC. A bot that tries this itself must maintain paginated event parsing, address aggregation, and statistical computation across thousands of logs.",
    mimeType: "application/json",
  },
};

export const tokenConcentrationCatalog = [
  {
    route: "GET /token/concentration/:address",
    price: PRICE_TOKEN_CONCENTRATION,
    params: "?chain=base",
    desc: "Returns Gini coefficient, top-10% share, HHI, and Shannon entropy for a token's holder distribution, computed from real on-chain ERC-20 Transfer events fetched from a public Base/Ethereum RPC. A bot that tries this itself must maintain paginated event parsing, address aggregation, and statistical computation across thousands of logs.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateTokenConcentration(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  const seg0 = String(reqPath || "").slice("/token/concentration/".length).split("/")[0];
  if (!seg0) return "usage: /token/concentration/:address?chain=base";
  if (!/^0x[a-fA-F0-9]{40}$/.test(seg0)) return "address is malformed. usage: /token/concentration/:address?chain=base";
  if (q.chain !== undefined && !["base","eth"].includes(String(q.chain))) return "chain must be one of: base, eth";
  return null;
}
