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
 * Two curated GitHub lists (free, keyless) sharpen the ends of the scale:
 *   • KNOWN-SCAM BLOCKLIST (MyEtherWallet ethereum-lists, ~650 documented scammer
 *     addresses) — a hit on the token OR its deployer is a hard danger gate: the
 *     highest-confidence red flag, a curated record that the address already stole.
 *   • REPUTABLE ALLOWLIST (Uniswap default token list) — a vetted token is real
 *     positive evidence that lets a clean verdict be EARNED, not defaulted.
 * And DexScreener adds the MARKET dimension no contract scan can see: pair AGE
 * (pairCreatedAt — a pair born hours ago is the fresh-rug window, one of the
 * strongest predictors) and absolute liquidity depth. Fresh + thin compounds with
 * the unverified penalties for exactly the fresh scams that inverted this scorer.
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
import { solanaSafetyReport, SOL_ADDR } from "./solsafety.js";
import { verdictHonesty } from "./calib-cache.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_SAFETY = process.env.PRICE_ONCHAIN_SAFETY || "$0.01";

// our slug -> GoPlus numeric chain id (EVM). Solana routes to solsafety.ts
// (GoPlus Solana API + RugCheck — a different composite for different rug physics).
const GOPLUS_CHAINS: Record<string, string> = {
  base: "8453",
  eth: "1",
  ethereum: "1",
  bsc: "56",
  polygon: "137",
  arbitrum: "42161",
  optimism: "10",
};
export const SAFETY_CHAINS = [...Object.keys(GOPLUS_CHAINS), "solana"];
// Chains where Honeypot.is dynamic simulation is available (verified live).
// Elsewhere we degrade to GoPlus-only and say so in the report.
const HONEYPOT_CHAINS = new Set(["1", "56", "8453"]);

// Blockscout instances (free, NO key) — a THIRD independent source, added 2026-07-27. Its job is
// the fresh-token gap that inverted the scorer: when GoPlus has not yet analysed a token, GoPlus
// returns nothing and the old code called it "ok". Blockscout still knows whether the contract is
// verified and how many holders it has — real signal exactly where GoPlus is blind. An unverified
// contract with a handful of holders is the fresh-rug profile, and this catches it.
const BLOCKSCOUT: Record<string, string> = {
  "8453": "https://base.blockscout.com",
  "1": "https://eth.blockscout.com",
  "10": "https://optimism.blockscout.com",
};
async function blockscout(chainId: string, addr: string) {
  const base = BLOCKSCOUT[chainId];
  if (!base) return null;
  const [tok, con] = await Promise.all([
    cached(`bs:tok:${chainId}:${addr}`, () => getJson(`${base}/api/v2/tokens/${encodeURIComponent(addr)}`)).catch(() => null),
    cached(`bs:con:${chainId}:${addr}`, () => getJson(`${base}/api/v2/smart-contracts/${encodeURIComponent(addr)}`)).catch(() => null),
  ]);
  if (!tok && !con) return null;
  return {
    holders: num(tok?.holders ?? tok?.holders_count),
    verified: con ? con.is_verified === true : null, // null = Blockscout had no contract record either
    name: tok?.name ?? con?.name ?? null,
  };
}

// KNOWN-BAD ADDRESS LISTS (free, NO key) — three independent curated blocklists merged, ~3,300
// addresses total. This is a different KIND of signal from every scanner above: not "the contract
// shape looks risky" but "this exact address is documented bad". A hit is a HARD danger gate — the
// highest-confidence red flag the scorer can get. We check the token address AND its deployer (GoPlus
// creator_address), because the drainer/collector/deployer EOAs are exactly what these lists catalogue.
//   • OFAC (US Treasury sanctions, ~97) — the most severe; a sanctioned address is illegal to transact.
//   • MyEtherWallet ethereum-lists darklist (~650) — human-curated, each with a written reason.
//   • ScamSniffer scam database (~2,530) — the large, actively-maintained drainer/scam wallet set.
// Each list is cached and catch-guarded on its OWN, so one source failing never blanks the others.
// All are eth-curated but scam/sanctioned addresses are reused across chains, so Base hits occur; a
// MISS still means nothing (partial coverage) — absence is NEVER scored as safety.
const MEW_DARKLIST_URL =
  "https://raw.githubusercontent.com/MyEtherWallet/ethereum-lists/master/src/addresses/addresses-darklist.json";
const SCAMSNIFFER_URL =
  "https://raw.githubusercontent.com/scamsniffer/scam-database/main/blacklist/address.json";
const OFAC_URL =
  "https://raw.githubusercontent.com/ultrasoundmoney/ofac-ethereum-addresses/main/data.csv";

/** Fetch raw text with the same timeout policy as getJson (OFAC ships CSV, not JSON). */
async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { "user-agent": "x402-seller/0.1 (+safety)" } });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.text();
}

// Merge order = precedence on overlap (last wins): ScamSniffer < MyEtherWallet < OFAC, so the most
// severe/specific label survives. Rebuilt per call from the three SWR-cached sources (~3.3k Map.set,
// sub-millisecond). Returns null only when ALL three failed to load (so "source consulted" stays honest).
async function knownBadMap(): Promise<Map<string, { src: string; reason: string }> | null> {
  const [mew, ss, ofac] = await Promise.all([
    cached("badlist:mew", () => getJson(MEW_DARKLIST_URL)).catch(() => null),
    cached("badlist:scamsniffer", () => getJson(SCAMSNIFFER_URL)).catch(() => null),
    cached("badlist:ofac", async () =>
      (await fetchText(OFAC_URL)).trim().split(/\r?\n/).slice(1)
        .map((l) => l.split(",")[0].trim().toLowerCase())
        .filter((a) => EVM_ADDR.test(a)),
    ).catch(() => null),
  ]);
  const map = new Map<string, { src: string; reason: string }>();
  if (Array.isArray(ss)) for (const a of ss) { const k = String(a).toLowerCase(); if (EVM_ADDR.test(k)) map.set(k, { src: "ScamSniffer", reason: "flagged in ScamSniffer's scam/drainer database" }); }
  if (Array.isArray(mew)) for (const e of mew) if (e?.address) map.set(String(e.address).toLowerCase(), { src: "MyEtherWallet", reason: String(e.comment || "listed on the MyEtherWallet darklist") });
  if (Array.isArray(ofac)) for (const a of ofac) map.set(String(a).toLowerCase(), { src: "OFAC", reason: "OFAC-SANCTIONED by the US Treasury — illegal to transact" });
  return map.size ? map : null;
}

// REPUTABLE ALLOWLIST (free, NO key) — Uniswap default token list, added 2026-07-27. The GREEN
// counterpart: a token vetted onto Uniswap's curated list is essentially never a fresh rug, so its
// presence is real positive evidence that helps a clean verdict get EARNED (rather than defaulting
// from the mere absence of red flags — the exact hole that inverted this scorer). Absence is NEUTRAL:
// most legitimate small tokens are not listed either, so a miss adds nothing and never false-flags.
const UNISWAP_LISTS: Record<string, string> = {
  "8453": "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/base.json",
  "1": "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/mainnet.json",
  "10": "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/optimism.json",
  "42161": "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/arbitrum.json",
  "137": "https://raw.githubusercontent.com/Uniswap/default-token-list/main/src/tokens/polygon.json",
};
const _trustMemo: Record<string, { src: any[]; set: Set<string> }> = {};
async function isReputableToken(chainId: string, addr: string): Promise<boolean> {
  const url = UNISWAP_LISTS[chainId];
  if (!url) return false;
  const list = await cached(`tokenlist:uniswap:${chainId}`, () => getJson(url)).catch(() => null);
  if (!Array.isArray(list)) return false; // fetch failed -> just no green flag, never a red one
  const memo = _trustMemo[chainId];
  if (!memo || memo.src !== list) {
    const set = new Set<string>();
    for (const tok of list) if (tok?.address) set.add(String(tok.address).toLowerCase());
    _trustMemo[chainId] = { src: list, set };
  }
  return _trustMemo[chainId].set.has(addr);
}

// DEX MARKET AGE + LIQUIDITY (DexScreener, free NO key) — added 2026-07-27. This is the AGE
// dimension the contract scanners are completely blind to, and age is one of the strongest rug
// predictors there is: the tokens that inverted this scorer were fresh scams tradeable on a DEX but
// not yet analysed by GoPlus. `pairCreatedAt` is a real on-chain signal of when the token first got
// a market. We take the OLDEST pair on the matching chain as the token's age (earliest market) and
// the DEEPEST pair's liquidity (its primary market). Fresh + thin is the pull-rug profile; old +
// deep is genuine positive evidence. Every field degrades to null on any miss — unknown, not safe.
const DEXSCREENER_CHAINS: Record<string, string> = {
  "8453": "base", "1": "ethereum", "56": "bsc", "137": "polygon", "42161": "arbitrum", "10": "optimism",
};
async function dexMarket(chainId: string, addr: string): Promise<{ listed: boolean; ageDays: number | null; liquidityUsd: number | null; volume24h: number | null }> {
  const slug = DEXSCREENER_CHAINS[chainId];
  if (!slug) return { listed: false, ageDays: null, liquidityUsd: null, volume24h: null };
  const j = await cached(`ds:${chainId}:${addr}`, () =>
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(addr)}`),
  ).catch(() => null);
  const pairs = Array.isArray(j?.pairs) ? j.pairs.filter((p: any) => p?.chainId === slug) : [];
  if (!pairs.length) return { listed: false, ageDays: null, liquidityUsd: null, volume24h: null };
  let oldestMs = Infinity, maxLiq = 0, vol = 0;
  for (const p of pairs) {
    const created = Number(p.pairCreatedAt); // DexScreener returns epoch MILLISECONDS
    if (Number.isFinite(created) && created > 0) oldestMs = Math.min(oldestMs, created);
    const liq = Number(p.liquidity?.usd);
    if (Number.isFinite(liq) && liq > maxLiq) { maxLiq = liq; vol = Number(p.volume?.h24) || 0; }
  }
  const ageDays = Number.isFinite(oldestMs) ? (Date.now() - oldestMs) / 86400000 : null;
  return { listed: true, ageDays, liquidityUsd: maxLiq || null, volume24h: vol || null };
}

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
// Holder count at/above which a token is treated as "established" — its LP-lock
// status stops being a first-class rug signal (blue chips shouldn't false-flag).
const HOLDER_ESTABLISHED = 5000;

/** Pre-paywall validation: 400 before charging for a doomed call. */
export function validateSafety(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase().trim();
  const isSolana = chain === "solana";
  if (!isSolana && !Object.prototype.hasOwnProperty.call(GOPLUS_CHAINS, chain)) {
    return `unsupported chain "${chain.slice(0, 24)}". supported: ${SAFETY_CHAINS.join(", ")}`;
  }
  // Missing address: let it reach the paywall (a discovery probe with no query
  // params must still see 402, not 400 — the handler 404s gracefully post-pay).
  // PROVIDED-but-malformed address: reject before charging, that's real abuse.
  if (q.address !== undefined) {
    const a = String(q.address);
    if (isSolana ? !SOL_ADDR.test(a) : !EVM_ADDR.test(a))
      return isSolana ? "invalid Solana token mint address" : "invalid EVM token address";
  }
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
  if (chainKey === "solana") return solanaSafetyReport(address); // dual-engine Solana composite
  if (!EVM_ADDR.test(address)) return null; // missing/empty address (e.g. a bare discovery probe) -> clean 404
  const chainId = GOPLUS_CHAINS[chainKey]; // validated upstream
  const addr = address.toLowerCase();

  // Independent sources in parallel: static (GoPlus) + dynamic (Honeypot.is) + curated GitHub lists
  // (3-source known-bad blocklist, reputable allowlist) + DEX market age/liquidity (DexScreener). All
  // keyless; each .catch keeps a single upstream hiccup from ever breaking a paid call.
  const [gp, hp, trusted, badLookup, dex] = await Promise.all([
    cached(`gp:${chainId}:${addr}`, () =>
      getJson(
        `https://api.gopluslabs.io/api/v1/token_security/${encodeURIComponent(chainId)}` +
          `?contract_addresses=${encodeURIComponent(addr)}`,
      ),
    ).catch(() => null),
    honeypotSim(chainId, addr).catch(() => null),
    isReputableToken(chainId, addr).catch(() => false),
    knownBadMap().catch(() => null),
    dexMarket(chainId, addr).catch(() => null),
  ]);

  const t = gp?.result?.[addr];

  // THIRD SOURCE (fresh-token gap): only when GoPlus is blind. A token GoPlus has no record of is
  // exactly the case that inverted the scorer — so reach for Blockscout, which still knows if the
  // contract is verified and how many holders it has.
  const bs = !t ? await blockscout(chainId, addr).catch(() => null) : null;

  // KNOWN-SCAM check: is the token address, or its deployer, a documented scammer? A hit here is a
  // hard danger regardless of everything else, so it must be able to produce a verdict even when no
  // scanner has data on the token (a fresh malicious contract) — hence it counts against the 404 gate.
  const creator = t?.creator_address ? String(t.creator_address).toLowerCase() : null;
  const badOnAddr = badLookup?.get(addr);
  const badOnCreator = creator ? badLookup?.get(creator) : undefined;
  const scam =
    badOnAddr ? { who: "token address", ...badOnAddr }
    : badOnCreator ? { who: "deployer", ...badOnCreator }
    : null;

  // A DexScreener market means the token is tradeable RIGHT NOW even if no scanner has analysed it —
  // the exact fresh-token case that inverted the scorer. Score it (as fresh/unverified) rather than
  // 404, so a brand-new tradeable scam gets a real warning instead of silence.
  if (!t && !hp && !bs && !scam && !dex?.listed) return null; // no source had anything -> 404

  // LP-LOCK: require a MEANINGFUL locked share, not merely "some holder is flagged locked".
  //
  // The old check was `.some(h => String(h.is_locked) === "1")` with no threshold. Every
  // UniswapV2 pool burns 1000 wei of MINIMUM_LIQUIDITY to the null address at creation, and GoPlus
  // reports that burn as a locked LP holder with percent ~6.5e-17. So `.some()` returned true off
  // 0.0000000000000077% of LP supply, for essentially every V2 token in existence.
  //
  // That single boolean suppressed BOTH LP risk checks (weights 25 and 30 below) and raised a green
  // flag -- cancelling 55 risk points while 99.999999999999999% of the LP sat unlocked. It is the
  // main reason this scorer was rank-inverted: on the 881 graded rows in data/track_record.jsonl,
  // tokens we called "ok" rugged 78.3% of the time against a 40.1% base rate, while "danger"
  // rugged only 22.3%. The verdict pointed the wrong way.
  //
  // `percent` is a fraction summing to 1.0 across holders, and the locked share is sharply bimodal
  // in live sampling (near-zero dust vs exactly 1.0, nothing between), so 0.5 separates cleanly.
  const LP_LOCK_MIN_SHARE = 0.5;
  const lpLockedShare =
    t && Array.isArray(t.lp_holders)
      ? t.lp_holders
          .filter((h: any) => String(h?.is_locked) === "1")
          .reduce((sum: number, h: any) => sum + (Number(h?.percent) || 0), 0)
      : null;
  const lpLocked = lpLockedShare === null ? null : lpLockedShare >= LP_LOCK_MIN_SHARE;
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
        // LIQUIDITY-PULL GATE. Our public track record proved the real miss:
        // small/new tokens with a clean contract but LP that isn't provably
        // locked get rugged by pulling liquidity — a vector no contract scan can
        // foresee. So on a low-holder token, un-verified LP is a genuine caution
        // (not "clear"). Blue chips (holders >= HOLDER_ESTABLISHED) are exempt:
        // their LP-lock status matters far less and they shouldn't false-flag.
        ["LP not verified-locked on a small/new token (liquidity-pull rug vector)",
          lpLocked !== true && (Number(t.holder_count) || 0) < HOLDER_ESTABLISHED, 30],
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

  // ── Market signals (DexScreener age + liquidity) — the dimension no contract scan can see ──
  // Age is one of the strongest rug predictors: a pair created hours ago is the fresh-rug window,
  // and it compounds with the unverified/blind penalties below for exactly the fresh scams that
  // inverted the scorer. Thin absolute liquidity is what makes a pull cheap. Kept out of staticRisk
  // (the GoPlus-only figure the agreement factor uses) — this is a separate, independent method.
  const dexAgeDays = dex?.listed ? dex.ageDays : null;
  const dexLiq = dex?.listed ? dex.liquidityUsd : null;
  const marketChecks: Array<[string, boolean, number]> = [
    [`DEX pair created under 24h ago — brand-new, the fresh-rug window`, dexAgeDays != null && dexAgeDays < 1, 30],
    [`DEX pair created under 7 days ago — very young token`, dexAgeDays != null && dexAgeDays >= 1 && dexAgeDays < 7, 15],
    [`DEX liquidity under $5k — thin enough to pull cheaply (liquidity-pull rug vector)`, dexLiq != null && dexLiq < 5000, 20],
  ];

  const allChecks = [...staticChecks, ...dynChecks, ...marketChecks];
  const redFlags = allChecks.filter(([, hit]) => hit).map(([label]) => label);
  const staticRisk = staticChecks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0);
  let risk = Math.min(100, allChecks.reduce((s, [, hit, w]) => s + (hit ? w : 0), 0));

  // ── HARD-ZERO GATES: a dead-certain trap is danger, whatever the point total ──
  const hardTrap = (hp?.is_honeypot === true) || flag(t?.is_honeypot) || flag(t?.cannot_sell_all);
  if (hardTrap) risk = 100;

  // KNOWN-SCAM BLOCKLIST GATE — a documented-scammer address (the token itself, or its deployer) is
  // a hard danger no matter the point score. This is the highest-confidence signal in the scorer:
  // not inference from contract shape, but a human-curated record that this address already stole.
  if (scam) {
    risk = 100;
    redFlags.push(`${scam.who} is on a known-bad list [${scam.src}] — ${scam.reason.slice(0, 150)}`);
  }

  // ── AGREEMENT FACTOR: static vs dynamic disagreement is itself a signal ──
  const haveBoth = Boolean(t && hp);
  const gpSaysClean = Boolean(t) && staticRisk < 25;
  const hpSaysBad = Boolean(hp) && (hp!.is_honeypot || (hp!.sell_tax ?? 0) > 10 || (hp!.risk_level ?? 0) >= 3);
  const gpSaysBad = staticRisk >= 60;
  const hpSaysClean = Boolean(hp) && !hp!.is_honeypot && (hp!.sell_tax ?? 0) <= 10 && (hp!.risk_level ?? 0) <= 1;
  const needsReview = Boolean((gpSaysClean && hpSaysBad) || (gpSaysBad && hpSaysClean));

  // ── Positive signals — a "clear" verdict must be EARNED, not just the absence of red flags ──
  // Computed BEFORE the verdict, because the verdict now depends on whether real positive evidence
  // exists. (This block used to run after the verdict and was purely cosmetic.)
  const greenChecks: Array<[string, boolean]> = [
    ["passed live buy & sell simulation", Boolean(hp) && !hp!.is_honeypot && hp!.sim_success === true],
    ["0% simulated buy & sell tax", Boolean(hp) && (hp!.buy_tax ?? 1) === 0 && (hp!.sell_tax ?? 1) === 0],
    ["source code verified", flag(t?.is_open_source)],
    ["ownership renounced", t ? (String(t.owner_address ?? "") === "" || /^0x0+$/.test(String(t.owner_address ?? ""))) : false],
    ["cannot mint new supply", Boolean(t) && flag(t?.is_mintable) === false],
    ["liquidity locked", lpLocked === true],
    ["10k+ holders", (Number(t?.holder_count) || 0) >= 10000],
    ["on a reputable token list (Uniswap default) — vetted, essentially never a fresh rug", trusted === true],
    ["DEX pair over 180 days old — survived long past the typical rug window", dexAgeDays != null && dexAgeDays > 180],
    ["deep DEX liquidity over $100k — not a single thin pool that can be pulled cheaply", dexLiq != null && dexLiq >= 100000],
  ];
  // Blockscout counts as positive evidence when it can vouch for the contract — a verified contract
  // with a real holder base is a genuine green signal even without GoPlus.
  const bsVerifiedGreen = bs?.verified === true && (bs.holders ?? 0) >= 100;
  if (bsVerifiedGreen) greenChecks.push(["contract verified on Blockscout with a real holder base", true]);
  const greenFlags = greenChecks.filter(([, ok]) => ok).map(([label]) => label);
  const passedSim = Boolean(hp) && hp!.sim_success === true && !hp!.is_honeypot;

  // ── UNVERIFIED IS NOT SAFE (2026-07-27 — the fix for the scorer's inversion) ──
  // The public track record proved this was the single biggest defect: tokens we called "ok" rugged
  // 83% of the time, and they were overwhelmingly tokens GoPlus had NO data on — fresh scams (often
  // stock-ticker impersonations like NFLX/MSFT) that were tradeable on DexScreener but not yet
  // analysed. With no red flags to fire, risk summed to 0 and the token defaulted to "ok". Absence
  // of signal was being scored as safety, which is worse than useless for a rug scanner.
  //
  // When GoPlus is blind we now use Blockscout for REAL signal instead of a blanket penalty:
  if (!t) {
    if (bs?.verified === false) {
      risk = Math.min(100, risk + 45);
      redFlags.push("contract is NOT verified on Blockscout — unverified source is a classic fresh-rug profile");
    }
    if (bs && bs.holders != null && bs.holders < 50) {
      risk = Math.min(100, risk + 25);
      redFlags.push(`only ${bs.holders} holders (Blockscout) — a tiny holder base on an un-analysed token`);
    }
    if (!bsVerifiedGreen) {
      // Even with Blockscout, if it cannot positively vouch for the token, we still cannot call it
      // "ok". Being un-analysable by GoPlus AND unvouched by Blockscout is the fresh-rug profile.
      risk = Math.min(100, risk + 20);
      redFlags.push("GoPlus has no data on this token and Blockscout cannot vouch for it — unverified, not safe");
    }
  }

  let verdict: "ok" | "warning" | "danger" = risk >= 60 ? "danger" : risk >= 25 ? "warning" : "ok";
  // A disagreement must never read as "clear" — floor it to caution.
  if (needsReview && verdict === "ok") verdict = "warning";

  // An "ok" must be EARNED: we need static coverage AND real positive evidence (a passed live
  // sell-simulation, or at least two independent green signals). Absent that, the honest verdict is
  // "warning: unverified", which is what an un-vouched token deserves — never a clean bill.
  if (verdict === "ok" && !(passedSim || greenFlags.length >= 2)) {
    verdict = "warning";
    redFlags.push("clean of red flags, but nothing POSITIVE verifies it either (no passed sell-sim, few green signals) — unproven, not safe");
  }

  const sources = [
    t ? "goplus (static)" : null,
    hp ? "honeypot.is (dynamic sim)" : null,
    bs ? "blockscout (verification + holders)" : null,
    badLookup ? "known-bad address lists (ofac + mew + scamsniffer)" : null,
    trusted ? "reputable token list (uniswap default)" : null,
    dex?.listed ? "dexscreener (pair age + liquidity)" : null,
  ].filter(Boolean) as string[];
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
      on_reputable_list: trusted === true, // Uniswap default token list
      known_scam_flagged: scam ? `${scam.who} [${scam.src}]` : false, // e.g. "deployer [OFAC]" | false
      dex_pair_age_days: dexAgeDays != null ? Math.round(dexAgeDays * 10) / 10 : null, // DexScreener oldest pair
      dex_liquidity_usd: dexLiq, // DexScreener deepest-pool liquidity
    },
    sources,
    // Our own measured accuracy for THIS verdict, attached to the thing the buyer is paying for.
    // Our published calibration currently shows the score inverted: tokens we call "ok" rugged
    // 78.9% of the time across 128 graded calls (101 rugged, 0 merely dumped -- the signature of a
    // liquidity pull, which no contract scan can see), while tokens we call "danger" rugged 0 times
    // in 21. Selling a verdict silently while the evidence says the opposite is exactly the fake
    // this company exists not to ship. Null when we have too little history to say anything.
    historical_accuracy: verdictHonesty(verdict),
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
    desc: "Composite rug score (EVM + Solana): static analysis + LIVE buy/sell simulation (EVM) / dual-engine authority+LP analysis (Solana) + serial-rugger check → ok/warning/danger with a disagreement flag",
  },
];
