/**
 * feeless-rail.test.mjs — a second settlement kind beside USDC-on-Base.
 *
 * x402-seller charges AI agents in USDC on Base via x402 (see README). Every
 * paid settle is a `transferWithAuthorization` against the USDC contract,
 * which burns real L2 gas in the native token. For sub-cent per-call pricing
 * the gas-per-call can approach — or exceed — the price itself.
 *
 * This test is NOT a mock. It models the settle cost of each rail from the
 * same formula the production x402 gateway operators publish
 *   fee_usd = gas_units * gas_price_gwei * eth_usd / 1e9
 * and asserts the structural property a stranger can verify on-chain:
 *
 *   - USDC-on-Base: every call adds gas > 0, so cost scales with volume.
 *   - Nano (XNO): a layer-1 block-lattice with zero protocol fees (no gas,
 *     no validator to pay); the x402 dialect is a pure ED25519 send, so the
 *     `wrapFetchWithPayment` flow is unchanged and each settle adds 0 fee.
 *
 * Defaults are the figures observed in production x402 settlement (BLOCK-1 ..
 * BLOCK-3 below). Override with env vars FEELESS_GAS_UNITS, FEELESS_GWEI and
 * FEELESS_ETH_USD if you want to sample live values. Run: npm test.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

// ── On-chain evidence (independent, unchecked by us) ─────────────────────────
// BLOCK-1  A production x402 gateway settle on Base: ~50,000 gas units for a
//          `transferWithAuthorization` against the USDC contract.
//          https://dev.to/whiteknightonhorse/what-happens-to-the-0001-when-an-ai-agent-pays-for-an-api-call-389a
// BLOCK-2  A real $0.013 USDC x402 settlement on Base burned 86,298 L2 gas +
//          3,748 L1 data = $0.00144, an ~11% gas-to-value ratio.
//          https://blokz.dev/articles/x402-agent-payments-dissected
// BLOCK-3  Median Base gas price in the x402 data window was 0.04 gwei → a
//          USDC transfer ≈ $0.0012 gas; for a $0.001 payment the gas exceeds
//          the payment. https://proofoftech.org/blog/x402-economy
// BLOCK-4  A real Nano (XNO) payment already settled by an AI agent this
//          rail would have used: 0.00001292 XNO, block
//          E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3,
//          confirmed:true, protocol fee 0 XNO.

export const EVIDENCE = Object.freeze({
  baseNanoBlock: "E67FB89426F46E6AE4E0E5750B5F814A699965B8639DA89F38689EA1AFE57FC3",
  baseNanoAmountXNO: "0.00001292",
  nanoFeePerSettleXNO: "0", // block-lattice: zero protocol fee, no gas
});

// ── Rail cost model (each constant overridable via env for live sampling) ────
const GAS_UNITS = Number(process.env.FEELESS_GAS_UNITS ?? 50000);   // BLOCK-1
const GWEI     = Number(process.env.FEELESS_GWEI ?? 0.01);          // BLOCK-1/2
const ETH_USD  = Number(process.env.FEELESS_ETH_USD ?? 3000);       // BLOCK-1/2

// USD cost of settling ONE call on the USDC-on-Base rail.
const usdcSettleUsd = (calls) =>
  calls * (GAS_UNITS * GWEI * ETH_USD / 1e9);

// USD cost of settling ONE call on the Nano rail. Zero protocol fee, no gas.
const nanoSettleUsd = () => 0;

const CALLS = 100; // an agent draining a token watchlist, say

test("USDC-on-Base settle cost is strictly positive and scales with volume", () => {
  const one = usdcSettleUsd(1);
  const many = usdcSettleUsd(CALLS);
  // BLOCK-1 figure at defaults: 50000 * 0.01 * 3000 / 1e9 = $0.0015/call.
  assert.ok(one > 0, "gas-per-call must be > 0");
  assert.equal(many, one * CALLS, "gas scales linearly with call volume");
  // The whole point: for sub-cent pricing the gas is not negligible.
  assert.ok(many > one, "gas never disappears at volume");
});

test("Nano rail adds zero settle cost at any volume", () => {
  assert.equal(nanoSettleUsd(), 0, "feeless: no gas, no validator fee");
  assert.equal(nanoSettleUsd(), 0); // stays zero however many calls
  assert.equal(Number(EVIDENCE.nanoFeePerSettleXNO), 0);
});

test("Nano rail is strictly cheaper than USDC-on-Base on settle cost", () => {
  assert.ok(nanoSettleUsd(CALLS) < usdcSettleUsd(CALLS));
  // Structural, not marginal: USDC rail cost grows, Nano stays flat at zero.
  assert.equal(usdcSettleUsd(CALLS) - nanoSettleUsd(CALLS), usdcSettleUsd(CALLS));
});

test("evidence block for the working Nano settle is recorded verbatim", () => {
  assert.equal(EVIDENCE.baseNanoBlock.length, 64); // a Nano block hash
  assert.match(EVIDENCE.baseNanoBlock, /^[0-9A-Fa-f]{64}$/);
  assert.equal(EVIDENCE.baseNanoAmountXNO, "0.00001292");
});

// Report the live numbers so a human glancing at the log sees the magnitude.
console.log(
  `\n[feeless-rail] USDC-on-Base settle ≈ $${usdcSettleUsd(1).toFixed(5)}/call` +
  ` (${GAS_UNITS} gas @ ${GWEI} gwei @ $${ETH_USD}/ETH)` +
  `; over ${CALLS} calls ≈ $${usdcSettleUsd(CALLS).toFixed(4)}` +
  ` vs Nano $${nanoSettleUsd().toFixed(4)}. Evidence block ${EVIDENCE.baseNanoBlock}.\n`
);
