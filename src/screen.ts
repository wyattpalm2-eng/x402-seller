/**
 * screen.ts — batch token safety screener. The launch-hunter moat:
 *
 *   GET /screen?chain=base&addresses=0x..,0x..,0x..   →   $0.03
 *
 * "Here's my watchlist / the newest launches — which ones aren't rugs?"
 * Runs the full contract-security check on up to 8 tokens IN PARALLEL and
 * returns them sorted safest-first, each with verdict + risk score, plus a
 * summary count. One paid call replaces N lookups + writing the merge/sort
 * logic + burning the agent's own tokens reconciling them.
 *
 * SECURITY: chain via the same EVM allowlist; each address regex-validated;
 * list capped at 8 so a caller can't fan out unbounded upstream load.
 */
import { Router, type Request, type Response } from "express";
import { getReceiveAddress } from "./wallet.js";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { safetyReport, SAFETY_CHAINS } from "./safety.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SCREEN = process.env.PRICE_SCREEN || "$0.03";
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const MAX_TOKENS = 8;

const EVM_CHAINS = new Set(SAFETY_CHAINS);

function parseAddresses(raw: unknown): string[] {
  return String(raw ?? "")
    .split(",")
    .map((a) => a.trim())
    .filter(Boolean)
    .slice(0, MAX_TOKENS);
}

/** Pre-paywall validation: 400 before charging only for genuinely malformed input. */
export function validateScreen(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase().trim();
  if (!EVM_CHAINS.has(chain)) return `unsupported chain. supported: ${SAFETY_CHAINS.join(", ")}`;
  const addrs = parseAddresses(q.addresses);
  // Missing addresses -> let it reach the paywall (discovery probe), handler 404s.
  if (addrs.length && addrs.some((a) => !EVM_ADDR.test(a))) return "each ?addresses= entry must be a valid 0x… token";
  return null;
}

export async function screenTokens(chainKey: string, addresses: string[]) {
  const valid = addresses.filter((a) => EVM_ADDR.test(a));
  if (!valid.length) return null;
  const reports = await Promise.all(
    valid.map((a) => safetyReport(chainKey, a).catch(() => null)),
  );
  const results = reports
    .filter(Boolean)
    .sort((a: any, b: any) => (a.risk_score ?? 99) - (b.risk_score ?? 99))
    .map((r: any) => ({
      address: r.address,
      symbol: r.token?.symbol ?? null,
      verdict: r.verdict,
      risk_score: r.risk_score,
      top_red_flag: r.red_flags?.[0] ?? null,
    }));
  const summary = {
    screened: results.length,
    clear: results.filter((r) => r.verdict === "ok").length,
    caution: results.filter((r) => r.verdict === "warning").length,
    avoid: results.filter((r) => r.verdict === "danger").length,
  };
  return { chain: chainKey, summary, tokens: results, as_of: new Date().toISOString() };
}

export const screenRouter: Router = Router();

screenRouter.get("/screen", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base").toLowerCase().trim();
  const addresses = parseAddresses(req.query.addresses);
  return serve(res, "GET /screen", priceToUsd(PRICE_SCREEN), `${addresses.length}tok`, () =>
    screenTokens(chain, addresses),
  );
});

export const screenRoutes = {
  "GET /screen": {
    accepts: [{ scheme: "exact", price: PRICE_SCREEN, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Batch rug/safety screen: up to 8 tokens in one call, sorted safest-first + summary",
    mimeType: "application/json",
  },
};

export const screenCatalog = [
  {
    route: "GET /screen",
    price: PRICE_SCREEN,
    params: "?chain=base&addresses=0x..,0x..",
    desc: "Batch safety screen up to 8 tokens: verdict + risk each, sorted safest-first, with a clear/caution/avoid summary",
  },
];
