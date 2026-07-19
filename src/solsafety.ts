/**
 * solsafety.ts — Solana composite rug score. Extends /onchain/safety and /vet
 * to chain=solana, where a huge share of the agent/degen economy actually lives.
 *
 * Same design philosophy as the EVM composite: TWO independent sources fused,
 * with an agreement factor — never a re-wrap of one feed:
 *
 *   1. GoPlus Solana token_security (keyless) — mint/freeze/close authorities,
 *      balance-mutable authority, non-transferable flag, transfer fee/hook,
 *      top-10 holders w/ supply share, per-DEX LP burn %.
 *   2. RugCheck.xyz (keyless) — independent risk engine: named risks with
 *      levels, a normalized 0-100 score, LP-locked %.
 *
 * Solana-specific rug physics encoded here (different from EVM):
 *   • a live FREEZE authority can freeze your token account = the Solana honeypot
 *   • a live MINT authority can print supply into your face
 *   • LP is usually BURNED (not locked) — burn_percent is the safety signal
 *   • top-holder concentration matters more (no contract-level sell taxes)
 *
 * SECURITY: address must match the base58 regex; encodeURIComponent'd; errors
 * never echo upstream detail. All sources keyless + free.
 */
import { cached, getJson } from "./data.js";

const SOL_ADDR = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const num = (v: unknown): number | null => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
/** GoPlus Solana authority objects: { status: "0"|"1", authority: [...] } */
const auth = (v: any): boolean => String(v?.status ?? v ?? "0") === "1";

async function goplusSolana(address: string) {
  const j = await cached(`gps:${address}`, () =>
    getJson(
      `https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${encodeURIComponent(address)}`,
    ),
  );
  return j?.result?.[address] ?? null;
}

async function rugcheck(address: string) {
  const j = await cached(`rc:${address}`, () =>
    getJson(`https://api.rugcheck.xyz/v1/tokens/${encodeURIComponent(address)}/report/summary`),
  );
  if (!j || typeof j !== "object") return null;
  return {
    score_normalised: num(j.score_normalised), // 0-100, higher = worse
    lp_locked_pct: num(j.lpLockedPct),
    risks: Array.isArray(j.risks)
      ? j.risks.slice(0, 12).map((r: any) => ({ name: String(r?.name ?? ""), level: String(r?.level ?? ""), score: num(r?.score) }))
      : [],
  };
}

export async function solanaSafetyReport(address: string) {
  if (!SOL_ADDR.test(address)) return null;

  const [gp, rc] = await Promise.all([
    goplusSolana(address).catch(() => null),
    rugcheck(address).catch(() => null),
  ]);
  if (!gp && !rc) return null;

  const checks: Array<[string, boolean, number]> = [];

  // ── GoPlus Solana structural flags ──
  let top10Pct: number | null = null;
  let lpBurn: number | null = null;
  if (gp) {
    checks.push(["non-transferable token (cannot be sold)", String(gp.non_transferable ?? "0") === "1", 100]);
    checks.push(["freeze authority live — accounts can be frozen (Solana honeypot vector)", auth(gp.freezable), 55]);
    checks.push(["mint authority live — supply can be printed", auth(gp.mintable), 40]);
    checks.push(["balance-mutable authority — balances can be edited", auth(gp.balance_mutable_authority), 60]);
    checks.push(["token account closable by authority", auth(gp.closable), 40]);
    const fee = num(gp.transfer_fee?.fee_rate ?? gp.transfer_fee?.transfer_fee_rate);
    if (fee !== null && fee > 0.05) checks.push([`transfer fee ${(fee * 100).toFixed(1)}%`, true, 40]);
    if (Array.isArray(gp.transfer_hook) && gp.transfer_hook.length > 0)
      checks.push(["transfer hook present (custom transfer logic)", true, 30]);

    // top-10 holder concentration vs total supply
    const supply = num(gp.total_supply);
    const holders: any[] = Array.isArray(gp.holders) ? gp.holders : [];
    if (supply && supply > 0 && holders.length) {
      const top = holders.reduce((s, h) => s + (num(h?.balance) ?? 0), 0);
      top10Pct = Number(((top / supply) * 100).toFixed(1));
      if (top10Pct > 70) checks.push([`top-10 holders own ${top10Pct}% of supply`, true, 45]);
      else if (top10Pct > 45) checks.push([`top-10 holders own ${top10Pct}% of supply`, true, 25]);
    }
    // LP burn from the deepest listed pool
    const dex: any[] = Array.isArray(gp.dex) ? gp.dex : [];
    if (dex.length) lpBurn = num(dex[0]?.burn_percent);
  }

  // ── RugCheck independent risk engine ──
  if (rc) {
    for (const r of rc.risks) {
      if (!r.name) continue;
      if (r.level === "danger") checks.push([`rugcheck: ${r.name}`, true, 35]);
      else if (r.level === "warn" && !/mutable metadata/i.test(r.name)) checks.push([`rugcheck: ${r.name}`, true, 12]);
      // mutable metadata alone is near-universal on memecoins — noise, skip
    }
  }

  const redFlags = checks.filter(([, hit]) => hit).map(([label]) => label);
  let risk = Math.min(100, checks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0));

  // Hard gate: non-transferable = danger regardless of points.
  if (gp && String(gp.non_transferable ?? "0") === "1") risk = 100;

  // ── Agreement factor between the two engines ──
  const gpRisk = checks.filter(([l]) => !l.startsWith("rugcheck:")).reduce((s, [, hit, w]) => s + (hit ? w : 0), 0);
  const rcScore = rc?.score_normalised ?? null;
  const gpSaysClean = Boolean(gp) && gpRisk < 25;
  const rcSaysBad = rcScore !== null && rcScore >= 50;
  const gpSaysBad = gpRisk >= 60;
  const rcSaysClean = rcScore !== null && rcScore < 25;
  const needsReview = Boolean((gpSaysClean && rcSaysBad) || (gpSaysBad && rcSaysClean));

  let verdict: "ok" | "warning" | "danger" = risk >= 60 ? "danger" : risk >= 25 ? "warning" : "ok";
  if (needsReview && verdict === "ok") verdict = "warning";

  const greenChecks: Array<[string, boolean]> = [
    ["mint authority renounced", Boolean(gp) && !auth(gp.mintable)],
    ["freeze authority renounced", Boolean(gp) && !auth(gp.freezable)],
    ["balances not mutable", Boolean(gp) && !auth(gp.balance_mutable_authority)],
    [`LP ${lpBurn ?? "?"}% burned`, (lpBurn ?? 0) >= 90],
    [`LP ${rc?.lp_locked_pct?.toFixed?.(0) ?? "?"}% locked`, (rc?.lp_locked_pct ?? 0) >= 80],
    ["100k+ holders", (num(gp?.holder_count) ?? 0) >= 100_000],
    ["rugcheck score clean", rcScore !== null && rcScore < 25],
  ];
  const greenFlags = greenChecks.filter(([, ok]) => ok).map(([label]) => label);

  const sources = [gp ? "goplus-solana" : null, rc ? "rugcheck.xyz" : null].filter(Boolean) as string[];
  const confidence = needsReview ? "low (sources disagree)" : gp && rc ? "high" : "medium (single source)";

  return {
    chain: "solana",
    address,
    token: { name: gp?.metadata?.name ?? null, symbol: gp?.metadata?.symbol ?? null },
    verdict,
    risk_score: risk,
    confidence,
    needs_review: needsReview,
    red_flags: redFlags,
    green_flags: greenFlags,
    simulation: { available: false, note: "live buy/sell simulation is EVM-only — Solana uses dual-engine structural analysis instead" },
    details: {
      mint_authority_live: gp ? auth(gp.mintable) : null,
      freeze_authority_live: gp ? auth(gp.freezable) : null,
      balance_mutable: gp ? auth(gp.balance_mutable_authority) : null,
      non_transferable: gp ? String(gp.non_transferable ?? "0") === "1" : null,
      top10_holder_pct: top10Pct,
      lp_burn_pct: lpBurn,
      lp_locked_pct: rc?.lp_locked_pct ?? null,
      rugcheck_score: rcScore,
      holder_count: num(gp?.holder_count),
    },
    sources,
    as_of: new Date().toISOString(),
  };
}

export { SOL_ADDR };
