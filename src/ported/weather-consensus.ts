/**
 * /weather/consensus — the first crew-built endpoint ported through the bridge (S-006).
 *
 * Cross-source weather consensus (Open-Meteo + NOAA/NWS + 7Timer), keyless. The handler
 * is the crew's PROVEN logic, vendored verbatim as a .cjs; the real x402 gate is GLOBAL
 * in index.ts, so this file is just the route wiring. The charge contract lives in the
 * handler via serve(): a result object charges (200), null is an uncharged 404, a throw
 * is an uncharged 502 — so a buyer is never billed for junk.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import { getReceiveAddress } from "../wallet.js";
import handler from "./weather-consensus.handler.cjs";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_WEATHER = process.env.PRICE_WEATHER || "$0.03";

/**
 * Quality gate at the ROUTE layer (the crew's handler stays vendored verbatim):
 * a "consensus" of ONE source is not a consensus — under upstream degradation
 * (e.g. Open-Meteo's shared-IP daily quota, hit 2026-07-23) the raw handler
 * returns sourceCount:1 with agreementScore:100, which would bill a buyer $0.03
 * for single-source data dressed as perfect agreement. serve() maps null to an
 * UNCHARGED 404 — so degraded results cost the buyer nothing, per the law that
 * buyers never pay for junk.
 */
export function gateConsensus<T extends { consensus?: { sourceCount?: number } }>(data: T | null): T | null {
  if (data == null) return null;
  return (data.consensus?.sourceCount ?? 0) >= 2 ? data : null;
}

export const weatherRouter: Router = Router();
weatherRouter.get("/weather/consensus", (req: Request, res: Response) => {
  const lat = String(req.query.lat ?? "");
  const lon = String(req.query.lon ?? "");
  return serve(res, "GET /weather/consensus", priceToUsd(PRICE_WEATHER), `${lat},${lon}`, async () =>
    gateConsensus(await handler({ lat, lon })),
  );
});

export const weatherRoutes = {
  "GET /weather/consensus": {
    accepts: [{ scheme: "exact", price: PRICE_WEATHER, network: NETWORK, payTo: getReceiveAddress() }],
    description:
      "Cross-source weather consensus (Open-Meteo + NOAA + 7Timer): blended temperature + an agreement score in one keyless call",
    mimeType: "application/json",
  },
};

export const weatherCatalog = [
  {
    route: "GET /weather/consensus",
    price: PRICE_WEATHER,
    params: "?lat=40.71&lon=-74.01",
    desc: "Cross-source weather consensus + agreement score (keyless: Open-Meteo + NOAA + 7Timer). One call instead of stitching 3 free weather APIs.",
  },
];

/** Pre-paywall check so a bot never pays for a request that can't succeed. */
export function validateWeather(q: Record<string, any>): string | null {
  if (q.lat === undefined || q.lon === undefined) return "usage: /weather/consensus?lat=40.71&lon=-74.01";
  const lat = Number(q.lat), lon = Number(q.lon);
  if (!isFinite(lat) || !isFinite(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180)
    return "lat must be between -90 and 90, lon between -180 and 180";
  return null;
}
