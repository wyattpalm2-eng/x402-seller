/**
 * survival.ts — the calibrated survival model. Replaces the hand-weighted rug score.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous scorer was hand-tuned, and our own public ledger showed it was not merely weak but
 * INVERTED. Over 1022 graded Base tokens it scored AUC 0.545 out of sample — a coin flip —
 * and on some folds it landed at 0.42, i.e. worse than guessing. The reason is structural, and it
 * is the single most useful thing this company has measured:
 *
 *   ON BASE, THE STANDARD RUG HEURISTICS ARE BACKWARDS.
 *
 *   "Ownership renounced" tokens rugged 77.5% of the time; NOT-renounced rugged 4.8%.
 *   Tokens carrying 5+ green flags rugged 85%; tokens with <=4 rugged 25-63%.
 *   Every proxy, mintable, vanity-address and prior-honeypot-creator token in the set survived.
 *
 * That is not a paradox. Base launchpads AUTO-RENOUNCE, AUTO-VERIFY and AUTO-LOCK every token they
 * mint. So the full green-flag sweep is not evidence of safety — it is the fingerprint of a
 * disposable launchpad memecoin, and those die at ~100%. The tokens missing green flags are the
 * hand-deployed and established ones. Every vendor that sells "renounced = safe" is selling the
 * inverse of what the outcomes say, at least on this chain.
 *
 * This model learns that from outcomes instead of assuming it.
 *
 * VALIDATION (see /model)
 *   Walk-forward, 6 expanding folds, strictly chronological — the model never sees a row that
 *   happened after the row it scores. Pooled out-of-sample AUC 0.9541 on
 *   n=672, worst individual fold 0.88. Same folds, old scorer: 0.545.
 *
 * HORIZON IS PART OF THE CLAIM
 *   This predicts survival over 6 HOURS. It is not a verdict on whether a token is a good
 *   investment, and it is emphatically not a long-horizon safety rating: we sampled tokens this
 *   ledger graded "fine" at 6h and checked them two weeks later — 12 of 12 were dead, and even in
 *   the deepest-liquidity clean band only 2 of 12 survived. Nearly everything that launches on Base
 *   dies eventually. The answerable question, and the one an execution agent actually needs, is
 *   whether the pool will still be there when it wants out.
 *
 * GENERATED FILE — produced by scripts/gen_survival.py from the exported fit. Do not hand-edit the
 * coefficients; retrain and regenerate.
 */

export const MODEL_VERSION = 'survival-2026-08-11';
export const HORIZON_HOURS = 6;

const KEYS: string[] = ["log_liq", "band_launchpad", "band_micro", "band_mid", "band_deep", "green_flags", "red_flags", "sources", "renounced", "verified", "mintable", "proxy", "creator_prior_hp", "hp_honeypot", "needs_review", "addr_vanity", "addr_zero_run", "buy_tax", "sell_tax", "has_holders", "log_holders", "lp_locked_known", "lp_locked"];
const MU: number[] = [4.019347, 0.460861, 0.12818, 0.170254, 0.199609, 4.706458, 2.399217, 3.67319, 0.918787, 0.82681, 0.008806, 0.034247, 0.005871, 0.007828, 0.12818, 0.013699, 2.311155, 0.097603, 0.285421, 0.082192, 0.205537, 0.174168, 0.021526];
const SD: number[] = [1.048747, 0.498466, 0.33429, 0.375856, 0.399706, 0.849737, 1.070472, 0.785662, 0.273162, 0.378411, 0.093428, 0.181862, 0.076396, 0.088128, 0.33429, 0.116237, 2.086921, 1.889984, 4.755888, 0.274657, 0.832996, 0.379254, 0.145131];
const COEF: number[] = [-0.508306, 0.91139, -1.257355, -0.963535, 0.275975, 0.134181, -0.399728, 0.73346, 0.915705, -0.612978, -0.102572, -0.869349, -0.097811, -0.206647, -0.541389, -0.274088, -0.143615, -0.020821, -0.020941, -0.735837, -0.648283, 0.304184, -0.062543];
const INTERCEPT = 1.646017;

/** Out-of-sample calibration: what actually happened to tokens we scored in each band.
 *  Measured walk-forward, so these are honest hit rates, not in-sample fit. */
export const CALIBRATION: Array<{ lo: number; hi: number; n: number; observedRug: number }> = [
  { lo: 0.0, hi: 0.1, n: 65, observedRug: 0.0308 },
  { lo: 0.1, hi: 0.25, n: 25, observedRug: 0.28 },
  { lo: 0.25, hi: 0.5, n: 70, observedRug: 0.5571 },
  { lo: 0.5, hi: 0.75, n: 43, observedRug: 0.5349 },
  { lo: 0.75, hi: 0.9, n: 25, observedRug: 0.72 },
  { lo: 0.9, hi: 0.98, n: 238, observedRug: 0.9748 },
  { lo: 0.98, hi: 1.01, n: 206, observedRug: 1.0 }
];

/** Phrase for a binary feature, keyed by which state the token is actually in. `off: null` means
 *  the absent state is not worth narrating (nobody needs "is not mintable" as a headline). */
const BINARY_PHRASE: Record<string, { on: string; off: string | null }> = {
  'band_launchpad': { on: "liquidity sits in the $9k-$13k launchpad seed band", off: null },
  'band_micro': { on: "sub-$5k pool, too thin to be worth pulling", off: null },
  'band_mid': { on: "$13k-$50k pool", off: null },
  'band_deep': { on: "$50k+ pool", off: null },
  'renounced': { on: "ownership renounced (a launchpad default on Base, not a safety signal)", off: "ownership NOT renounced \u2014 hand-deployed, which historically survives" },
  'verified': { on: "source verified", off: "source NOT verified" },
  'mintable': { on: "mintable", off: null },
  'proxy': { on: "proxy/upgradeable contract", off: null },
  'creator_prior_hp': { on: "creator previously shipped a honeypot", off: null },
  'hp_honeypot': { on: "live sell-simulation tripped the honeypot check", off: null },
  'needs_review': { on: "sources disagree about this token", off: null },
  'addr_vanity': { on: "vanity-mined or factory-deployed address", off: null },
  'has_holders': { on: "holder count resolvable", off: "holder count could NOT be resolved" },
  'lp_locked_known': { on: "LP lock status resolvable", off: "LP lock status unknown" },
  'lp_locked': { on: "LP locked", off: "LP not locked" }
};

/** Continuous features render with the measured value, so the sentence is about THIS token. */
const NUMERIC_PHRASE: Record<string, { label: string; fmt: string }> = {
  'log_liq': { label: "pool depth", fmt: "pow10" },
  'green_flags': { label: "green flags", fmt: "int" },
  'red_flags': { label: "red flags", fmt: "int" },
  'sources': { label: "data sources carrying this token", fmt: "int" },
  'addr_zero_run': { label: "longest repeated-character run in the address", fmt: "int" },
  'buy_tax': { label: "buy tax", fmt: "pct" },
  'sell_tax': { label: "sell tax", fmt: "pct" },
  'log_holders': { label: "holder count", fmt: "pow10" }
};

export const MODEL_META = {
  version: MODEL_VERSION,
  horizon_hours: HORIZON_HOURS,
  trained_rows: 1022,
  trained_through: 1786391694817,
  train_base_rug_rate: 0.7162,
  validation: {
    method: "walk-forward, 6 expanding chronological folds, no shuffling",
    pooled_n: 672,
    pooled_auc: 0.9541,
    worst_fold_auc: 0.88,
    previous_scorer_auc: 0.545,
  },
};

export type SurvivalInput = {
  liq_usd: number | null;
  green_flags: number;
  red_flags: number;
  sources: number;
  renounced: boolean | null;
  verified: boolean | null;
  mintable: boolean | null;
  proxy: boolean | null;
  creator_prior_honeypot: boolean | null;
  hp_honeypot: boolean | null;
  needs_review: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  holders: number | null;
  lp_locked: boolean | null;
  address: string;
};

export type SurvivalRead = {
  horizon_hours: number;
  p_rug: number;
  p_survive: number;
  cohort: "doomed" | "fragile" | "uncertain" | "resilient";
  cohort_note: string;
  observed_at_this_confidence: { n: number; rugged_pct: number; survived_pct: number } | null;
  drivers: string[];
  model: typeof MODEL_META;
};

/** Longest run of repeated hex characters in the address body. Normally-deployed contracts run 3-4
 *  by chance; vanity-mined and factory addresses run far longer. */
export function addressFingerprint(address: string): { addr_zero_run: number; addr_vanity: boolean } {
  const body = String(address || "").replace(/^0x/, "").toLowerCase();
  let best = 0, cur = 1;
  for (let i = 1; i < body.length; i++) {
    if (body[i] === body[i - 1]) { cur++; if (cur > best) best = cur; } else cur = 1;
  }
  if (best === 0) best = 1;
  return { addr_zero_run: best, addr_vanity: best >= 8 };
}

function featureMap(i: SurvivalInput): Record<string, number> {
  const liq = Number(i.liq_usd ?? 0) || 0;
  const fp = addressFingerprint(i.address);
  const holders = i.holders;
  return {
    log_liq: Math.log10(liq + 1),
    band_launchpad: liq >= 9000 && liq < 13000 ? 1 : 0,
    band_micro: liq < 5000 ? 1 : 0,
    band_mid: liq >= 13000 && liq < 50000 ? 1 : 0,
    band_deep: liq >= 50000 ? 1 : 0,
    green_flags: Number(i.green_flags) || 0,
    red_flags: Number(i.red_flags) || 0,
    sources: Number(i.sources) || 0,
    renounced: i.renounced ? 1 : 0,
    verified: i.verified ? 1 : 0,
    mintable: i.mintable ? 1 : 0,
    proxy: i.proxy ? 1 : 0,
    creator_prior_hp: i.creator_prior_honeypot ? 1 : 0,
    hp_honeypot: i.hp_honeypot ? 1 : 0,
    needs_review: i.needs_review ? 1 : 0,
    addr_vanity: fp.addr_vanity ? 1 : 0,
    addr_zero_run: fp.addr_zero_run,
    buy_tax: Math.min(Number(i.buy_tax ?? 0) || 0, 100),
    sell_tax: Math.min(Number(i.sell_tax ?? 0) || 0, 100),
    has_holders: holders != null ? 1 : 0,
    log_holders: holders != null ? Math.log10(Number(holders) + 1) : 0,
    lp_locked_known: i.lp_locked != null ? 1 : 0,
    lp_locked: i.lp_locked ? 1 : 0,
  };
}

/** Turn a feature and the value THIS token actually has into a phrase, or null when the state is
 *  not worth saying out loud. Never describes a state the token is not in. */
function describe(key: string, value: number): string | null {
  const b = BINARY_PHRASE[key];
  if (b) return value >= 0.5 ? b.on : b.off;
  const n = NUMERIC_PHRASE[key];
  if (!n) return null;
  let shown: string;
  if (n.fmt === "pow10") {
    const v = Math.pow(10, value) - 1;
    shown = v >= 1000 ? `$${Math.round(v / 1000)}k` : String(Math.round(v));
    if (key === "log_holders") shown = v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v));
  } else if (n.fmt === "pct") {
    if (value === 0) return null; // a 0% tax is not a driver anyone needs narrated
    shown = `${Math.round(value * 10) / 10}%`;
  } else {
    shown = String(Math.round(value));
  }
  return `${n.label} ${shown}`;
}

function calibrationFor(p: number) {
  const row = CALIBRATION.find((c) => p >= c.lo && p < c.hi);
  if (!row) return null;
  return {
    n: row.n,
    rugged_pct: Math.round(row.observedRug * 1000) / 10,
    survived_pct: Math.round((1 - row.observedRug) * 1000) / 10,
  };
}

export function survival(input: SurvivalInput): SurvivalRead {
  const f = featureMap(input);
  let z = INTERCEPT;
  const contrib: Array<{ key: string; v: number }> = [];
  for (let k = 0; k < KEYS.length; k++) {
    const raw = f[KEYS[k]] ?? 0;
    const std = (raw - MU[k]) / (SD[k] || 1);
    const c = std * COEF[k];
    z += c;
    contrib.push({ key: KEYS[k], v: c });
  }
  const pRug = 1 / (1 + Math.exp(-z));
  const cohort: SurvivalRead["cohort"] =
    pRug >= 0.9 ? "doomed" : pRug >= 0.5 ? "fragile" : pRug >= 0.25 ? "uncertain" : "resilient";
  const note =
    cohort === "doomed"
      ? `pool is expected to be effectively gone within ${HORIZON_HOURS}h — do not size a position you need to exit`
      : cohort === "fragile"
      ? "more likely than not to lose its pool inside the window"
      : cohort === "uncertain"
      ? "genuinely uncertain — the features do not separate this one"
      : `expected to still be tradeable in ${HORIZON_HOURS}h`;

  contrib.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const drivers: string[] = [];
  for (const c of contrib) {
    if (drivers.length >= 4) break;
    const phrase = describe(c.key, f[c.key] ?? 0);
    if (!phrase) continue; // this state is not worth narrating
    drivers.push(`${phrase} — ${c.v > 0 ? "raises" : "lowers"} rug risk`);
  }

  return {
    horizon_hours: HORIZON_HOURS,
    p_rug: Math.round(pRug * 10000) / 10000,
    p_survive: Math.round((1 - pRug) * 10000) / 10000,
    cohort,
    cohort_note: note,
    observed_at_this_confidence: calibrationFor(pRug),
    drivers,
    model: MODEL_META,
  };
}
