/**
 * Verified sales: every settled payment we can prove on-chain.
 *
 * The in-process sales counter resets on every free-tier restart, so it is useless as proof.
 * This ledger is committed to the repo (data/settled_sales.jsonl) and every row is an inbound
 * USDC transfer to PAY_TO on Base that anyone can check on Basescan. Rows are added by hand
 * after checking the chain, never inferred from our own logs.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { receiptsRaw } from "./stats.js";

type Sale = { at: string; tx: string; block: number; payer: string; usdc: number };

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "settled_sales.jsonl");

function load(): Sale[] {
  try {
    return fs
      .readFileSync(FILE, "utf8")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Sale)
      .sort((a, b) => a.at.localeCompare(b.at));
  } catch {
    return [];
  }
}

const SALES = load();

export function salesSummary() {
  const payers = new Map<string, number>();
  for (const s of SALES) payers.set(s.payer.toLowerCase(), (payers.get(s.payer.toLowerCase()) ?? 0) + 1);
  const total = SALES.reduce((sum, s) => sum + s.usdc, 0);
  return {
    settled_payments: SALES.length,
    distinct_payers: payers.size,
    repeat_payers: [...payers.values()].filter((n) => n > 1).length,
    total_usdc: Math.round(total * 1e6) / 1e6,
    first_sale: SALES[0]?.at ?? null,
    latest_sale: SALES[SALES.length - 1]?.at ?? null,
  };
}

/** Which routes were paid for, from the facilitator's settle receipts (recorded since 2026-11-23). */
export function salesByRoute() {
  const by: Record<string, { settled: number; failed: number; last_tx: string | null; last_at: string | null }> = {};
  for (const r of receiptsRaw()) {
    const b = (by[r.route] ??= { settled: 0, failed: 0, last_tx: null, last_at: null });
    if (r.success === true) { b.settled++; b.last_tx = r.txHash ? `https://basescan.org/tx/${r.txHash}` : null; b.last_at = r.at; }
    else if (r.success === false) b.failed++;
  }
  return {
    note: "Per-route counts from settle receipts, kept since 2026-11-23. The 25 earlier payments above are on-chain but were never linked to a route, because the server's log did not survive restarts.",
    routes: Object.entries(by).sort((a, b) => b[1].settled - a[1].settled).map(([route, v]) => ({ route, ...v })),
  };
}

export function salesLedger() {
  return {
    ...salesSummary(),
    by_route: salesByRoute(),
    note:
      "Every row is an inbound USDC transfer on Base to our payTo address. None of the payers are wallets we control. " +
      "Check any row on Basescan; do not take our word for it.",
    verify_all: "https://basescan.org/tokentxns?a=0x72B944dA66263bE35c2a2eDFeF5c525d58fa53Df",
    sales: SALES.slice()
      .reverse()
      .map((s) => ({ ...s, basescan: `https://basescan.org/tx/${s.tx}` })),
  };
}
