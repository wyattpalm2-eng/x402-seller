/**
 * safety.ts — token rug/honeypot safety report. Premium endpoint:
 *
 *   GET /onchain/safety?chain=base&address=0x…   →   $0.01
 *
 * Contract-security flags from GoPlus (free, keyless): honeypot, buy/sell tax,
 * hidden mint, LP lock, blacklist, pausable transfers — distilled into a
 * red-flag list, a 0-100 risk score, and an ok/warning/danger verdict.
 * This is the "should my agent ape into this launch?" check that pairs with
 * /onchain/new, and it's genuinely hard for a buyer to re-derive.
 *
 * SECURITY: chain resolves through a fixed EVM allowlist (GoPlus numeric chain
 * ids — no Solana here), address must match the EVM regex, both are also
 * encodeURIComponent'd. Errors never echo upstream detail.
 */
import { Router, type Request, type Response } from "express";
import { cached, getJson } from "./data.js";
import { getReceiveAddress } from "./wallet.js";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SAFETY = process.env.PRICE_ONCHAIN_SAFETY || "$0.01";

// our slug -> GoPlus numeric chain id. EVM only (GoPlus Solana is a different API).
const GOPLUS_CHAINS: Record<string, string> = {
  base: "8453",
  eth: "1",
  ethereum: "1",
  bsc: "56",
  polygon: "137",
  arbitrum: "42161",
  optimism: "10",
};
export const SAFETY_CHAINS = Object.keys(GOPLUS_CHAINS);
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

/** Pre-paywall validation: 400 before charging for a doomed call. */
export function validateSafety(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase().trim();
  if (!Object.prototype.hasOwnProperty.call(GOPLUS_CHAINS, chain)) {
    return `unsupported chain "${chain.slice(0, 24)}". supported: ${SAFETY_CHAINS.join(", ")}`;
  }
  // Missing address: let it reach the paywall (a discovery probe with no query
  // params must still see 402, not 400 — the handler 404s gracefully post-pay).
  // PROVIDED-but-malformed address: reject before charging, that's real abuse.
  if (q.address !== undefined && !EVM_ADDR.test(String(q.address))) return "invalid EVM token address";
  return null;
}

const flag = (v: unknown) => String(v) === "1"; // GoPlus uses "0"/"1" strings
const pct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n * 100).toFixed(2)) : null;
};

export async function safetyReport(chainKey: string, address: string) {
  if (!EVM_ADDR.test(address)) return null; // missing/empty address (e.g. a bare discovery probe) -> clean 404
  const chainId = GOPLUS_CHAINS[chainKey]; // validated upstream
  const addr = address.toLowerCase();
  const j = await cached(`gp:${chainId}:${addr}`, () =>
    getJson(
      `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(chainId)}` +
        `?contract_addresses=${encodeURIComponent(addr)}`,
    ),
  );
  const t = j?.result?.[addr];
  if (!t) return null;

  const lpLocked = Array.isArray(t.lp_holders) ? t.lp_holders.some((h: any) => String(h?.is_locked) === "1") : null;
  const buyTax = pct(t.buy_tax);
  const sellTax = pct(t.sell_tax);

  // Red flags, worst first. Each carries a weight toward the 0-100 risk score.
  const checks: Array<[string, boolean, number]> = [
    ["honeypot: holders cannot sell", flag(t.is_honeypot), 100],
    ["cannot sell all tokens", flag(t.cannot_sell_all), 60],
    ["owner can mint new supply", flag(t.is_mintable), 35],
    ["hidden owner", flag(t.hidden_owner), 35],
    ["contract can self-destruct", flag(t.selfdestruct), 40],
    ["transfers can be paused", flag(t.transfer_pausable), 30],
    ["blacklist function present", flag(t.is_blacklisted), 25],
    ["owner can change balances", flag(t.owner_change_balance), 60],
    ["proxy contract (logic can change)", flag(t.is_proxy), 15],
    ["source not verified", !flag(t.is_open_source), 30],
    [`sell tax over 10% (${sellTax ?? "?"}%)`, (sellTax ?? 0) > 10, 45],
    [`buy tax over 10% (${buyTax ?? "?"}%)`, (buyTax ?? 0) > 10, 30],
    ["LP not locked", lpLocked === false, 25],
  ];
  const redFlags = checks.filter(([, hit]) => hit).map(([label]) => label);
  const risk = Math.min(100, checks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0));
  const verdict = risk >= 60 ? "danger" : risk >= 25 ? "warning" : "ok";

  // Positive signals — so a "clear" verdict is trustworthy, not just an absence of flags.
  const greenChecks: Array<[string, boolean]> = [
    ["not a honeypot", !flag(t.is_honeypot)],
    ["source code verified", flag(t.is_open_source)],
    ["ownership renounced", String(t.owner_address ?? "") === "" || /^0x0+$/.test(String(t.owner_address ?? ""))],
    ["cannot mint new supply", !flag(t.is_mintable)],
    ["0% buy & sell tax", (buyTax ?? 0) === 0 && (sellTax ?? 0) === 0],
    ["liquidity locked", lpLocked === true],
    ["10k+ holders", (Number(t.holder_count) || 0) >= 10000],
  ];
  const greenFlags = greenChecks.filter(([, ok]) => ok).map(([label]) => label);

  return {
    chain: chainKey,
    address: addr,
    token: { name: t.token_name ?? null, symbol: t.token_symbol ?? null },
    verdict,
    risk_score: risk, // 0-100, higher = worse
    red_flags: redFlags,
    green_flags: greenFlags,
    details: {
      honeypot: flag(t.is_honeypot),
      buy_tax_pct: buyTax,
      sell_tax_pct: sellTax,
      open_source: flag(t.is_open_source),
      mintable: flag(t.is_mintable),
      proxy: flag(t.is_proxy),
      transfer_pausable: flag(t.transfer_pausable),
      lp_locked: lpLocked,
      holder_count: Number(t.holder_count) || null,
      creator_address: t.creator_address ?? null,
    },
    as_of: new Date().toISOString(),
  };
}

export const safetyRouter: Router = Router();

safetyRouter.get("/onchain/safety", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base").toLowerCase().trim();
  const address = String(req.query.address ?? "");
  return serve(res, "GET /onchain/safety", priceToUsd(PRICE_SAFETY), address.slice(0, 12), () =>
    safetyReport(chain, address),
  );
});

// x402 paywall fragment + catalog entry (shapes match index.ts)
export const safetyRoutes = {
  "GET /onchain/safety": {
    accepts: [{ scheme: "exact", price: PRICE_SAFETY, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Token rug/honeypot safety report: red flags, risk score, verdict",
    mimeType: "application/json",
  },
};

export const safetyCatalog = [
  {
    route: "GET /onchain/safety",
    price: PRICE_SAFETY,
    params: "?chain=base&address=0x…",
    desc: "Rug/honeypot safety report: red flags, 0-100 risk score, ok/warning/danger verdict",
  },
];
