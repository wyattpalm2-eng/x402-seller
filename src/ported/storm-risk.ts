/**
 * /wx/storm — ported from crew build S-016 by porter.js. PROVEN by the Proving Ground.
 *
 * The handler is the crew's logic, vendored verbatim. The real x402 gate is GLOBAL in
 * index.ts, so this file is only route wiring. Generated — re-running the porter
 * overwrites it; change PORT.json, not this.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./storm-risk.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_STORM_RISK = process.env.PRICE_STORM_RISK || "$0.04";

export const stormRiskRouter: Router = Router();
stormRiskRouter.get("/wx/storm", (req: Request, res: Response) => {
  const lat = String(req.query.lat ?? "");
  const lon = String(req.query.lon ?? "");
  return serve(res, "GET /wx/storm", priceToUsd(PRICE_STORM_RISK), `${lat},${lon}`, async () =>
    handler({ lat, lon }),
  );
});

export const stormRiskRoutes = {
  "GET /wx/storm": {
    accepts: [{ scheme: "exact", price: PRICE_STORM_RISK, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Storm risk for any coordinate: resolves NOAA/NWS active-alert GeoJSON polygons with real point-in-polygon math, blends in wind and severity, and returns one scored risk verdict. Replaces polygon parsing plus multi-API orchestration a bot would otherwise implement and maintain itself.",
    mimeType: "application/json",
  },
};

export const stormRiskCatalog = [
  {
    route: "GET /wx/storm",
    price: PRICE_STORM_RISK,
    params: "?lat=30.26&lon=-97.74",
    desc: "Storm risk for any coordinate: resolves NOAA/NWS active-alert GeoJSON polygons with real point-in-polygon math, blends in wind and severity, and returns one scored risk verdict. Replaces polygon parsing plus multi-API orchestration a bot would otherwise implement and maintain itself.",
  },
];

/** Pre-paywall check so a bot never pays for a request that cannot succeed.
 *  reqPath is passed for path-param routes (the segment is not in req.query). */
export function validateStormRisk(q: Record<string, any>, reqPath?: string): string | null {
  void q; void reqPath;
  if (!q.lat) return "usage: /wx/storm?lat=30.26&lon=-97.74";
  if (!q.lon) return "usage: /wx/storm?lat=30.26&lon=-97.74";
  return null;
}
