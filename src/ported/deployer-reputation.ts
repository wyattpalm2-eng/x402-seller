/**
 * /vet/deployer/:address — ported from crew build S-036 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./deployer-reputation.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_DEPLOYER_REPUTATION = process.env.PRICE_DEPLOYER_REPUTATION || "$0.05";

export const deployerReputationRouter: Router = Router();
deployerReputationRouter.get("/vet/deployer/:address", (req: Request, res: Response) => {
  const address = String(req.params.address ?? "");
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /vet/deployer/:address", priceToUsd(PRICE_DEPLOYER_REPUTATION), `${address},${chain}`, async () =>
    handler({ address, chain }),
  );
});

export const deployerReputationRoutes = {
  "GET /vet/deployer/:address": {
    accepts: [{ scheme: "exact", price: PRICE_DEPLOYER_REPUTATION, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Deployer trust score (0-100) for a Base EVM address, computed from our own graded track_record.jsonl (token launch history, rug rate, relauncher flag). Bots calling this skip building a deployer address tracker plus elapsed-time track record themselves.",
    mimeType: "application/json",
  },
};

export const deployerReputationCatalog = [
  {
    route: "GET /vet/deployer/:address",
    price: PRICE_DEPLOYER_REPUTATION,
    params: "?chain=base",
    desc: "Deployer trust score (0-100) for a Base EVM address, computed from our own graded track_record.jsonl (token launch history, rug rate, relauncher flag). Bots calling this skip building a deployer address tracker plus elapsed-time track record themselves.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateDeployerReputation(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  const seg0 = String(reqPath || "").slice("/vet/deployer/".length).split("/")[0];
  if (!seg0) return "usage: /vet/deployer/:address?chain=base";
  return null;
}
