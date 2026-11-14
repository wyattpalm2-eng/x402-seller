/**
 * selftest — assertions over the pieces that decide what a buyer is told.
 * Run: npx tsx scripts/selftest.mts
 */
import express from "express";
import type { AddressInfo } from "node:net";
import { decodeReceiptHeader, generateReceiptKeyPair, verifyReceipt } from "@paxiom/receipts";
import { ratioPct } from "../src/record.js";
import { createSellerReceiptSetup, priceToAtomicUsdc } from "../src/receipts.js";
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

console.log("\ndegraded inputs — an upstream outage must not manufacture confidence");
// Real failure caught in production: DexScreener returned 429, liq_usd arrived null, coerced to 0,
// lit up band_micro and produced p_rug 0.0005 — the single most reassuring answer the model can
// give — because we failed to fetch rather than because the token was safe.
const thin = {
  green_flags: 2, red_flags: 1, sources: 2, renounced: false, verified: false, mintable: false,
  proxy: false, creator_prior_honeypot: false, hp_honeypot: false, needs_review: false,
  buy_tax: 0, sell_tax: 0, holders: null, lp_locked: null,
  address: "0x1111111111111111111111111111111111111111",
};
const measured = survival({ ...thin, liq_usd: 60000 });
const degraded = survival({ ...thin, liq_usd: null });
console.log(`    measured  p_rug=${measured.p_rug} ${measured.cohort} (${measured.confidence})`);
console.log(`    degraded  p_rug=${degraded.p_rug} ${degraded.cohort} (${degraded.confidence})`);
ok("missing liquidity is reported, not swallowed", degraded.confidence === "degraded");
ok("the missing input is named", degraded.inputs_missing.some((s) => s.includes("liq_usd")));
ok("a degraded read never says resilient", degraded.cohort !== "resilient");
ok("a degraded read never says doomed", degraded.cohort !== "doomed");
ok("a measured read is still labelled measured", measured.confidence === "measured");
ok("no borrowed authority: no hit rate quoted on a degraded read", degraded.observed_at_this_confidence === null);
ok("the note tells the caller to retry", /degraded/i.test(degraded.cohort_note));
// And the same guard on the doomed side: a launchpad token whose liquidity we could not read.
const doomedish = survival({
  ...thin, green_flags: 5, renounced: true, verified: true, sources: 4, liq_usd: null,
  address: "0xca3a4d1360c8120d421ef3cf8fd4fd4c4421d174",
});
ok("degraded launchpad read is held back from doomed", doomedish.cohort !== "doomed" && doomedish.confidence === "degraded");
ok("NaN liquidity is treated as missing too", survival({ ...thin, liq_usd: NaN }).confidence === "degraded");

// Stale-but-present liquidity: usable, but it is exactly the reading that would miss a rug that
// began after it was taken, so it must not be sold as a fresh measurement.
const stale = survival({ ...thin, liq_usd: 60000, liq_stale_minutes: 42 });
ok("a stale liquidity read is flagged degraded", stale.confidence === "degraded");
ok("the staleness age is stated", stale.inputs_missing.some((s) => s.includes("42min")));
ok("the note warns a rug since then is invisible", /re-check/i.test(stale.cohort_note));
ok("stale still keeps the probability usable", stale.p_rug === measured.p_rug);
ok("a fresh read with stale=0 stays measured", survival({ ...thin, liq_usd: 60000, liq_stale_minutes: 0 }).confidence === "measured");
ok("a fresh read with stale=null stays measured", survival({ ...thin, liq_usd: 60000, liq_stale_minutes: null }).confidence === "measured");

console.log("\ncalibration table");
ok("monotone at the extremes", CALIBRATION[0].observedRug < CALIBRATION[CALIBRATION.length - 1].observedRug);
ok("lowest band is genuinely low-risk", CALIBRATION[0].observedRug < 0.10);
ok("highest band is genuinely doomed", CALIBRATION[CALIBRATION.length - 1].observedRug > 0.95);
ok("every published band has support", CALIBRATION.every((c) => c.n >= 5));
ok("validation beat the retired scorer", MODEL_META.validation.pooled_auc > MODEL_META.validation.previous_scorer_auc + 0.3);

console.log("\npaxiom delivery receipts — opt-in Ed25519 output + settlement binding");
ok("disabled when PAXIOM_PRIVATE_KEY_PEM is unset", createSellerReceiptSetup({ network: "eip155:8453", routes: {} }) === null);
ok("priceToAtomicUsdc converts $0.01 -> 10000 and $0.005 -> 5000", priceToAtomicUsdc("$0.01") === "10000" && priceToAtomicUsdc("$0.005") === "5000");

const kp = generateReceiptKeyPair({ keyId: "seller_selftest_1" });
// Escape newlines the way .env / Render env vars often store PEM strings.
const escapedPem = kp.privateKeyPem.replace(/\n/g, "\\n");
const setup = createSellerReceiptSetup({
  privateKeyPem: escapedPem,
  keyId: kp.keyId,
  publicBaseUrl: "https://seller.example",
  network: "eip155:8453",
  routes: {
    "GET /price": { accepts: [{ price: "$0.01" }] },
    "GET /token/risk/:address": { accepts: [{ price: "$0.05" }] },
  },
});
ok("setup initializes and derives matching Ed25519 public key", setup !== null && setup.publicKey === kp.publicKey);

const testApp = express();
testApp.use(setup!.middleware);
testApp.get("/health", (_req, res) => res.json({ ok: true }));
testApp.get("/demo/vet", (_req, res) => res.json({ verdict: "ok", demo: true }));

// Simulate @x402/express paymentMiddleware exact lifecycle:
//   - unpaid -> 402
//   - paid -> buffer downstream res.end, set PAYMENT-RESPONSE header with settled txHash, then flush outer res.end
const SETTLED_TX = "0x" + "ab".repeat(32);
testApp.use((req, res, next) => {
  if (!req.path.startsWith("/price") && !req.path.startsWith("/token/risk/")) return next();
  if (!req.get("payment-signature")) {
    return void res.status(402).json({ x402Version: 2, error: "payment_required" });
  }
  const origEnd = res.end.bind(res);
  let buffered: any[] | null = null;
  (res as any).end = (...args: any[]) => {
    buffered = args;
    return res;
  };
  next();
  if (buffered) {
    res.end = origEnd;
    if (res.statusCode < 400) {
      const settlePayload = Buffer.from(JSON.stringify({ success: true, transaction: SETTLED_TX }), "utf8").toString("base64");
      res.setHeader("PAYMENT-RESPONSE", settlePayload);
    }
    (origEnd as any)(...buffered);
  }
});
testApp.get("/price", (req, res) => {
  if (req.query.bad === "1") return void res.status(400).json({ error: "bad_request" });
  res.json({ symbol: "BTC", usd: 98500, source: "x402-seller" });
});
testApp.get("/token/risk/:address", (req, res) => {
  res.json({ address: req.params.address, risk: 0.12 });
});

const srv = await new Promise<ReturnType<typeof testApp.listen>>((resolve) => {
  const s = testApp.listen(0, "127.0.0.1", () => resolve(s));
});
const baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

try {
  // 1. Free non-demo route is untouched (no X-Paxiom-Receipt)
  const freeRes = await fetch(`${baseUrl}/health`, { headers: { Connection: "close" } });
  ok("free /health route omits X-Paxiom-Receipt", freeRes.status === 200 && freeRes.headers.get("x-paxiom-receipt") === null);

  // 2. Unpaid 402 challenge omits X-Paxiom-Receipt
  const unpaidRes = await fetch(`${baseUrl}/price?symbol=BTC`, { headers: { Connection: "close" } });
  ok("402 challenge omits X-Paxiom-Receipt", unpaidRes.status === 402 && unpaidRes.headers.get("x-paxiom-receipt") === null);

  // 3. Paid 400 validation failure omits X-Paxiom-Receipt
  const badRes = await fetch(`${baseUrl}/price?bad=1`, { headers: { "PAYMENT-SIGNATURE": "sig_test", Connection: "close" } });
  ok("400 validation failure omits X-Paxiom-Receipt", badRes.status === 400 && badRes.headers.get("x-paxiom-receipt") === null);

  // 4. Paid 200 settled response emits X-Paxiom-Receipt binding output + settled txHash + route price
  const paidRes = await fetch(`${baseUrl}/token/risk/0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, {
    headers: { "PAYMENT-SIGNATURE": "sig_settled_1", Connection: "close" },
  });
  const paidJson = await paidRes.json();
  const paidHdr = paidRes.headers.get("x-paxiom-receipt");
  const exposeHdr = paidRes.headers.get("access-control-expose-headers") || "";
  ok("settled paid 200 emits X-Paxiom-Receipt + CORS expose header", paidHdr !== null && exposeHdr.toLowerCase().includes("x-paxiom-receipt"));
  const decoded = decodeReceiptHeader(paidHdr!);
  const verified = verifyReceipt(decoded, { output: paidJson });
  ok(
    "settled receipt binds Ed25519 signature, output hash, $0.05 parameterized price, and facilitator txHash",
    verified.checks.signature === "pass" &&
      verified.checks.outputHash === "pass" &&
      verified.trustState === "settlement_claimed_not_checked" &&
      decoded.payload.payment.amountAtomic === "50000" &&
      decoded.payload.payment.network === "eip155:8453" &&
      decoded.payload.payment.settlement.transactionHash === SETTLED_TX,
  );

  // 5. Tampering with delivered JSON body triggers output_hash_mismatch
  const tampered = verifyReceipt(decoded, { output: { ...paidJson, risk: 0.99 } });
  ok("tampered body fails with output_hash_mismatch", tampered.valid === false && tampered.trustState === "output_hash_mismatch");

  // 6. Free /demo/vet emits a fully offline-verified receipt so evaluators can test verification free
  const demoRes = await fetch(`${baseUrl}/demo/vet`, { headers: { Connection: "close" } });
  const demoJson = await demoRes.json();
  const demoHdr = demoRes.headers.get("x-paxiom-receipt");
  const demoVerdict = verifyReceipt(decodeReceiptHeader(demoHdr!), { output: demoJson });
  ok("free /demo/vet emits offline-verified receipt (amountAtomic=0)", demoVerdict.valid === true && demoVerdict.trustState === "verified");
} finally {
  srv.closeAllConnections?.();
  await new Promise<void>((resolve) => srv.close(() => resolve()));
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
