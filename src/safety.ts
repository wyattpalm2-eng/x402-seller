/**
 * safety.ts — COMPOSITE token rug/honeypot score. Premium endpoint:
 *
 *   GET /onchain/safety?chain=base&address=0x…   →   $0.03
 *
 * The one call a trading agent MUST make before it apes into a token, because
 * getting it wrong costs its whole position. We fuse TWO independent methods no
 * single free source combines:
 *
 *   1. GoPlus (static bytecode analysis) — honeypot heuristics, taxes, mint/owner
 *      privileges, LP holders, holder distribution, "same-creator honeypot" flag.
 *   2. Honeypot.is (DYNAMIC simulation) — actually executes a simulated buy AND
 *      sell on-chain, so it catches sell-traps the static scanner misses and
 *      clears benign tokens GoPlus over-flags. Confirmed to cover ETH/BSC/Base.
 *
 * On top of the two feeds we add the judgment layer that makes this worth paying
 * for and that raw-data sellers don't offer:
 *   • HARD-ZERO GATES  — any dead-certain trap (live-sim honeypot, can't-sell-all)
 *     forces a danger verdict regardless of the point score.
 *   • AGREEMENT FACTOR — when the static and dynamic methods DISAGREE, we cap the
 *     verdict and raise needs_review. Concordance = confidence; conflict = signal.
 *   • SERIAL-RUGGER     — deployer linked to a prior honeypot is a first-class flag.
 *
 * SECURITY: chain resolves through a fixed EVM allowlist (GoPlus numeric ids —
 * no Solana here); address must match the EVM regex; both are encodeURIComponent'd.
 * Errors never echo upstream detail.
 */
import { Router, type Request, type Response } from "express";
import { cached, getJson } from "./data.js";
import { getReceiveAddress } from "./wallet.js";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SAFETY = process.env.PRICE_ONCHAIN_SAFETY || "$0.03";

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
// Chains where Honeypot.is dynamic simulation is available (verified live).
// Elsewhere we degrade to GoPlus-only and say so in the report.
const HONEYPOT_CHAINS = new Set(["1", "56", "8453"]);
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
const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const pct = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? Number((n * 100).toFixed(2)) : null;
};

/** Honeypot.is dynamic buy/sell simulation. Returns null off-chain or on error. */
async function honeypotSim(chainId: string, address: string) {
  if (!HONEYPOT_CHAINS.has(chainId)) return null;
  const j = await cached(`hp:${chainId}:${address.toLowerCase()}`, () =>
    getJson(
      `https://api.honeypot.is/v2/IsHoneypot?address=${encodeURIComponent(address)}&chainID=${encodeURIComponent(chainId)}`,
    ),
  );
  if (!j || typeof j !== "object") return null;
  const sim = j.simulationResult ?? {};
  const sum = j.summary ?? {};
  const ha = j.holderAnalysis ?? {};
  return {
    is_honeypot: j.honeypotResult?.isHoneypot === true,
    sim_success: j.simulationSuccess === true,
    buy_tax: num(sim.buyTax),
    sell_tax: num(sim.sellTax),
    transfer_tax: num(sim.transferTax),
    risk: sum.risk ?? null,
    risk_level: num(sum.riskLevel), // 0 (safe) .. higher = worse
    flags: Array.isArray(j.flags) ? j.flags.slice(0, 10) : [],
    holders_tested: num(ha.holders),
    holders_cant_sell: num(ha.failed),
  };
}

export async function safetyReport(chainKey: string, address: string) {
  if (!EVM_ADDR.test(address)) return null; // missing/empty address (e.g. a bare discovery probe) -> clean 404
  const chainId = GOPLUS_CHAINS[chainKey]; // validated upstream
  const addr = address.toLowerCase();

  // Two independent methods in parallel: static (GoPlus) + dynamic (Honeypot.is).
  const [gp, hp] = await Promise.all([
    cached(`gp:${chainId}:${addr}`, () =>
      getJson(
        `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(chainId)}` +
          `?contract_addresses=${encodeURIComponent(addr)}`,
      ),
    ).catch(() => null),
    honeypotSim(chainId, addr).catch(() => null),
  ]);

  const t = gp?.result?.[addr];
  if (!t && !hp) return null; // neither source had anything -> 404

  const lpLocked = t && Array.isArray(t.lp_holders) ? t.lp_holders.some((h: any) => String(h?.is_locked) === "1") : null;
  const gpBuyTax = t ? pct(t.buy_tax) : null;
  const gpSellTax = t ? pct(t.sell_tax) : null;

  // Ownership renounced (and NOT reclaimable) neutralizes owner-power flags —
  // nobody can call mint/blacklist/pause on a truly renounced contract, so those
  // flags get heavily discounted. can_take_back_ownership=true means the renounce
  // is reversible, so it does NOT count as renounced.
  const renounced =
    Boolean(t) &&
    !flag(t?.can_take_back_ownership) &&
    (String(t?.owner_address ?? "") === "" || /^0x0+$/.test(String(t?.owner_address ?? "")));
  const ow = (w: number) => (renounced ? Math.round(w * 0.4) : w); // discount owner-power weight

  // ── Static red flags (GoPlus), each weighted toward the 0-100 risk score ──
  const staticChecks: Array<[string, boolean, number]> = t
    ? [
        ["honeypot: holders cannot sell (static)", flag(t.is_honeypot), 100],
        ["cannot sell all tokens", flag(t.cannot_sell_all), 60],
        ["deployer linked to a prior honeypot", flag(t.honeypot_with_same_creator), 55],
        ["owner can mint new supply", flag(t.is_mintable), ow(35)],
        ["hidden owner", flag(t.hidden_owner), ow(35)],
        ["contract can self-destruct", flag(t.selfdestruct), 40],
        ["transfers can be paused", flag(t.transfer_pausable), ow(30)],
        ["blacklist function present", flag(t.is_blacklisted), ow(25)],
        ["owner can change balances", flag(t.owner_change_balance), ow(60)],
        ["can reclaim ownership", flag(t.can_take_back_ownership), 40],
        ["proxy contract (logic can change)", flag(t.is_proxy), 15],
        ["source not verified", !flag(t.is_open_source), 30],
        [`static sell tax over 10% (${gpSellTax ?? "?"}%)`, (gpSellTax ?? 0) > 10, 45],
        [`static buy tax over 10% (${gpBuyTax ?? "?"}%)`, (gpBuyTax ?? 0) > 10, 30],
        ["LP not locked", lpLocked === false, 25],
      ]
    : [];

  // ── Dynamic signals (Honeypot.is live buy/sell simulation) ──
  const dynChecks: Array<[string, boolean, number]> = [];
  if (hp) {
    if (hp.is_honeypot) {
      dynChecks.push(["HONEYPOT: live sell simulation FAILED", true, 100]);
    } else {
      if ((hp.sell_tax ?? 0) > 50) dynChecks.push([`extreme simulated sell tax ${hp.sell_tax}%`, true, 80]);
      else if ((hp.sell_tax ?? 0) > 10) dynChecks.push([`high simulated sell tax ${hp.sell_tax}%`, true, 40]);
      if (!hp.sim_success) dynChecks.push(["could not simulate a sell — sellability unverifiable", true, 20]);
      // Use the FRACTION that can't sell, not the raw count: 1-of-13k is noise
      // (a blacklisted scammer or a contract address), a large fraction is a trap.
      const tested = hp.holders_tested ?? 0;
      const cant = hp.holders_cant_sell ?? 0;
      if (tested > 0 && cant > 0) {
        const rate = cant / tested;
        if (rate > 0.5) dynChecks.push([`majority of tested holders can't sell (${cant}/${tested})`, true, 70]);
        else if (rate > 0.1) dynChecks.push([`${Math.round(rate * 100)}% of tested holders can't sell (${cant}/${tested})`, true, 35]);
        else if (rate > 0.03) dynChecks.push([`${(rate * 100).toFixed(1)}% of tested holders can't sell`, true, 15]);
        // below 3% = noise, no penalty
      }
    }
  }

  const allChecks = [...staticChecks, ...dynChecks];
  const redFlags = allChecks.filter(([, hit]) => hit).map(([label]) => label);
  const staticRisk = staticChecks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0);
  let risk = Math.min(100, allChecks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0));

  // ── HARD-ZERO GATES: a dead-certain trap is danger, whatever the point total ──
  const hardTrap = (hp?.is_honeypot === true) || flag(t?.is_honeypot) || flag(t?.cannot_sell_all);
  if (hardTrap) risk = 100;

  // ── AGREEMENT FACTOR: static vs dynamic disagreement is itself a signal ──
  const haveBoth = Boolean(t && hp);
  const gpSaysClean = Boolean(t) && staticRisk < 25;
  const hpSaysBad = Boolean(hp) && (hp!.is_honeypot || (hp!.sell_tax ?? 0) > 10 || (hp!.risk_level ?? 0) >= 3);
  const gpSaysBad = staticRisk >= 60;
  const hpSaysClean = Boolean(hp) && !hp!.is_honeypot && (hp!.sell_tax ?? 0) <= 10 && (hp!.risk_level ?? 0) <= 1;
  const needsReview = Boolean((gpSaysClean && hpSaysBad) || (gpSaysBad && hpSaysClean));

  let verdict: "ok" | "warning" | "danger" = risk >= 60 ? "danger" : risk >= 25 ? "warning" : "ok";
  // A disagreement must never read as "clear" — floor it to caution.
  if (needsReview && verdict === "ok") verdict = "warning";

  // ── Positive signals — so a "clear" verdict is earned, not just absent flags ──
  const greenChecks: Array<[string, boolean]> = [
    ["passed live buy & sell simulation", Boolean(hp) && !hp!.is_honeypot && hp!.sim_success === true],
    ["0% simulated buy & sell tax", Boolean(hp) && (hp!.buy_tax ?? 1) === 0 && (hp!.sell_tax ?? 1) === 0],
    ["source code verified", flag(t?.is_open_source)],
    ["ownership renounced", t ? (String(t.owner_address ?? "") === "" || /^0x0+$/.test(String(t.owner_address ?? ""))) : false],
    ["cannot mint new supply", Boolean(t) && flag(t?.is_mintable) === false],
    ["liquidity locked", lpLocked === true],
    ["10k+ holders", (Number(t?.holder_count) || 0) >= 10000],
  ];
  const greenFlags = greenChecks.filter(([, ok]) => ok).map(([label]) => label);

  const sources = [t ? "goplus (static)" : null, hp ? "honeypot.is (dynamic sim)" : null].filter(Boolean) as string[];
  const confidence = needsReview ? "low (sources disagree)" : haveBoth ? "high" : "medium (single source)";

  return {
    chain: chainKey,
    address: addr,
    token: { name: t?.token_name ?? null, symbol: t?.token_symbol ?? null },
    verdict, // ok | warning | danger — read this first
    risk_score: risk, // 0-100, higher = worse
    confidence,
    needs_review: needsReview, // static and dynamic methods disagree — don't trust a clean read
    red_flags: redFlags,
    green_flags: greenFlags,
    simulation: hp
      ? {
          is_honeypot: hp.is_honeypot,
          simulated: hp.sim_success,
          buy_tax_pct: hp.buy_tax,
          sell_tax_pct: hp.sell_tax,
          holders_tested: hp.holders_tested,
          holders_cant_sell: hp.holders_cant_sell,
          risk: hp.risk,
        }
      : { available: false, note: "dynamic simulation not available on this chain — static analysis only" },
    details: {
      honeypot_static: flag(t?.is_honeypot),
      honeypot_simulated: hp?.is_honeypot ?? null,
      buy_tax_pct: hp?.buy_tax ?? gpBuyTax,
      sell_tax_pct: hp?.sell_tax ?? gpSellTax,
      open_source: flag(t?.is_open_source),
      mintable: flag(t?.is_mintable),
      proxy: flag(t?.is_proxy),
      same_creator_honeypot: flag(t?.honeypot_with_same_creator),
      lp_locked: lpLocked,
      holder_count: Number(t?.holder_count) || null,
      creator_address: t?.creator_address ?? null,
    },
    sources,
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
    description: "Composite rug/honeypot score: static (GoPlus) + LIVE buy/sell simulation (Honeypot.is), fused into one verdict",
    mimeType: "application/json",
  },
};

export const safetyCatalog = [
  {
    route: "GET /onchain/safety",
    price: PRICE_SAFETY,
    params: "?chain=base&address=0x…",
    desc: "Composite rug score: static analysis + LIVE buy/sell simulation + serial-rugger check → one ok/warning/danger verdict with a disagreement flag",
  },
];
