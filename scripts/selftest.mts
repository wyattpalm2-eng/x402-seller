/**
 * selftest — assertions over the pieces that decide what a buyer is told.
 * Run: npx tsx scripts/selftest.mts
 */
import { ratioPct } from "../src/record.js";
import { survival, addressFingerprint, CALIBRATION, MODEL_META } from "../src/survival.js";

let pass = 0, fail = 0;
function ok(name: string, cond: boolean, detail = "") {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
}

console.log("\nratioPct — the guard on the 5.1e+23 grading bug");
ok("normal ratio", ratioPct(50, 100) === 50.0);
ok("total loss reads 0, not null", ratioPct(0, 100) === 0);
ok("denormal baseline rejected", ratioPct(1e-6, 1e-30) === null, `got ${ratioPct(1e-6, 1e-30)}`);
ok("absurd ratio rejected", ratioPct(1e12, 1e-9) === null, `got ${ratioPct(1e12, 1e-9)}`);
ok("the exact production blow-up is rejected", ratioPct(5.1e17, 1e-6) === null);
ok("null now => null", ratioPct(null, 100) === null);
ok("zero baseline => null", ratioPct(5, 0) === null);
ok("negative baseline => null", ratioPct(5, -1) === null);
ok("10x recovery still allowed", ratioPct(1000, 100) === 1000);

console.log("\naddressFingerprint");
ok("vanity/factory address detected", addressFingerprint("0xb20000000000000000000047d39a480397261401").addr_vanity === true);
ok("ordinary address not flagged", addressFingerprint("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913").addr_vanity === false);

console.log("\nsurvival model — direction of the learned inversion");
const base = {
  red_flags: 0, sources: 4, mintable: false, proxy: false, creator_prior_honeypot: false,
  hp_honeypot: false, needs_review: false, buy_tax: 0, sell_tax: 0, lp_locked: true,
};
// The launchpad fingerprint: ~$10k seed, every green flag auto-applied. Ledger says ~100% rug.
const launchpad = survival({
  ...base, liq_usd: 10200, green_flags: 5, renounced: true, verified: true, holders: null,
  address: "0xca3a4d1360c8120d421ef3cf8fd4fd4c4421d174",
});
// A deep, widely-held, resolvable token — the profile that actually survives.
const established = survival({
  ...base, liq_usd: 250000, green_flags: 3, renounced: false, verified: true, holders: 40000,
  address: "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913",
});
console.log(`    launchpad   p_rug=${launchpad.p_rug}  ${launchpad.cohort}`);
console.log(`    established p_rug=${established.p_rug}  ${established.cohort}`);
ok("launchpad-seeded token reads doomed", launchpad.cohort === "doomed");
ok("established token reads resilient", established.cohort === "resilient");
ok("the two are far apart", launchpad.p_rug - established.p_rug > 0.8);
ok("probabilities are probabilities", launchpad.p_rug >= 0 && launchpad.p_rug <= 1 && Math.abs(launchpad.p_rug + launchpad.p_survive - 1) < 1e-6);
ok("horizon is stated", launchpad.horizon_hours === 6);
ok("drivers explain the call", launchpad.drivers.length > 0);
ok("calibration attached", launchpad.observed_at_this_confidence !== null);

console.log("\ncalibration table");
ok("monotone at the extremes", CALIBRATION[0].observedRug < CALIBRATION[CALIBRATION.length - 1].observedRug);
ok("lowest band is genuinely low-risk", CALIBRATION[0].observedRug < 0.10);
ok("highest band is genuinely doomed", CALIBRATION[CALIBRATION.length - 1].observedRug > 0.95);
ok("every published band has support", CALIBRATION.every((c) => c.n >= 5));
ok("validation beat the retired scorer", MODEL_META.validation.pooled_auc > MODEL_META.validation.previous_scorer_auc + 0.3);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
