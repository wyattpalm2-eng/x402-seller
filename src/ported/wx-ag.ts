/**
 * /wx/ag/:lat/:lon — ported from crew build S-012 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./wx-ag.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_WX_AG = process.env.PRICE_WX_AG || "$0.03";

export const wxAgRouter: Router = Router();
wxAgRouter.get("/wx/ag/:lat/:lon", (req: Request, res: Response) => {
  const lat = String(req.params.lat ?? "");
  const lon = String(req.params.lon ?? "");
  return serve(res, "GET /wx/ag/:lat/:lon", priceToUsd(PRICE_WX_AG), `${lat},${lon}`, async () =>
    handler({ lat, lon }),
  );
});

export const wxAgRoutes = {
  "GET /wx/ag/:lat/:lon": {
    accepts: [{ scheme: "exact", price: PRICE_WX_AG, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Agricultural risk metrics from Open-Meteo: 13 hourly variables synthesized into a computed ag-risk score 0-100 with drought/excess-precip/high-wind/high-VPD/low-soil-moisture flags. Bots would need 8+ hourly API calls plus custom VPD/GDD/ET0 math to replicate.",
    mimeType: "application/json",
  },
};

export const wxAgCatalog = [
  {
    route: "GET /wx/ag/:lat/:lon",
    price: PRICE_WX_AG,
    params: "",
    desc: "Agricultural risk metrics from Open-Meteo: 13 hourly variables synthesized into a computed ag-risk score 0-100 with drought/excess-precip/high-wind/high-VPD/low-soil-moisture flags. Bots would need 8+ hourly API calls plus custom VPD/GDD/ET0 math to replicate.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateWxAg(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  const seg0 = String(reqPath || "").slice("/wx/ag/".length).split("/")[0];
  if (!seg0) return "usage: /wx/ag/:lat/:lon";
  const seg1 = String(reqPath || "").slice("/wx/ag/".length).split("/")[0];
  if (!seg1) return "usage: /wx/ag/:lat/:lon";
  return null;
}
