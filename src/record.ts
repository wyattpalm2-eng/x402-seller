/**
 * record.ts — the PUBLIC SELF-GRADED TRACK RECORD. The conversion weapon.
 *
 *   GET /track-record   →   FREE
 *
 * A skeptical agent has no reason to trust "we catch rugs" — claims are cheap.
 * So we grade ourselves in public: every ~30 min we run our own composite rug
 * score over freshly-launched / trending Base tokens (internal calls, costs us
 * nothing), record the verdict + the pool's liquidity and price at call time,
 * and hours later re-check what actually happened. A token whose liquidity is
 * gone was a rug; our verdict either caught it or missed it. BOTH outcomes are
 * published — hits, misses, and false alarms — with the grading formula stated.
 *
 * Honesty IS the product here: a track record that hides misses is marketing;
 * one that shows them is evidence. Nobody can fabricate this history without
 * having run the scoring for real, and nobody can backfill time they didn't
 * record — same compounding property as the liquidity series.
 *
 * Storage: in-memory ring + JSONL append (reloaded on boot when present).
 * Render's disk is ephemeral so a redeploy restarts the file, but the keep-warm
 * cron keeps the process alive for long stretches; depth compounds. Documented.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getJson } from "./data.js";
import { safetyReport } from "./safety.js";
import { setVerdictAccuracy } from "./calib-cache.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Committed, git-versioned path: a GitHub Action snapshots it every ~30min, so
// the record survives Render redeploys AND becomes a public, append-only,
// tamper-evident history (stronger trust than an in-memory counter). On boot we
// load whatever git shipped, then keep appending on the ephemeral disk copy.
const DATA_DIR = path.join(__dirname, "..", "data");
const LEDGER = path.join(DATA_DIR, "track_record.jsonl");

const SWEEP_MS = Number(process.env.RECORD_SWEEP_MS || 30 * 60 * 1000); // 30 min
const GRADE_AFTER_MS = 6 * 60 * 60 * 1000; // grade calls once they're 6h old
const MAX_ROWS = 2000;
const NEW_PER_SWEEP = 6; // bound upstream load
const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;

/**
 * THE FEATURE VECTOR — the inputs that produced the score, recorded alongside the outcome.
 *
 * Until 2026-07-26 this ledger stored the SCORE and the OUTCOME and nothing else. That is an answer
 * key with the questions thrown away: 1,164 graded predictions, and no way to ask which signal
 * actually predicted anything. So the weights in safety.ts are hand-guessed, and it shows —
 * on genuinely clean tokens the scorer was right 25 times out of 197. It flags almost everything.
 *
 * Every one of these fields was already computed on the call path. We were discarding them.
 *
 * This is the company's one durable moat: a competitor starting today needs months of wall-clock
 * time to accumulate the same labelled set, and there is no API that sells it. Every sweep that
 * runs without capturing the inputs is a day of moat that cannot be recovered later.
 */
type Feat = {
  holders: number | null;
  lp_locked: boolean | null;
  renounced: boolean | null;
  verified: boolean | null;      // source code published
  mintable: boolean | null;
  proxy: boolean | null;
  creator_prior_honeypot: boolean | null;
  buy_tax: number | null;
  sell_tax: number | null;
  hp_honeypot: boolean | null;   // live sell simulation said honeypot
  needs_review: boolean | null;  // static and dynamic sources disagreed
  red_flags: number;
  green_flags: number;
  sources: number;
  liq_usd: number | null;        // liquidity at call time — the strongest candidate signal
  // Deliberate scam infrastructure leaves fingerprints in the address itself: vanity-mined or
  // factory-deployed addresses carry long zero runs. Free to compute, never used before.
  addr_zero_run: number;
  addr_vanity: boolean;
};

type Row = {
  id: string;
  t: number; // when we made the call
  chain: string;
  address: string;
  symbol: string | null;
  verdict: "ok" | "warning" | "danger";
  risk_score: number;
  liq0: number | null; // liquidity USD at call time
  px0: number | null; // price USD at call time
  feat?: Feat;         // inputs behind the score — added 2026-07-26, absent on older rows
  reuse?: number;      // how many times we had already seen this symbol before this call
  graded: boolean;
  outcome?: "rugged" | "dumped" | "fine";
  liq_now_pct?: number | null; // % of original liquidity remaining at grading
  px_now_pct?: number | null;
  graded_after_h?: number;
};

/** Longest run of repeated hex characters in the address body. A normally-deployed contract has a
 *  run of 3-4 by chance; vanity-mined and factory addresses run far longer. */
function addressFingerprint(address: string): { addr_zero_run: number; addr_vanity: boolean } {
  const body = address.replace(/^0x/, "").toLowerCase();
  let best = 0, cur = 1;
  for (let i = 1; i < body.length; i++) {
    if (body[i] === body[i - 1]) { cur++; if (cur > best) best = cur; } else cur = 1;
  }
  if (best === 0) best = 1;
  return { addr_zero_run: best, addr_vanity: best >= 8 };
}

const rows: Row[] = [];
const seen = new Set<string>(); // chain:address we've already recorded

function persist(row: Row): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  } catch {
    /* best-effort */
  }
}

/** All rows (loaded git baseline + this run's) — the GitHub Action snapshots this. */
export function rawRows(): Row[] {
  return rows.slice();
}

function load(): void {
  try {
    if (!fs.existsSync(LEDGER)) return;
    const lines = fs.readFileSync(LEDGER, "utf8").trim().split("\n").slice(-MAX_ROWS);
    const byId = new Map<string, Row>(); // later lines (graded updates) win
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as Row;
        if (r?.id) byId.set(r.id, r);
      } catch { /* skip bad line */ }
    }
    rows.push(...byId.values());
    for (const r of rows) seen.add(`${r.chain}:${r.address}`);
    rows.sort((a, b) => a.t - b.t);
  } catch {
    /* start fresh */
  }
}

/** Best-pool liquidity + price for a token on base, via DexScreener. */
async function liqPx(address: string): Promise<{ liq: number | null; px: number | null; symbol: string | null }> {
  const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
  const pairs: any[] = (j?.pairs ?? []).filter((p: any) => p?.chainId === "base");
  const pool = pairs.length ? pairs : (j?.pairs ?? []);
  if (!pool.length) return { liq: null, px: null, symbol: null };
  const best = pool.reduce(
    (b: any, p: any) => ((Number(p?.liquidity?.usd) || 0) > (Number(b?.liquidity?.usd) || 0) ? p : b),
    pool[0],
  );
  const liq = Number(best?.liquidity?.usd);
  const px = Number(best?.priceUsd);
  return {
    liq: Number.isFinite(liq) ? liq : null,
    px: Number.isFinite(px) ? px : null,
    symbol: best?.baseToken?.symbol ?? null,
  };
}

/** Candidate tokens: freshly launched + trending Base pools (GeckoTerminal). */
async function candidates(): Promise<string[]> {
  const addrs: string[] = [];
  for (const kind of ["new_pools", "trending_pools"]) {
    try {
      const j = await getJson(`https://api.geckoterminal.com/api/v2/networks/base/${kind}`);
      for (const d of j?.data ?? []) {
        const id = d?.relationships?.base_token?.data?.id;
        const m = /_(0x[a-fA-F0-9]{40})$/.exec(String(id ?? ""));
        if (m && EVM_ADDR.test(m[1])) addrs.push(m[1].toLowerCase());
      }
    } catch { /* skip source this round */ }
  }
  return [...new Set(addrs)].filter((a) => !seen.has(`base:${a}`));
}

async function sweep(): Promise<void> {
  // 1. record new calls
  try {
    const fresh = (await candidates()).slice(0, NEW_PER_SWEEP);
    for (const address of fresh) {
      try {
        const [report, market] = await Promise.all([
          safetyReport("base", address),
          liqPx(address),
        ]);
        if (!report) continue;
        // Only record what we can later GRADE: a token with no measurable
        // liquidity at call time can't be graded (it would default to "fine"
        // and quietly inflate the clean-call count). Skip it.
        if (market.liq == null || market.liq <= 0) continue;
        const sym = report.token?.symbol ?? market.symbol;
        const d: any = (report as any).details ?? {};
        const fp = addressFingerprint(address);
        // THE RELAUNCH SIGNAL. A scammer who rugs relaunches under the same ticker, and counting
        // that is only possible for someone who has been recording — which is exactly why it is
        // worth selling. Counted BEFORE this row is pushed, so it means "times seen before now".
        const reuse = sym
          ? rows.filter((r) => r.symbol && r.symbol.toLowerCase() === String(sym).toLowerCase()).length
          : 0;
        const row: Row = {
          id: `${Date.now().toString(36)}-${address.slice(2, 8)}`,
          t: Date.now(),
          chain: "base",
          address,
          symbol: sym,
          verdict: report.verdict,
          risk_score: report.risk_score,
          liq0: market.liq,
          px0: market.px,
          reuse,
          feat: {
            holders: d.holder_count ?? null,
            lp_locked: d.lp_locked ?? null,
            renounced: Array.isArray(report.green_flags) ? report.green_flags.includes("ownership renounced") : null,
            verified: d.open_source ?? null,
            mintable: d.mintable ?? null,
            proxy: d.proxy ?? null,
            creator_prior_honeypot: d.same_creator_honeypot ?? null,
            buy_tax: d.buy_tax_pct ?? null,
            sell_tax: d.sell_tax_pct ?? null,
            hp_honeypot: d.honeypot_simulated ?? null,
            needs_review: (report as any).needs_review ?? null,
            red_flags: Array.isArray(report.red_flags) ? report.red_flags.length : 0,
            green_flags: Array.isArray(report.green_flags) ? report.green_flags.length : 0,
            sources: Array.isArray((report as any).sources) ? (report as any).sources.length : 0,
            liq_usd: market.liq,
            ...fp,
          },
          graded: false,
        };
        rows.push(row);
        seen.add(`base:${address}`);
        if (rows.length > MAX_ROWS) rows.splice(0, rows.length - MAX_ROWS);
        persist(row);
      } catch { /* skip token */ }
      await new Promise((r) => setTimeout(r, 400)); // gentle on upstreams
    }
  } catch { /* sweep is best-effort */ }

  // 2. grade calls that have aged past the window
  const due = rows.filter((r) => !r.graded && Date.now() - r.t >= GRADE_AFTER_MS).slice(0, 12);
  for (const r of due) {
    try {
      // No usable baseline (e.g. an old row with null liq0/px0) can't be graded —
      // mark graded with NO outcome rather than defaulting to a fabricated "fine",
      // which would inflate accuracy on the public record. Excluded from all
      // outcome-keyed stats.
      if ((r.liq0 == null || r.liq0 <= 0) && (r.px0 == null || r.px0 <= 0)) {
        r.graded = true;
        r.outcome = undefined;
        r.graded_after_h = Number(((Date.now() - r.t) / 3_600_000).toFixed(1));
        persist(r);
        continue;
      }
      const now = await liqPx(r.address);
      const liqPct = r.liq0 && r.liq0 > 0 && now.liq !== null ? Number(((now.liq / r.liq0) * 100).toFixed(1)) : null;
      const pxPct = r.px0 && r.px0 > 0 && now.px !== null ? Number(((now.px / r.px0) * 100).toFixed(1)) : null;
      // Grading formula (published verbatim on the endpoint):
      //   rugged: <15% of original liquidity OR price remains (or pool vanished)
      //   dumped: <50% remains  ·  fine: otherwise
      const gone = now.liq === null && r.liq0 != null && r.liq0 > 0; // pool disappeared entirely
      const outcome: Row["outcome"] =
        gone || (liqPct !== null && liqPct < 15) || (pxPct !== null && pxPct < 15)
          ? "rugged"
          : (liqPct !== null && liqPct < 50) || (pxPct !== null && pxPct < 50)
            ? "dumped"
            : "fine";
      r.graded = true;
      r.outcome = outcome;
      r.liq_now_pct = liqPct;
      r.px_now_pct = pxPct;
      r.graded_after_h = Number(((Date.now() - r.t) / 3_600_000).toFixed(1));
      persist(r); // append the graded version; loader keeps the latest per id
    } catch { /* grade next sweep */ }
    await new Promise((res) => setTimeout(res, 300));
  }
}

/** Publish our measured per-verdict accuracy so paid responses can carry it. One-way: record.ts
 *  writes, safety.ts reads. See calib-cache.ts for why it is not a direct import. */
function refreshVerdictAccuracy(): void {
  // CURRENT-ERA ONLY. Attaching a lifetime average to a live verdict would quote the accuracy of a
  // scorer we retired on 2026-07-25 -- and it would quote it to the buyer, on the thing they paid
  // for. Keep this constant in step with ERAS[0] in calibration.ts.
  const CURRENT_ERA_FROM = Date.parse("2026-07-25T05:37:33.000Z");
  const graded = rows.filter((r) => r.graded && r.outcome && r.t >= CURRENT_ERA_FROM);
  if (!graded.length) return;
  const out: Record<string, { calls: number; ruggedPct: number }> = {};
  for (const v of ["ok", "warning", "danger"]) {
    const inV = graded.filter((r) => r.verdict === v);
    if (!inV.length) continue;
    const rugged = inV.filter((r) => r.outcome === "rugged").length;
    out[v] = { calls: inV.length, ruggedPct: Number(((100 * rugged) / inV.length).toFixed(1)) };
  }
  const allRugged = graded.filter((r) => r.outcome === "rugged").length;
  out.__base__ = { calls: graded.length, ruggedPct: Number(((100 * allRugged) / graded.length).toFixed(1)) };
  setVerdictAccuracy(out);
}

let started = false;
export function startRecord(): void {
  if (started) return;
  started = true;
  load();
  refreshVerdictAccuracy();
  setInterval(() => { void sweep().then(refreshVerdictAccuracy); }, SWEEP_MS);
  setTimeout(() => { void sweep().then(refreshVerdictAccuracy); }, 25_000); // first sweep shortly after boot
}

export function trackRecordSummary() {
  const graded = rows.filter((r) => r.graded);
  const flagged = (r: Row) => r.verdict === "danger" || r.verdict === "warning";
  const rugs = graded.filter((r) => r.outcome === "rugged");
  const stats = {
    calls_recorded: rows.length,
    graded: graded.length,
    pending: rows.length - graded.length,
    rugs_observed: rugs.length,
    rugs_we_flagged: rugs.filter(flagged).length, // verdict warning/danger BEFORE the rug
    rugs_we_missed: rugs.filter((r) => r.verdict === "ok").length, // published honestly
    false_alarms: graded.filter((r) => r.verdict === "danger" && r.outcome === "fine").length,
    clean_calls_correct: graded.filter((r) => r.verdict === "ok" && r.outcome === "fine").length,

    // ── The only fields that can honestly answer "is a verdict worth anything?" ──
    // These exist because deriving them from the fields above is a trap that already bit us:
    // `rugs_we_flagged` counts warning+danger, but `false_alarms` counts ONLY danger-that-was-fine.
    // Adding them to get a flagged total silently omits every warning that came out fine — the
    // large majority — which inflates P(rug|flagged) into a flattering number and hides an
    // inversion. Compute both sides over the SAME predicate, or do not publish the ratio.
    flagged_total: graded.filter(flagged).length,
    flagged_rugged: rugs.filter(flagged).length,
    ok_total: graded.filter((r) => r.verdict === "ok").length,
    ok_rugged: rugs.filter((r) => r.verdict === "ok").length,
  };
  return {
    what_this_is:
      "Our composite rug score, graded against reality in public. Every ~30min we score fresh/trending Base tokens " +
      "(same code path you pay for at /vet and /onchain/safety), record liquidity+price at call time, and re-check " +
      "6+ hours later. Hits AND misses shown — a track record that hides misses is marketing, one that shows them is evidence.",
    grading_formula:
      "rugged: <15% of call-time liquidity or price remains (or pool vanished) · dumped: <50% remains · fine: otherwise. " +
      "'Flagged' means our verdict was warning or danger BEFORE the outcome.",
    stats,
    recent_graded: graded.slice(-50).reverse().map((r) => ({
      when: new Date(r.t).toISOString(),
      token: r.symbol,
      address: r.address,
      our_verdict: r.verdict,
      risk_score: r.risk_score,
      outcome: r.outcome,
      liquidity_remaining_pct: r.liq_now_pct,
      price_remaining_pct: r.px_now_pct,
      graded_after_h: r.graded_after_h,
    })),
    note: "Ledger accrues while the service runs; a redeploy resets it (free-tier disk). Depth compounds between deploys.",
    paid_endpoints_using_this_exact_scorer: ["/vet", "/onchain/safety", "/screen"],
    as_of: new Date().toISOString(),
  };
}
