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

export function stats() {
  return {
    startedAt,
    totalPaidCalls: totalCalls,
    estRevenueUsd: Number(totalRevenueUsd.toFixed(4)),
    byEndpoint: Object.fromEntries(
      [...byEndpoint.entries()].map(([k, v]) => [
        k,
        { calls: v.calls, revenueUsd: Number(v.revenueUsd.toFixed(4)) },
      ]),
    ),
    note: "Estimated from list prices. Real balance = USDC at your wallet.",
  };
}
