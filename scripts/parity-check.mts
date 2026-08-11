/**
 * parity-check — replay the labelled ledger through the SHIPPED TypeScript model and confirm it
 * reproduces the Python fit that was validated, then re-measure AUC on the TS side.
 *
 * A model that validates in a notebook and is then hand-ported is two models. This proves they are
 * one. Run: npx tsx scripts/parity-check.mts <path-to-track-record-raw.json>
 */
import fs from "node:fs";
import { survival } from "../src/survival.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: parity-check.mts <track-record-raw.json>");
  process.exit(1);
}
const rows = JSON.parse(fs.readFileSync(path, "utf8")).rows as any[];
const graded = rows.filter((r) => r.graded && r.feat);

const scored = graded.map((r) => {
  const f = r.feat;
  const s = survival({
    liq_usd: f.liq_usd ?? null,
    green_flags: f.green_flags ?? 0,
    red_flags: f.red_flags ?? 0,
    sources: f.sources ?? 0,
    renounced: f.renounced ?? null,
    verified: f.verified ?? null,
    mintable: f.mintable ?? null,
    proxy: f.proxy ?? null,
    creator_prior_honeypot: f.creator_prior_honeypot ?? null,
    hp_honeypot: f.hp_honeypot ?? null,
    needs_review: f.needs_review ?? null,
    buy_tax: f.buy_tax ?? null,
    sell_tax: f.sell_tax ?? null,
    holders: f.holders ?? null,
    lp_locked: f.lp_locked ?? null,
    address: r.address,
  });
  return { id: r.id, p: s.p_rug, cohort: s.cohort, y: r.outcome === "rugged" ? 1 : 0 };
});

fs.writeFileSync(
  process.env.PARITY_OUT || "/tmp/ts_preds.json",
  JSON.stringify(scored.map((s) => ({ id: s.id, p: s.p }))),
);

// AUC via rank statistic
function auc(pred: number[], y: number[]): number {
  const idx = pred.map((p, i) => [p, y[i]] as const).sort((a, b) => a[0] - b[0]);
  let rankSum = 0, npos = 0, nneg = 0;
  idx.forEach(([, yy], i) => {
    if (yy === 1) { rankSum += i + 1; npos++; } else nneg++;
  });
  return (rankSum - (npos * (npos + 1)) / 2) / (npos * nneg);
}

const p = scored.map((s) => s.p), y = scored.map((s) => s.y);
console.log(`scored ${scored.length} labelled rows through the shipped TS model`);
console.log(`in-sample AUC (TS): ${auc(p, y).toFixed(4)}`);

const byCohort: Record<string, { n: number; rug: number }> = {};
for (const s of scored) {
  byCohort[s.cohort] ??= { n: 0, rug: 0 };
  byCohort[s.cohort].n++;
  byCohort[s.cohort].rug += s.y;
}
console.log("\ncohort              n     rugged");
for (const c of ["resilient", "uncertain", "fragile", "doomed"]) {
  const b = byCohort[c];
  if (b) console.log(`${c.padEnd(12)} ${String(b.n).padStart(6)} ${((100 * b.rug) / b.n).toFixed(1).padStart(9)}%`);
}
