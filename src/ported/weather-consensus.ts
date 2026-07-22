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

export const weatherRouter: Router = Router();
weatherRouter.get("/weather/consensus", (req: Request, res: Response) => {
  const lat = String(req.query.lat ?? "");
  const lon = String(req.query.lon ?? "");
  return serve(res, "GET /weather/consensus", priceToUsd(PRICE_WEATHER), `${lat},${lon}`, () =>
    handler({ lat, lon }),
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
