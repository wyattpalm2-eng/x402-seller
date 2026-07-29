/**
 * CALIBRATION — what our score has actually been worth, measured against reality.
 *
 * Every rug scanner claims high accuracy and none of them publish their misses, because publishing
 * misses requires having graded yourself in public for months. We have: 1,164 predictions graded
 * against real outcomes 6+ hours later, and counting.
 *
 * Two things fall out of that dataset, and both are products nobody else can build today:
 *
 *  1. CALIBRATION. "When we say 30, tokens rug 44% of the time." A buyer-agent does not want a
 *     score, it wants a probability it can put in an expected-value calculation. A score is only
 *     meaningful if somebody has measured what it means, and measuring it takes elapsed time.
 *
 *  2. SIGNAL LIFT. Which individual inputs actually separate rugs from survivors, computed from our
 *     own outcomes rather than from someone's intuition. This is the thing that will fix the
 *     scorer: on genuinely clean tokens it is currently right 25 times in 197, because the weights
 *     in safety.ts were hand-tuned and never checked against the ledger sitting next to them.
 *
 * Honesty rules this file follows, because the whole value here is being checkable:
 *  - A band with too few samples reports its count and refuses to state a rate.
 *  - Lift is only reported where BOTH sides of the split have enough samples.
 *  - Rows recorded before feature logging existed are counted as "no feature data", never as false.
 */

type Row = any;

const MIN_BAND = 15;   // below this a percentage is noise dressed as a number

// One definition of the score bands, shared by the calibration table and the per-call
// empiricalRisk() lookup. Two copies would drift, and then the rate we quote on a paid call would
// silently stop matching the table we publish to justify it.
const BANDS: Array<{ label: string; lo: number; hi: number }> = [
  { label: "0-24 (we said: ok)", lo: 0, hi: 24 },
  { label: "25-39 (we said: warning)", lo: 25, hi: 39 },
  { label: "40-59 (we said: warning)", lo: 40, hi: 59 },
  { label: "60-79 (we said: danger)", lo: 60, hi: 79 },
  { label: "80-100 (we said: danger)", lo: 80, hi: 100 },
];
const MIN_SPLIT = 12;  // per side of a signal split

/**
 * SCORING-MODEL ERAS. Calibration must be segmented by these or it measures a scorer that no
 * longer exists -- and that is not a hypothetical: pooling the whole ledger reported our "ok"
 * verdict as 78.9% rugged, which was true of the model we replaced on 2026-07-25, not the one
 * running now. A published accuracy number that silently averages over a bug fix is worse than
 * no number, because it is wrong in the direction that makes us look bad and never recovers.
 *
 * Add an entry here whenever the scoring logic changes materially. The newest era is the headline;
 * older eras stay visible, because "we were wrong and here is when we fixed it" is the whole
 * argument for trusting us.
 */
const ERAS: Array<{ from: string; label: string; why: string }> = [
  {
    from: "2026-07-25T05:37:33.000Z",
    label: "current (since the LP-lock fix)",
    why: "GoPlus reports the 1000-wei MINIMUM_LIQUIDITY burn every UniswapV2 pool makes at creation as a 'locked' LP holder, so a `.some(is_locked)` check returned true for essentially every V2 token alive -- cancelling 55 risk points and raising a green flag while ~all of the LP sat unlocked. Now requires a majority of LP supply to be genuinely locked.",
  },
  { from: "1970-01-01T00:00:00.000Z", label: "original scorer (retired)", why: "Superseded by the LP-lock fix above." },
];

function eraOf(t: number): string {
  for (const e of ERAS) if (t >= Date.parse(e.from)) return e.label;
  return ERAS[ERAS.length - 1].label;
}

function pctOf(n: number, d: number): number | null {
  return d > 0 ? Number(((100 * n) / d).toFixed(1)) : null;
}

/** Score bands, and what actually happened in each — for ONE era. */
function calibrateEra(graded: Row[]) {
  const bands = BANDS;
  const table = bands.map((b) => {
    const inBand = graded.filter((r) => r.risk_score >= b.lo && r.risk_score <= b.hi);
    const rugged = inBand.filter((r) => r.outcome === "rugged").length;
    const dumped = inBand.filter((r) => r.outcome === "dumped").length;
    return {
      score_band: b.label,
      calls: inBand.length,
      rugged,
      dumped,
      survived: inBand.length - rugged - dumped,
      observed_rug_rate_pct: inBand.length >= MIN_BAND ? pctOf(rugged, inBand.length) : null,
      note: inBand.length >= MIN_BAND ? undefined : `only ${inBand.length} graded calls in this band — too few to state a rate honestly`,
    };
  });

  const rugs = graded.filter((r) => r.outcome === "rugged").length;
  const base = pctOf(rugs, graded.length);

  // Verdict level, because that is the word a buyer actually reads. A band table is for us; "when
  // you told me ok, how often did I lose everything?" is for them.
  const byVerdict: Record<string, any> = {};
  for (const v of ["ok", "warning", "danger"]) {
    const inV = graded.filter((r) => r.verdict === v);
    if (!inV.length) continue;
    const rg = inV.filter((r) => r.outcome === "rugged").length;
    byVerdict[v] = {
      calls: inV.length,
      rugged: rg,
      rug_rate_pct: inV.length >= MIN_BAND ? pctOf(rg, inV.length) : null,
      note: inV.length >= MIN_BAND ? undefined : `only ${inV.length} graded calls — too few to state a rate honestly`,
    };
  }

  return {
    graded_calls: graded.length,
    base_rate_pct: base,
    base_rate_note: `Read everything below against this: ${base}% of ALL tokens we scored went on to rug. A verdict that rugs at roughly the base rate is telling you nothing, however alarming its label.`,
    by_verdict: byVerdict,
    bands: table,
    honest_reading: honestReading(table, base),
  };
}

/**
 * EMPIRICAL RISK — what actually happened to the tokens we scored like this one.
 *
 * This is the answer to the only question a buyer has ("should I touch this?"), and it is the one
 * thing here that a competitor cannot assemble on demand at any price: it is computed from months
 * of our own graded outcomes, and grading costs elapsed time.
 *
 * It also does something our verdict currently cannot. The verdict is produced by hand-tuned
 * weights and those weights are, as of 2026-07-27, measurably inverted. This number is not derived
 * from the weights at all — it reports the observed rug rate among past calls in the same score
 * band, so it stays TRUE whichever way the polarity happens to point. A buyer can act on it today.
 *
 * Honesty rules baked in, because a rate quoted off three samples is worse than no rate:
 *  - a band with fewer than MIN_BAND graded calls returns null and says why, never a made-up number
 *  - lift is stated against the base rate, so "40%" cannot masquerade as a finding when the base
 *    rate is also 40%
 *  - only the CURRENT era counts; pooling retired scorers would average over our own bug fixes
 */
export function empiricalRisk(rows: Row[], score: number | null | undefined) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  const current = ERAS[0]?.label;
  const graded = rows.filter((r) => r.graded && r.outcome && (!current || eraOf(r.t) === current));
  if (!graded.length) return null;

  const band = BANDS.find((b) => score >= b.lo && score <= b.hi);
  if (!band) return null;
  const inBand = graded.filter((r) => typeof r.risk_score === "number" && r.risk_score >= band.lo && r.risk_score <= band.hi);
  const rugged = inBand.filter((r) => r.outcome === "rugged").length;
  const base = pctOf(graded.filter((r) => r.outcome === "rugged").length, graded.length);

  if (inBand.length < MIN_BAND) {
    return {
      score_band: band.label,
      graded_in_band: inBand.length,
      rug_rate_pct: null,
      base_rate_pct: base,
      note: `only ${inBand.length} graded calls in this band — too few to state a rate honestly, so we state none`,
    };
  }
  const rate = pctOf(rugged, inBand.length);
  const lift = rate != null && base != null && base > 0 ? Math.round((rate / base) * 100) / 100 : null;
  return {
    score_band: band.label,
    graded_in_band: inBand.length,
    rug_rate_pct: rate,
    base_rate_pct: base,
    lift_vs_base: lift,
    what_this_means:
      lift == null || rate == null || base == null ? "no base rate available yet"
      : rate > base ? `tokens in this band rugged ${lift}x as often as the average token we scored`
      : rate < base ? `tokens in this band rugged LESS often than average (${lift}x) — treat a scary label here with suspicion`
      : "this band rugged at exactly the base rate, i.e. the score told you nothing here",
    measured_over: `${graded.length} graded calls from the scorer version serving you now`,
    caveat:
      "Observed history, not a promise. It is what happened to past tokens in this score band, " +
      "measured 6+ hours after each call — not a claim about this specific token's future.",
  };
}

/**
 * Calibration, segmented by scoring-model era. The current era is the headline; retired ones stay
 * published because "we were wrong, here is when we noticed, here is what changed" is the entire
 * argument for trusting a vendor whose claims you cannot otherwise verify.
 */
export function calibration(rows: Row[]) {
  const graded = rows.filter((r) => r.graded && r.outcome);
  const eras = ERAS.map((e) => {
    const mine = graded.filter((r) => eraOf(r.t) === e.label);
    return { era: e.label, what_changed: e.why, ...calibrateEra(mine) };
  }).filter((e) => e.graded_calls > 0);

  return {
    what_this_is:
      "What our risk score has actually been worth, measured against outcomes we graded in public 6+ hours after each call. A score means nothing until somebody measures what it means, and measuring it takes months of elapsed time -- which is why nobody else publishes this.",
    read_this_first:
      "Segmented by scoring-model version. Pooling them would average over our own bug fixes and report a scorer that no longer runs. The FIRST entry is the model serving you right now; the rest are history we keep visible on purpose.",
    eras,
    total_graded_calls: graded.length,
  };
}

function honestReading(table: any[], base: number | null): string {
  if (base === null) return "Not enough graded calls yet to say anything.";
  const usable = table.filter((b) => b.observed_rug_rate_pct !== null);
  if (!usable.length) return "No band has enough graded calls to state a rate yet.";
  const top = usable[usable.length - 1];
  const bottom = usable[0];
  const spread = top.observed_rug_rate_pct - bottom.observed_rug_rate_pct;

  // An INVERTED score is not "weak separation" and must never be reported as such. The first
  // version of this function lumped them together, and on the very first run against real data it
  // called a -78.9 point inversion "weak separation" -- burying the single most important fact this
  // dataset has ever produced under a mild word. Separation and direction are different questions.
  if (spread <= -15) {
    return (
      `INVERTED. Our lowest-risk band rugs at ${bottom.observed_rug_rate_pct}% and our highest-risk band at ${top.observed_rug_rate_pct}%, against a ${base}% base rate. ` +
      `The score is strongly predictive and pointing the wrong way, so as a "should I buy this" signal it is currently worse than a coin flip. ` +
      `We publish this rather than hide it, and there are two candidate explanations we have not yet separated: ` +
      `(a) the weights are simply backwards, or ` +
      `(b) our GRADER is blind to the harm the score detects -- a honeypot traps buyers without ever draining liquidity, and "rugged" here is defined as liquidity or price collapsing, so a perfectly-identified honeypot scores as "fine". ` +
      `If (b) is the real story then the score is fine and the grading formula is incomplete. Until we can tell which, treat the number as unproven and read the red_flags directly.`
    );
  }
  if (spread < 15) {
    return `Our highest band rugs at ${top.observed_rug_rate_pct}% and our lowest at ${bottom.observed_rug_rate_pct}% — a spread of ${spread.toFixed(1)} points against a ${base}% base rate. That is weak separation, and we would rather say so here than let you find out with money on the line.`;
  }
  return `Our highest band rugs at ${top.observed_rug_rate_pct}% against a ${base}% base rate, and our lowest at ${bottom.observed_rug_rate_pct}%. The score separates, and this table is how you price that.`;
}

/**
 * SIGNAL LIFT — for each recorded input, the rug rate when it is present vs absent.
 * Lift is the difference. A signal with no lift is decoration, however sensible it sounds.
 */
export function signalLift(rows: Row[]) {
  const graded = rows.filter((r) => r.graded && r.outcome && r.feat);
  const rugRate = (rs: Row[]) => pctOf(rs.filter((r) => r.outcome === "rugged").length, rs.length);

  const boolSignals: Array<[string, (f: any) => boolean | null]> = [
    ["lp_not_locked", (f) => (f.lp_locked === null ? null : f.lp_locked === false)],
    ["source_unverified", (f) => (f.verified === null ? null : f.verified === false)],
    ["mintable", (f) => (f.mintable === null ? null : f.mintable === true)],
    ["proxy_contract", (f) => (f.proxy === null ? null : f.proxy === true)],
    ["ownership_not_renounced", (f) => (f.renounced === null ? null : f.renounced === false)],
    ["creator_prior_honeypot", (f) => (f.creator_prior_honeypot === null ? null : f.creator_prior_honeypot === true)],
    ["sources_disagreed", (f) => (f.needs_review === null ? null : f.needs_review === true)],
    ["vanity_or_factory_address", (f) => f.addr_vanity === true],
  ];

  const out: any[] = [];
  for (const [name, get] of boolSignals) {
    const known = graded.filter((r) => get(r.feat) !== null);
    const yes = known.filter((r) => get(r.feat) === true);
    const no = known.filter((r) => get(r.feat) === false);
    if (yes.length < MIN_SPLIT || no.length < MIN_SPLIT) {
      out.push({ signal: name, verdict: "not enough data", present: yes.length, absent: no.length });
      continue;
    }
    const a = rugRate(yes)!, b = rugRate(no)!;
    out.push({
      signal: name,
      rug_rate_when_present_pct: a,
      rug_rate_when_absent_pct: b,
      lift_points: Number((a - b).toFixed(1)),
      present: yes.length,
      absent: no.length,
      verdict: Math.abs(a - b) < 5 ? "no measurable effect — this signal is decoration" : a > b ? "predictive" : "INVERTED: this signal points the wrong way",
    });
  }

  // Continuous signals get a median split rather than an invented threshold.
  for (const [name, pick] of [["liquidity_usd_at_call", (f: any) => f.liq_usd], ["holder_count", (f: any) => f.holders]] as const) {
    const known = graded.filter((r) => typeof pick(r.feat) === "number" && pick(r.feat) !== null);
    if (known.length < MIN_SPLIT * 2) { out.push({ signal: name, verdict: "not enough data", samples: known.length }); continue; }
    const sorted = known.map((r) => pick(r.feat) as number).sort((x, y) => x - y);
    const med = sorted[Math.floor(sorted.length / 2)];
    const low = known.filter((r) => (pick(r.feat) as number) <= med);
    const high = known.filter((r) => (pick(r.feat) as number) > med);
    if (low.length < MIN_SPLIT || high.length < MIN_SPLIT) { out.push({ signal: name, verdict: "not enough data", samples: known.length }); continue; }
    const a = rugRate(low)!, b = rugRate(high)!;
    out.push({
      signal: name,
      split_at_median: med,
      rug_rate_below_or_equal_pct: a,
      rug_rate_above_pct: b,
      lift_points: Number((a - b).toFixed(1)),
      samples: known.length,
      verdict: Math.abs(a - b) < 5 ? "no measurable effect" : "predictive",
    });

    // A median split can only see a monotonic effect. Ours is not monotonic:
    // liquidity's danger is concentrated in a MIDDLE band, which straddles the
    // median and therefore cancels itself across both halves — the split above
    // reports "no measurable effect" while the strongest separation in the whole
    // ledger sits inside it. So band it into terciles as well, and say so loudly
    // when the middle is the outlier.
    const t1 = sorted[Math.floor(sorted.length / 3)];
    const t2 = sorted[Math.floor((2 * sorted.length) / 3)];
    const lowB = known.filter((r) => (pick(r.feat) as number) <= t1);
    const midB = known.filter((r) => (pick(r.feat) as number) > t1 && (pick(r.feat) as number) <= t2);
    const highB = known.filter((r) => (pick(r.feat) as number) > t2);
    if (lowB.length >= MIN_BAND && midB.length >= MIN_BAND && highB.length >= MIN_BAND) {
      const lo = rugRate(lowB)!, mi = rugRate(midB)!, hi = rugRate(highB)!;
      const midIsOutlier = (mi > lo + 5 && mi > hi + 5) || (mi < lo - 5 && mi < hi - 5);
      out.push({
        signal: `${name}__banded`,
        band_cuts: [t1, t2],
        rug_rate_low_pct: lo,
        rug_rate_mid_pct: mi,
        rug_rate_high_pct: hi,
        samples: [lowB.length, midB.length, highB.length],
        spread_points: Number((Math.max(lo, mi, hi) - Math.min(lo, mi, hi)).toFixed(1)),
        verdict: midIsOutlier
          ? "NON-MONOTONIC — the middle band is the outlier, so the median split above is blind to this and understates the signal. Read this row, not that one."
          : Math.max(lo, mi, hi) - Math.min(lo, mi, hi) < 5
            ? "no measurable effect across bands"
            : "predictive, monotonic",
      });
    }
  }

  const withFeat = graded.length;
  return {
    what_this_is:
      "For each input our scorer uses, the rug rate when that signal is present versus absent, computed from our own graded outcomes. A signal with no lift is decoration however sensible it sounds — and one with negative lift is actively pointing the wrong way.",
    graded_calls_with_feature_data: withFeat,
    caveat:
      withFeat < 100
        ? `Only ${withFeat} graded calls carry feature data so far — feature logging began 2026-07-26 and the ledger before that recorded only the score and the outcome. Treat everything here as provisional until the count is in the hundreds. It grows on its own about every 30 minutes.`
        : "Sample is large enough to act on, but re-read it before changing weights — these are observational, not causal.",
    signals: out.sort((x: any, y: any) => Math.abs(y.lift_points ?? 0) - Math.abs(x.lift_points ?? 0)),
  };
}

/** Ticker reuse: does a symbol we have seen before rug more often than a first-timer? */
export function relaunchStats(rows: Row[]) {
  const graded = rows.filter((r) => r.graded && r.outcome && typeof r.reuse === "number");
  const rugRate = (rs: Row[]) => pctOf(rs.filter((r) => r.outcome === "rugged").length, rs.length);
  const first = graded.filter((r) => r.reuse === 0);
  const repeat = graded.filter((r) => (r.reuse as number) >= 1);

  // The symbols themselves — a ticker that keeps coming back is the headline.
  const bySymbol = new Map<string, { seen: number; rugged: number }>();
  for (const r of rows) {
    if (!r.symbol) continue;
    const k = String(r.symbol).toUpperCase();
    const e = bySymbol.get(k) ?? { seen: 0, rugged: 0 };
    e.seen++;
    if (r.outcome === "rugged") e.rugged++;
    bySymbol.set(k, e);
  }
  const serial = [...bySymbol.entries()]
    .filter(([, v]) => v.seen >= 2 && v.rugged >= 1)
    .sort((a, b) => b[1].rugged - a[1].rugged || b[1].seen - a[1].seen)
    .slice(0, 20)
    .map(([symbol, v]) => ({ symbol, times_seen: v.seen, times_rugged: v.rugged }));

  return {
    what_this_is:
      "Ticker reuse. A scammer who rugs relaunches under the same symbol, and counting that is only possible for somebody who has been recording — there is no free API that will tell you a ticker has already died three times on this chain.",
    first_time_symbols: { calls: first.length, rug_rate_pct: first.length >= MIN_SPLIT ? rugRate(first) : null },
    repeat_symbols: { calls: repeat.length, rug_rate_pct: repeat.length >= MIN_SPLIT ? rugRate(repeat) : null },
    lift_points:
      first.length >= MIN_SPLIT && repeat.length >= MIN_SPLIT
        ? Number(((rugRate(repeat)! - rugRate(first)!)).toFixed(1))
        : null,
    serial_offenders: serial,
    caveat:
      repeat.length < MIN_SPLIT
        ? `Only ${repeat.length} graded calls involve a symbol we had already seen. Reuse counting began 2026-07-26; this sharpens every sweep and cannot be back-filled.`
        : undefined,
  };
}
