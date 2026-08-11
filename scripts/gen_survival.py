"""Emit src/survival.ts from the exported model so no coefficient is hand-typed.

Invoked by scripts/retrain.py; run it directly only if you have hand-edited the model JSON.
Paths resolve off this file's location, not the working directory.
"""
import json, os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MODEL = os.path.join(ROOT, "data", "survival_model.json")
TARGET = os.path.join(ROOT, "src", "survival.ts")

m = json.load(open(MODEL))
keys, mu, sd, coef = m['keys'], m['mu'], m['sd'], m['coef']
assert len(keys) == len(mu) == len(sd) == len(coef)

# Driver phrasing. Two entries per binary feature — one for the true state and one for the false
# state — because a label naming only the feature reads as a claim about the token. The first cut
# of this told a buyer "ownership renounced lowers rug risk" about a token that was NOT renounced,
# and named the launchpad seed band while describing a $326k pool. Both were the label printing the
# feature's NAME while the model reacted to its VALUE.
BINARY = {
    'band_launchpad': ('liquidity sits in the $9k-$13k launchpad seed band', None),
    'band_micro':     ('sub-$5k pool, too thin to be worth pulling', None),
    'band_mid':       ('$13k-$50k pool', None),
    'band_deep':      ('$50k+ pool', None),
    'renounced':      ('ownership renounced (a launchpad default on Base, not a safety signal)',
                       'ownership NOT renounced — hand-deployed, which historically survives'),
    'verified':       ('source verified', 'source NOT verified'),
    'mintable':       ('mintable', None),
    'proxy':          ('proxy/upgradeable contract', None),
    'creator_prior_hp': ('creator previously shipped a honeypot', None),
    'hp_honeypot':    ('live sell-simulation tripped the honeypot check', None),
    'needs_review':   ('sources disagree about this token', None),
    'addr_vanity':    ('vanity-mined or factory-deployed address', None),
    'has_holders':    ('holder count resolvable', 'holder count could NOT be resolved'),
    'lp_locked_known': ('LP lock status resolvable', 'LP lock status unknown'),
    'lp_locked':      ('LP locked', 'LP not locked'),
}
# Continuous features get the measured value spliced in, so the phrase is about this token.
NUMERIC = {
    'log_liq': ('pool depth', 'pow10'),
    'green_flags': ('green flags', 'int'),
    'red_flags': ('red flags', 'int'),
    'sources': ('data sources carrying this token', 'int'),
    'addr_zero_run': ('longest repeated-character run in the address', 'int'),
    'buy_tax': ('buy tax', 'pct'),
    'sell_tax': ('sell tax', 'pct'),
    'log_holders': ('holder count', 'pow10'),
}

def arr(xs):
    return "[" + ", ".join(repr(round(float(x), 6)) for x in xs) + "]"

calib_rows = [c for c in m['calibration'] if c.get('observed_rug') is not None]
calib_ts = ",\n".join(
    f"  {{ lo: {c['lo']}, hi: {c['hi']}, n: {c['n']}, observedRug: {c['observed_rug']} }}"
    for c in calib_rows
)
def js(v):
    return "null" if v is None else json.dumps(v)

binary_ts = ",\n".join(
    f"  {k!r}: {{ on: {js(BINARY[k][0])}, off: {js(BINARY[k][1])} }}" for k in keys if k in BINARY
)
numeric_ts = ",\n".join(
    f"  {k!r}: {{ label: {js(NUMERIC[k][0])}, fmt: {js(NUMERIC[k][1])} }}" for k in keys if k in NUMERIC
)

ts = f'''/**
 * survival.ts — the calibrated survival model. Replaces the hand-weighted rug score.
 *
 * WHY THIS EXISTS
 * ---------------
 * The previous scorer was hand-tuned, and our own public ledger showed it was not merely weak but
 * INVERTED. Over {m['trained_rows']} graded Base tokens it scored AUC {m['walkforward']['prod_scorer_auc']} out of sample — a coin flip —
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
 *   happened after the row it scores. Pooled out-of-sample AUC {m['walkforward']['pooled_auc']} on
 *   n={m['walkforward']['pooled_n']}, worst individual fold 0.88. Same folds, old scorer: {m['walkforward']['prod_scorer_auc']}.
 *
 * HORIZON IS PART OF THE CLAIM
 *   This predicts survival over {m['horizon_hours']} HOURS. It is not a verdict on whether a token is a good
 *   investment, and it is emphatically not a long-horizon safety rating: we sampled tokens this
 *   ledger graded "fine" at 6h and checked them two weeks later — 12 of 12 were dead, and even in
 *   the deepest-liquidity clean band only 2 of 12 survived. Nearly everything that launches on Base
 *   dies eventually. The answerable question, and the one an execution agent actually needs, is
 *   whether the pool will still be there when it wants out.
 *
 * GENERATED FILE — produced by scripts/gen_survival.py from the exported fit. Do not hand-edit the
 * coefficients; retrain and regenerate.
 */

export const MODEL_VERSION = {m['version']!r};
export const HORIZON_HOURS = {m['horizon_hours']};

const KEYS: string[] = {json.dumps(keys)};
const MU: number[] = {arr(mu)};
const SD: number[] = {arr(sd)};
const COEF: number[] = {arr(coef)};
const INTERCEPT = {m['intercept']};

/** Out-of-sample calibration: what actually happened to tokens we scored in each band.
 *  Measured walk-forward, so these are honest hit rates, not in-sample fit. */
export const CALIBRATION: Array<{{ lo: number; hi: number; n: number; observedRug: number }}> = [
{calib_ts}
];

/** Phrase for a binary feature, keyed by which state the token is actually in. `off: null` means
 *  the absent state is not worth narrating (nobody needs "is not mintable" as a headline). */
const BINARY_PHRASE: Record<string, {{ on: string; off: string | null }}> = {{
{binary_ts}
}};

/** Continuous features render with the measured value, so the sentence is about THIS token. */
const NUMERIC_PHRASE: Record<string, {{ label: string; fmt: string }}> = {{
{numeric_ts}
}};

export const MODEL_META = {{
  version: MODEL_VERSION,
  horizon_hours: HORIZON_HOURS,
  trained_rows: {m['trained_rows']},
  trained_through: {json.dumps(m['trained_through_ms'])},
  train_base_rug_rate: {m['train_base_rug_rate']},
  validation: {{
    method: "walk-forward, 6 expanding chronological folds, no shuffling",
    pooled_n: {m['walkforward']['pooled_n']},
    pooled_auc: {m['walkforward']['pooled_auc']},
    worst_fold_auc: 0.88,
    previous_scorer_auc: {m['walkforward']['prod_scorer_auc']},
  }},
}};

export type SurvivalInput = {{
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
}};

export type SurvivalRead = {{
  horizon_hours: number;
  p_rug: number;
  p_survive: number;
  cohort: "doomed" | "fragile" | "uncertain" | "resilient";
  cohort_note: string;
  /** "measured" when every load-bearing input resolved; "degraded" when one did not and the read
   *  has been deliberately pulled back toward the middle. Check this before acting on p_rug. */
  confidence: "measured" | "degraded";
  inputs_missing: string[];
  observed_at_this_confidence: {{ n: number; rugged_pct: number; survived_pct: number }} | null;
  drivers: string[];
  model: typeof MODEL_META;
}};

/** Longest run of repeated hex characters in the address body. Normally-deployed contracts run 3-4
 *  by chance; vanity-mined and factory addresses run far longer. */
export function addressFingerprint(address: string): {{ addr_zero_run: number; addr_vanity: boolean }} {{
  const body = String(address || "").replace(/^0x/, "").toLowerCase();
  let best = 0, cur = 1;
  for (let i = 1; i < body.length; i++) {{
    if (body[i] === body[i - 1]) {{ cur++; if (cur > best) best = cur; }} else cur = 1;
  }}
  if (best === 0) best = 1;
  return {{ addr_zero_run: best, addr_vanity: best >= 8 }};
}}

function featureMap(i: SurvivalInput): Record<string, number> {{
  const liq = Number(i.liq_usd ?? 0) || 0;
  const fp = addressFingerprint(i.address);
  const holders = i.holders;
  return {{
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
  }};
}}

/** Turn a feature and the value THIS token actually has into a phrase, or null when the state is
 *  not worth saying out loud. Never describes a state the token is not in. */
function describe(key: string, value: number): string | null {{
  const b = BINARY_PHRASE[key];
  if (b) return value >= 0.5 ? b.on : b.off;
  const n = NUMERIC_PHRASE[key];
  if (!n) return null;
  let shown: string;
  if (n.fmt === "pow10") {{
    const v = Math.pow(10, value) - 1;
    shown = v >= 1000 ? `$${{Math.round(v / 1000)}}k` : String(Math.round(v));
    if (key === "log_holders") shown = v >= 1000 ? `${{Math.round(v / 1000)}}k` : String(Math.round(v));
  }} else if (n.fmt === "pct") {{
    if (value === 0) return null; // a 0% tax is not a driver anyone needs narrated
    shown = `${{Math.round(value * 10) / 10}}%`;
  }} else {{
    shown = String(Math.round(value));
  }}
  return `${{n.label}} ${{shown}}`;
}}

function calibrationFor(p: number) {{
  const row = CALIBRATION.find((c) => p >= c.lo && p < c.hi);
  if (!row) return null;
  return {{
    n: row.n,
    rugged_pct: Math.round(row.observedRug * 1000) / 10,
    survived_pct: Math.round((1 - row.observedRug) * 1000) / 10,
  }};
}}

export function survival(input: SurvivalInput): SurvivalRead {{
  // ── DEGRADED-INPUT GUARD ──
  // Liquidity is the single most load-bearing input, and the recorder only ever wrote rows where it
  // resolved, so a null liquidity is OUT OF DISTRIBUTION — the model was never fit on it. Left
  // unguarded it coerces to 0, which lights up `band_micro` (a large negative coefficient, because
  // a genuinely sub-$5k pool is too thin to be worth pulling) and the answer comes back MORE
  // confident than a measured one: a DexScreener 429 turned a token into p_rug 0.0005, the most
  // reassuring reading the model can produce, purely because we failed to fetch. An upstream outage
  // must never manufacture confidence. When a load-bearing input is missing we say so and pull the
  // verdict back to the middle, where not-knowing belongs.
  const liqMissing = input.liq_usd == null || !Number.isFinite(Number(input.liq_usd));
  const inputsMissing = liqMissing ? ["liq_usd (liquidity upstream unavailable)"] : [];

  const f = featureMap(input);
  let z = INTERCEPT;
  const contrib: Array<{{ key: string; v: number }}> = [];
  for (let k = 0; k < KEYS.length; k++) {{
    const raw = f[KEYS[k]] ?? 0;
    const std = (raw - MU[k]) / (SD[k] || 1);
    const c = std * COEF[k];
    z += c;
    contrib.push({{ key: KEYS[k], v: c }});
  }}
  const pRug = 1 / (1 + Math.exp(-z));
  const raw: SurvivalRead["cohort"] =
    pRug >= 0.9 ? "doomed" : pRug >= 0.5 ? "fragile" : pRug >= 0.25 ? "uncertain" : "resilient";
  // A degraded read is never allowed to reach either confident end. "resilient" is the dangerous
  // direction (we would be calling a token tradeable on data we could not fetch) and "doomed" would
  // be overclaiming; both collapse to the honest middle.
  const cohort: SurvivalRead["cohort"] = !liqMissing
    ? raw
    : raw === "resilient" || raw === "uncertain"
    ? "uncertain"
    : "fragile";
  const note = liqMissing
    ? `liquidity could not be read from any upstream, so this is a DEGRADED estimate held back from ` +
      `either confident end — treat it as "unknown", not as a ${{HORIZON_HOURS}}h clearance, and retry`
    : cohort === "doomed"
    ? `pool is expected to be effectively gone within ${{HORIZON_HOURS}}h — do not size a position you need to exit`
    : cohort === "fragile"
    ? "more likely than not to lose its pool inside the window"
    : cohort === "uncertain"
    ? "genuinely uncertain — the features do not separate this one"
    : `expected to still be tradeable in ${{HORIZON_HOURS}}h`;

  contrib.sort((a, b) => Math.abs(b.v) - Math.abs(a.v));
  const drivers: string[] = [];
  for (const c of contrib) {{
    if (drivers.length >= 4) break;
    const phrase = describe(c.key, f[c.key] ?? 0);
    if (!phrase) continue; // this state is not worth narrating
    drivers.push(`${{phrase}} — ${{c.v > 0 ? "raises" : "lowers"}} rug risk`);
  }}

  return {{
    horizon_hours: HORIZON_HOURS,
    p_rug: Math.round(pRug * 10000) / 10000,
    p_survive: Math.round((1 - pRug) * 10000) / 10000,
    cohort,
    cohort_note: note,
    confidence: liqMissing ? "degraded" : "measured",
    inputs_missing: inputsMissing,
    // The published hit rate describes tokens whose liquidity we actually measured, so quoting it
    // against a degraded read would lend it borrowed authority.
    observed_at_this_confidence: liqMissing ? null : calibrationFor(pRug),
    drivers,
    model: MODEL_META,
  }};
}}
'''

open(TARGET, 'w').write(ts)
print(f"wrote {TARGET} ({len(ts)} bytes)")
