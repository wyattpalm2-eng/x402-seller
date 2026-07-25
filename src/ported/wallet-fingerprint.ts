/**
 * /wallet/fingerprint/:address — ported from crew build S-009 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./wallet-fingerprint.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_WALLET_FINGERPRINT = process.env.PRICE_WALLET_FINGERPRINT || "$0.05";

export const walletFingerprintRouter: Router = Router();
walletFingerprintRouter.get("/wallet/fingerprint/:address", (req: Request, res: Response) => {
  const address = String(req.params.address ?? "");
  const chain = String(req.query.chain ?? "base");
  return serve(res, "GET /wallet/fingerprint/:address", priceToUsd(PRICE_WALLET_FINGERPRINT), `${address},${chain}`, async () =>
    handler({ chain, address }),
  );
});

export const walletFingerprintRoutes = {
  "GET /wallet/fingerprint/:address": {
    accepts: [{ scheme: "exact", price: PRICE_WALLET_FINGERPRINT, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Composite wallet fingerprint (0-100) for any Base or Ethereum address: aggregates native balance, tx count, contract bytecode, ERC-20 token holdings, and DeFi protocol exposure (DefiLlama). Four+ separate RPC calls and cross-source synthesis collapsed into one call.",
    mimeType: "application/json",
  },
};

export const walletFingerprintCatalog = [
  {
    route: "GET /wallet/fingerprint/:address",
    price: PRICE_WALLET_FINGERPRINT,
    params: "?chain=base",
    desc: "Composite wallet fingerprint (0-100) for any Base or Ethereum address: aggregates native balance, tx count, contract bytecode, ERC-20 token holdings, and DeFi protocol exposure (DefiLlama). Four+ separate RPC calls and cross-source synthesis collapsed into one call.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateWalletFingerprint(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  const seg0 = String(reqPath || "").slice("/wallet/fingerprint/".length).split("/")[0];
  if (!seg0) return "usage: /wallet/fingerprint/:address?chain=base";
  if (!/^0x[a-fA-F0-9]{40}$/.test(seg0)) return "address is malformed. usage: /wallet/fingerprint/:address?chain=base";
  if (q.chain !== undefined && !["base","eth"].includes(String(q.chain))) return "chain must be one of: base, eth";
  return null;
}
