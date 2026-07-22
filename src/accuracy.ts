/**
 * accuracy.ts — GET /accuracy: the public wedge page.
 *
 * "We publish our misses." Every outreach post needs a destination; this is it.
 * Server-rendered from the SAME live ledger the paid scorer writes (record.ts),
 * so the page cannot drift from the truth: the numbers ARE the product's grades
 * against reality, misses included and named.
 *
 * Design constraints, deliberate:
 *  - honest-by-construction: recall, misses, and false alarms are computed here
 *    from the ledger — there is no copywriting layer that can inflate them.
 *  - the wedge is TRANSPARENCY, not accuracy: no competitor publishes their own
 *    hit/miss rate. An accuracy brag would die on first JSON read (agents check).
 *  - lightweight static HTML/CSS (no shaders/animation): this page is for
 *    sharing + skimming, and it must render instantly anywhere.
 *  - esc() EVERYTHING from the ledger: token symbols are attacker-chosen
 *    on-chain metadata (a <script>-named token = stored XSS otherwise).
 */
import type { Request, Response } from "express";
import { trackRecordSummary } from "./record.js";
import { truthWeatherSummary } from "./truth.js";
import { truthSignalSummary } from "./truth-signal.js";

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const pct = (n: number, d: number): string => (d > 0 ? `${Math.round((100 * n) / d)}%` : "–");

/** GET /accuracy — mounted in index.ts behind the free-route rate limiter. */
export function accuracyPage(req: Request, res: Response): void {
  const s = trackRecordSummary() as any;
  const st = s?.stats ?? {};
  const graded: any[] = Array.isArray(s?.recent_graded) ? s.recent_graded : [];

  const rugs = Number(st.rugs_observed ?? 0);
  const flagged = Number(st.rugs_we_flagged ?? 0);
  const missed = Number(st.rugs_we_missed ?? 0);
  const falseAlarms = Number(st.false_alarms ?? 0);
  const recall = pct(flagged, rugs);

  // misses = we said ok, it rugged. catches = we flagged (warning/danger), it rugged.
  const badOutcome = (r: any) => r.outcome === "rugged" || r.outcome === "dumped";
  const misses = graded.filter((r) => r.our_verdict === "ok" && badOutcome(r)).slice(0, 8);
  const catches = graded.filter((r) => (r.our_verdict === "danger" || r.our_verdict === "warning") && badOutcome(r)).slice(0, 8);

  const proto = (req.headers["x-forwarded-proto"] as string)?.split(",")[0] || req.protocol || "https";
  const base = `${proto}://${req.get("host")}`;

  const row = (r: any) =>
    `<tr><td class="tok">${esc(r.token)}</td><td><span class="v v-${esc(r.our_verdict)}">${esc(r.our_verdict)}</span> (risk ${esc(r.risk_score)})</td><td class="out">${esc(r.outcome)}</td><td class="dim">${esc(r.graded_after_h)}h · liq ${esc(r.liquidity_remaining_pct)}%</td></tr>`;

  res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>We publish our misses — x402-seller rug-scorer accuracy</title>
<meta name="description" content="A rug-check API that grades its own verdicts against reality every 30 minutes and publishes the results — hits AND misses. Recall ${esc(recall)} on ${esc(rugs)} observed rugs.">
<link rel="alternate" type="application/json" href="${esc(base)}/track-record">
<style>
  :root{--bg:#0b0e14;--panel:#131824;--line:#232b3d;--txt:#dbe2f0;--dim:#8b95ab;--green:#34d399;--red:#f87171;--amber:#fbbf24;--acc:#7dd3fc}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);font:16px/1.55 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;padding:40px 20px;max-width:860px;margin:0 auto}
  h1{font-size:34px;line-height:1.15;margin:8px 0 10px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:38px 0 12px}
  .sub{color:var(--dim);max-width:60ch}
  .kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin:26px 0}
  .kpi{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .kpi b{display:block;font-size:26px;font-weight:700}
  .kpi span{font-size:12.5px;color:var(--dim)}
  .kpi.hi b{color:var(--green)} .kpi.miss b{color:var(--red)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
  td{padding:9px 12px;border-top:1px solid var(--line)} tr:first-child td{border-top:0}
  .tok{font-weight:600;max-width:16ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .v{padding:2px 8px;border-radius:99px;font-size:12px;font-weight:600}
  .v-ok{background:#0c2b22;color:var(--green)} .v-warning{background:#2b230c;color:var(--amber)} .v-danger{background:#2b0f0c;color:var(--red)}
  .out{color:var(--red);font-weight:600} .dim{color:var(--dim);font-size:12.5px}
  .why{display:grid;gap:10px}
  .why div{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;font-size:14.5px}
  .why b{color:var(--acc)}
  a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
  .foot{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);font-size:13.5px;color:var(--dim)}
  code{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
</style></head><body>
<p class="dim" style="letter-spacing:.08em;text-transform:uppercase;font-size:12.5px">x402-seller · public self-graded track record</p>
<h1>We publish our misses.</h1>
<p class="sub">Every ~30 minutes this service scores fresh token launches with the <em>exact code path buyers pay for</em>, then re-checks reality 6+ hours later and grades itself in public — including every miss, by name. A track record that hides misses is marketing. One that shows them is evidence.</p>

<div class="kpis">
  <div class="kpi"><b>${esc(st.calls_recorded ?? "–")}</b><span>verdicts recorded</span></div>
  <div class="kpi"><b>${esc(rugs)}</b><span>rugs actually happened</span></div>
  <div class="kpi hi"><b>${esc(recall)}</b><span>of those we flagged first (${esc(flagged)}/${esc(rugs)})</span></div>
  <div class="kpi miss"><b>${esc(missed)}</b><span>we called “ok” — wrong</span></div>
  <div class="kpi"><b>${esc(falseAlarms)}</b><span>false alarms (flagged, was fine at 6h)</span></div>
</div>

<h2>Why show the misses?</h2>
<div class="why">
  <div><b>Nobody else does this.</b> No other x402 data seller grades its own paid output against reality in public. If you're an agent deciding who to trust with a cent per call, receipts beat claims.</div>
  <div><b>The misses are the lesson.</b> Almost every miss is a clean-contract token whose team pulled liquidity — a rug NO point-in-time contract scan can foresee. That's exactly why the paid <code>/vet</code> fuses the contract score with our self-collected <code>/onchain/liquidity</code> drain time-series: the drain is visible while it happens.</div>
  <div><b>The honest pitch is recall, not perfection:</b> we flag roughly 3 of 4 tokens that go on to rug — before they do — and we over-warn rather than under-warn (false alarms cost a skipped trade; a miss costs the position).</div>
</div>

<h2>Recent misses — we said "ok", it rugged</h2>
${misses.length ? `<table>${misses.map(row).join("")}</table>` : `<p class="dim">No recent ok-verdict misses in the last 50 graded calls.</p>`}

<h2>Recent catches — flagged before the rug</h2>
${catches.length ? `<table>${catches.map(row).join("")}</table>` : `<p class="dim">No recent flagged rugs in the last 50 graded calls.</p>`}

<h2>The doctrine: every endpoint grades itself</h2>
${(() => {
  const tw = truthWeatherSummary() as any;
  const graded = Number(tw.graded ?? 0);
  const stat = graded > 0
    ? `<b>${esc(tw.mae_c)}°C</b> mean absolute error over <b>${esc(graded)}</b> graded day-max forecasts (bias ${esc(tw.bias_c)}°C)`
    : `<b>${esc(tw.predictions_recorded)}</b> predictions recorded — first grades land ~48h after each prediction (reality needs time to happen)`;
  const ts = truthSignalSummary() as any;
  const sg = Number(ts.graded ?? 0);
  const sstat = sg > 0
    ? `hit rate <b>${esc(ts.hit_rate_pct)}%</b> over <b>${esc(sg)}</b> graded calls — and if that converges to ~50%, this page will say the signal has no edge rather than bury it`
    : `<b>${esc(ts.calls_recorded)}</b> calls recorded — first grades land 24h after each call`;
  return `<div class="why">
  <div><b>This isn't just the rug scorer.</b> The same rule now applies to everything we sell. The crew-built <code>/weather/consensus</code> records the exact paid handler's day-max forecast for 6 fixed cities every UTC day, then grades it against the independent ERA5 archive: ${stat}. Live ledger: <a href="/truth/weather">/truth/weather</a>.</div>
  <div><b>Even the market calls.</b> <code>/signal</code> (bullish/bearish/neutral) and <code>/brief</code> (risk_on/risk_off) record the exact paid verdict twice a day and grade it 24h later against realized spot: ${sstat}. Fixed, recomputable hit rules in the ledger: <a href="/truth/signal">/truth/signal</a>. New endpoints must ship a truth spec — how reality will grade them — or say on this page why they can't (<a href="/truth">the doctrine</a>).</div>
  </div>`;
})()}

<h2>Method + receipts</h2>
<p class="sub" style="font-size:14.5px">Grading: <code>rugged</code> = &lt;15% of initial liquidity remains at 6h+ · <code>dumped</code> = &lt;50% of price · else <code>fine</code>. The full ledger is machine-readable at <a href="/track-record">/track-record</a> (summary) and <a href="/track-record/raw">/track-record/raw</a> (every row), and is <a href="https://github.com/wyattpalm2-eng/x402-seller/blob/main/data/track_record.jsonl">committed to a public git history</a> every 30 minutes — a tamper-evident record: we can't backdate, edit, or delete a grade without it showing.</p>

<div class="foot">
  This scorer is the code path behind the paid <code>/vet</code>, <code>/onchain/safety</code>, <code>/screen</code> and <code>/alpha/launches</code> — keyless, pay-per-call in USDC via <a href="https://github.com/coinbase/x402">x402</a>. Agent-readable docs: <a href="/llms.txt">/llms.txt</a> · <a href="/catalog">/catalog</a> · free demo: <code>/demo/vet</code> · MCP: <code>POST /mcp</code>.
</div>
</body></html>`);
}
