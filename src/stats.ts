/**
 * Revenue + usage tracking. Turns the black box into something you can reason
 * about: every paid delivery is counted, logged to the console, and appended to
 * a durable sales.jsonl ledger. `GET /stats` exposes the running totals.
 *
 * "Sale" = a paid request we successfully DELIVERED (payment cleared the paywall
 * and we returned data). Revenue is ESTIMATED from list prices, not on-chain
 * truth — for the real number, watch USDC land at your wallet address.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LEDGER = path.join(__dirname, "..", "sales.jsonl");

type Endpoint = { calls: number; revenueUsd: number };
const byEndpoint = new Map<string, Endpoint>();
let totalCalls = 0;
let totalRevenueUsd = 0;
const startedAt = new Date().toISOString();

/** "$0.01" -> 0.01 */
export function priceToUsd(price: string): number {
  const n = Number(String(price).replace(/[^0-9.]/g, ""));
  return Number.isFinite(n) ? n : 0;
}

export function recordSale(route: string, priceUsd: number, symbol?: string): void {
  const e = byEndpoint.get(route) ?? { calls: 0, revenueUsd: 0 };
  e.calls += 1;
  e.revenueUsd += priceUsd;
  byEndpoint.set(route, e);
  totalCalls += 1;
  totalRevenueUsd += priceUsd;

  // Durable ledger + console signal. Never throw into the request path.
  try {
    fs.appendFileSync(
      LEDGER,
      JSON.stringify({ route, priceUsd, symbol, at: new Date().toISOString() }) + "\n",
    );
  } catch {
    /* best-effort */
  }
  console.log(
    `  SALE  ${route}  $${priceUsd.toFixed(3)}${symbol ? "  " + symbol : ""}` +
      `   (running: $${totalRevenueUsd.toFixed(3)} over ${totalCalls} calls)`,
  );
}

/* ── SETTLEMENT TRACKING ────────────────────────────────────────────────────
 * Why this exists: on 2026-07-25 six real external bots sent valid signed payment
 * authorizations, we DELIVERED all six, and the wallet received 0.000000 USDC. We had no way
 * to tell whether settlement was pending, refused, or silently failing, because the facilitator's
 * settle result was returned to us in the `payment-response` header and then thrown away.
 *
 * In x402 the buyer does not send coins -- they send a signed authorization. Verify, deliver and
 * SETTLE are three separate steps, and only settle moves USDC. A delivery is a receivable, not
 * revenue. These counters make that distinction visible instead of assumed.
 */
type Settlement = { settled: number; failed: number; pending: number; lastTx?: string; lastError?: string; lastAt?: string };
const settlement: Settlement = { settled: 0, failed: 0, pending: 0 };
const RECEIPTS = path.join(__dirname, "..", "settlements.jsonl");

/**
 * Record what the facilitator said about settling one delivered call.
 * `success` undefined means the header was absent -> nothing settled that we can see.
 */
export function recordSettlement(route: string, success: boolean | undefined, txHash?: string, error?: string): void {
  if (success === true) { settlement.settled += 1; settlement.lastTx = txHash; }
  else if (success === false) { settlement.failed += 1; settlement.lastError = error || "settle reported failure"; }
  else { settlement.pending += 1; settlement.lastError = error || "no payment-response header returned"; }
  settlement.lastAt = new Date().toISOString();

  try {
    fs.appendFileSync(
      RECEIPTS,
      JSON.stringify({ route, success: success ?? null, txHash, error, at: settlement.lastAt }) + "\n",
    );
  } catch { /* best-effort: never throw into the request path */ }

  const tag = success === true ? `SETTLED tx=${txHash}` : success === false ? `SETTLE-FAILED ${error}` : `NOT-SETTLED ${error ?? ""}`;
  console.log(`  ${tag}  ${route}   (settled ${settlement.settled} / failed ${settlement.failed} / unsettled ${settlement.pending})`);
}

export function stats() {
  const collected = settlement.settled;
  const uncollected = totalCalls - collected;
  return {
    startedAt,
    // DELIVERED -- what we handed over. A receivable, NOT revenue.
    totalPaidCalls: totalCalls,
    estRevenueUsd: Number(totalRevenueUsd.toFixed(4)),
    // SETTLED -- what the facilitator says actually moved on-chain. This is the real number.
    settlement: {
      settled: settlement.settled,
      failed: settlement.failed,
      unsettled: settlement.pending,
      uncollectedDeliveries: uncollected < 0 ? 0 : uncollected,
      lastTx: settlement.lastTx,
      lastError: settlement.lastError,
      lastAt: settlement.lastAt,
    },
    byEndpoint: Object.fromEntries(
      [...byEndpoint.entries()].map(([k, v]) => [
        k,
        { calls: v.calls, revenueUsd: Number(v.revenueUsd.toFixed(4)) },
      ]),
    ),
    note:
      "estRevenueUsd is DELIVERED value estimated from list prices -- a receivable, not revenue. " +
      "settlement.settled is what the facilitator confirmed on-chain. Ground truth is USDC at the payTo wallet.",
  };
}
