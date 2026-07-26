/**
 * A one-way snapshot of our own measured accuracy, so a PAID verdict can carry the truth about
 * itself without creating an import cycle (record.ts already imports safety.ts, so safety.ts can
 * never import record.ts).
 *
 * Why this exists: our published calibration shows the score is currently INVERTED. Tokens we score
 * 0-24 and label "ok" went on to rug 78.9% of the time across 128 graded calls -- and notably 101
 * rugged with 0 merely dumped, which is the signature of a liquidity pull rather than a decline.
 * Tokens we score 80-100 and label "danger" rugged 0 times in 21.
 *
 * Selling an "ok" verdict with that history attached to it, silently, is precisely the fake this
 * company exists not to ship: a number presented as knowledge when the evidence says the opposite.
 * We are not going to quietly re-weight a model mid-session and call it fixed either -- there are
 * two live explanations (backwards weights, or a grader blind to honeypots, which trap buyers
 * without draining liquidity). Until that is settled, the honest move is to hand the buyer the
 * measurement alongside the verdict and let them price it.
 */

export type BandAccuracy = { calls: number; ruggedPct: number };

let snapshot: Record<string, BandAccuracy> = {};
let updatedAt: string | null = null;

/** Called by record.ts after each sweep. Keys are verdict labels: ok | warning | danger. */
export function setVerdictAccuracy(next: Record<string, BandAccuracy>): void {
  snapshot = next;
  updatedAt = new Date().toISOString();
}

/**
 * The sentence a paid response should carry next to its verdict. Returns null when we genuinely
 * have too little history to say anything -- silence is correct there, invented reassurance is not.
 */
export function verdictHonesty(verdict: string): { measured: string; note: string; as_of: string } | null {
  const a = snapshot[verdict];
  if (!a || a.calls < 25) return null;
  const base = snapshot.__base__?.ruggedPct;
  const worseThanChance = base !== undefined && a.ruggedPct > base;
  return {
    measured: `Across ${a.calls} past calls where we said "${verdict}", ${a.ruggedPct}% of those tokens went on to rug within 6 hours.`,
    note: worseThanChance
      ? `That is WORSE than the ${base}% base rate across everything we score, so treat this verdict as unproven and read red_flags directly. We publish this because you are about to risk money on it. Full table: /calibration`
      : `Base rate across everything we score is ${base ?? "unknown"}%. Full table: /calibration`,
    as_of: updatedAt ?? "unknown",
  };
}
