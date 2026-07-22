/**
 * truth-signal.ts — TRUTH ENGINE, second enrollment: the market-call endpoints.
 *
 * /signal sells a bullish/bearish/neutral verdict; /brief sells a risk_on/
 * risk_off regime. Both are PREDICTIONS — so per the doctrine they grade
 * themselves in public. Twice a day (00Z/12Z slots) we record the EXACT paid
 * compute's verdict + spot for BTC and ETH (and /brief's regime), then grade
 * 24h later against realized spot movement.
 *
 * Hit rules — fixed, stated, deliberately simple (an opaque metric would be
 * marketing; this one anyone can recompute from the raw ledger):
 *   bullish  hit ⇔ 24h change > +0.25%
 *   bearish  hit ⇔ 24h change < −0.25%
 *   neutral  hit ⇔ |24h change| ≤ 0.75%
 *   risk_on / risk_off grade like bullish / bearish on BTC.
 *
 * BRUTAL-HONESTY CLAUSE (rendered in the summary): direction on liquid majors
 * is close to a coin flip. If the hit rate converges to ~50%, the ledger is
 * telling you the signal has no edge — and we will say exactly that on the
 * page rather than bury it. Publishing that possibility is the point: either
 * outcome makes the rest of our numbers credible.
 *
 * Same durability pattern as truth.ts: append-only JSONL, load-on-boot,
 * git-snapshotted by truth-snapshot.yml.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signalVerdict } from "./premium.js";
import { marketBrief } from "./composites.js";
import { cryptoPrice } from "./data.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const LEDGER = path.join(DATA_DIR, "truth_signal.jsonl");
const MAX_ROWS = 6000;
const CYCLE_MS = 60 * 60 * 1000; // hourly sweep; slot dedupe makes extra runs free
const HORIZON_MS = 24 * 60 * 60 * 1000;
const SYMBOLS = ["BTC", "ETH"] as const;

type Row = {
  id: string; // `${kind}:${symbol}:${slot}`
  t: number;
  kind: "signal" | "brief";
  symbol: string;
  slot: string; // "2026-07-22T00" | "2026-07-22T12" (UTC half-day)
  verdict: string; // bullish|bearish|neutral | risk_on|risk_off|neutral
  momentum?: number | null;
  price0: number;
  graded: boolean;
  price24?: number;
  change_pct?: number;
  hit?: boolean;
  graded_after_h?: number;
  graded_at?: string;
};

const rows: Row[] = [];
const byId = new Map<string, Row>();

function persist(row: Row): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  } catch { /* best-effort */ }
}

function upsert(row: Row): void {
  const prev = byId.get(row.id);
  if (prev) {
    const i = rows.indexOf(prev);
    if (i >= 0) rows[i] = row;
  } else {
    rows.push(row);
  }
  byId.set(row.id, row);
  persist(row);
}

function load(): void {
  try {
    if (!fs.existsSync(LEDGER)) return;
    const lines = fs.readFileSync(LEDGER, "utf8").trim().split("\n").slice(-MAX_ROWS);
    const m = new Map<string, Row>();
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as Row;
        if (r?.id) m.set(r.id, r);
      } catch { /* skip bad line */ }
    }
    rows.push(...m.values());
    for (const r of rows) byId.set(r.id, r);
    rows.sort((a, b) => a.t - b.t);
  } catch { /* start fresh */ }
}

/** Current UTC half-day slot, e.g. "2026-07-22T12". */
function currentSlot(): string {
  const d = new Date();
  return `${d.toISOString().slice(0, 10)}T${d.getUTCHours() < 12 ? "00" : "12"}`;
}

function judge(verdict: string, changePct: number): boolean {
  if (verdict === "bullish" || verdict === "risk_on") return changePct > 0.25;
  if (verdict === "bearish" || verdict === "risk_off") return changePct < -0.25;
  return Math.abs(changePct) <= 0.75; // neutral
}

async function predict(): Promise<void> {
  const slot = currentSlot();
  for (const sym of SYMBOLS) {
    const id = `signal:${sym}:${slot}`;
    if (byId.has(id)) continue;
    try {
      const s = await signalVerdict(sym); // the EXACT paid compute
      if (!s) continue;
      upsert({ id, t: Date.now(), kind: "signal", symbol: sym, slot, verdict: s.verdict, momentum: s.momentum, price0: s.price_usd, graded: false });
    } catch { /* next cycle retries the slot */ }
  }
  const bid = `brief:BTC:${slot}`;
  if (!byId.has(bid)) {
    try {
      const b: any = await marketBrief("BTC"); // the EXACT paid compute
      const price0 = Number(b?.spot?.price_usd ?? b?.price_usd);
      if (b?.regime && Number.isFinite(price0)) {
        upsert({ id: bid, t: Date.now(), kind: "brief", symbol: "BTC", slot, verdict: String(b.regime), price0, graded: false });
      }
    } catch { /* next cycle */ }
  }
}

async function grade(): Promise<void> {
  const now = Date.now();
  const due = rows.filter((r) => !r.graded && now - r.t >= HORIZON_MS).slice(0, 12);
  for (const r of due) {
    try {
      const spot = await cryptoPrice(r.symbol);
      const p24 = Number(spot?.price_usd);
      if (!Number.isFinite(p24) || p24 <= 0) continue; // retry next cycle
      const change = ((p24 - r.price0) / r.price0) * 100;
      upsert({
        ...r,
        graded: true,
        price24: p24,
        change_pct: Math.round(change * 100) / 100,
        hit: judge(r.verdict, change),
        graded_after_h: Math.round(((now - r.t) / 3_600_000) * 10) / 10,
        graded_at: new Date().toISOString(),
      });
    } catch { /* retry next cycle */ }
  }
}

async function cycle(): Promise<void> {
  try {
    await predict();
    await grade();
  } catch { /* the truth engine must never take the server down */ }
}

export function startTruthSignal(): void {
  load();
  setTimeout(() => void cycle(), 45_000); // after boot, staggered from the weather sweep
  setInterval(() => void cycle(), CYCLE_MS).unref?.();
}

export function truthSignalRaw(): Row[] {
  return rows.slice();
}

export function truthSignalSummary() {
  const graded = rows.filter((r) => r.graded && typeof r.hit === "boolean");
  const hits = graded.filter((r) => r.hit).length;
  const rate = graded.length ? Math.round((100 * hits) / graded.length) : null;
  const byVerdict: Record<string, { n: number; hits: number; rate_pct: number }> = {};
  for (const r of graded) {
    const s = (byVerdict[r.verdict] ??= { n: 0, hits: 0, rate_pct: 0 });
    s.n += 1;
    if (r.hit) s.hits += 1;
    s.rate_pct = Math.round((100 * s.hits) / s.n);
  }
  return {
    doctrine:
      "The market-call endpoints grade themselves. Twice a day the EXACT paid /signal and /brief computes are recorded (verdict + spot), then graded 24h later against realized movement. Fixed, recomputable hit rules — see method.",
    endpoints: ["GET /signal", "GET /brief"],
    calls_recorded: rows.length,
    graded: graded.length,
    pending: rows.length - graded.length,
    hit_rate_pct: rate,
    by_verdict: byVerdict,
    honesty_note:
      "Direction on liquid majors is close to a coin flip. If this hit rate converges to ~50%, the ledger is saying the signal has no edge — and this page will say exactly that. Either outcome is the point: it makes every other number here credible.",
    recent: rows.slice(-12).reverse().map((r) => ({
      kind: r.kind, symbol: r.symbol, slot: r.slot, verdict: r.verdict,
      change_pct: r.change_pct ?? null, hit: r.hit ?? null, graded: r.graded,
    })),
    method: {
      record: "00Z + 12Z slots, BTC + ETH /signal + BTC /brief, exact paid code path (signalVerdict/marketBrief exports)",
      grade: "24h later vs Coinbase spot; bullish/risk_on hit ⇔ change > +0.25%, bearish/risk_off hit ⇔ change < −0.25%, neutral hit ⇔ |change| ≤ 0.75%",
      durability: "append-only JSONL, git-snapshotted (tamper-evident), survives redeploys",
    },
    as_of: new Date().toISOString(),
  };
}
