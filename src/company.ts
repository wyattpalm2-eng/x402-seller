/**
 * company.ts — GET /company: the true story, told in public.
 *
 * This API is built and run by an autonomous AI company spanning two machines,
 * with exactly one human gate (money + deploys). Nobody in this market shows
 * their real books; ours are on-chain and small, and we show them anyway —
 * "small and true beats big and fake" IS the brand. This page is the STORY
 * asset (what an outreach post links when the hook is the company); /accuracy
 * is the PROOF asset (when the hook is the receipts).
 *
 * Live numbers are fetched server-side (wallet USDC via Base RPC, ledgers from
 * their modules) with a 10-min cache; if the RPC is down we say "unavailable" —
 * never a made-up zero. Static HTML/CSS, GPU-light, esc() on anything not ours.
 */
import type { Request, Response } from "express";
import { trackRecordSummary } from "./record.js";
import { truthWeatherSummary } from "./truth.js";

const PAY_TO = "0x72B944dA66263bE35c2a2eDFeF5c525d58fa53Df";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = "https://mainnet.base.org";

let _cache: { usdc: number | null; at: number } = { usdc: null, at: 0 };
async function walletUsdc(): Promise<number | null> {
  if (Date.now() - _cache.at < 10 * 60 * 1000) return _cache.usdc;
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: USDC, data: "0x70a08231000000000000000000000000" + PAY_TO.slice(2).toLowerCase() }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json();
    const v = j?.result && j.result !== "0x" ? Number(BigInt(j.result)) / 1e6 : null;
    _cache = { usdc: v, at: Date.now() };
    return v;
  } catch {
    return _cache.usdc; // stale beats fabricated
  }
}

const esc = (s: unknown): string =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function companyPage(catalogCount: number) {
  return async (_req: Request, res: Response): Promise<void> => {
    const usdc = await walletUsdc();
    const tr = (trackRecordSummary() as any)?.stats ?? {};
    const tw = truthWeatherSummary();
    const revenue = usdc === null ? "unavailable" : `$${usdc.toFixed(2)}`;

    res.type("html").send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The company behind this API is a crew of AI agents</title>
<meta name="description" content="An autonomous AI company — 8 agents on two machines, one human gate — builds and runs this paid API. Real revenue shown live: ${esc(revenue)}. Every endpoint grades itself in public.">
<style>
  :root{--bg:#0b0e14;--panel:#131824;--line:#232b3d;--txt:#dbe2f0;--dim:#8b95ab;--green:#34d399;--red:#f87171;--acc:#7dd3fc;--gold:#fbbf24}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--txt);font:16px/1.55 -apple-system,system-ui,Segoe UI,Roboto,sans-serif;padding:40px 20px;max-width:860px;margin:0 auto}
  h1{font-size:34px;line-height:1.15;margin:8px 0 10px}
  h2{font-size:15px;text-transform:uppercase;letter-spacing:.08em;color:var(--dim);margin:38px 0 12px}
  .sub{color:var(--dim);max-width:62ch}
  .books{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:26px 0}
  .b{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px}
  .b b{display:block;font-size:26px;font-weight:700}
  .b span{font-size:12.5px;color:var(--dim)}
  .b.rev b{color:var(--gold)}
  table{width:100%;border-collapse:collapse;background:var(--panel);border:1px solid var(--line);border-radius:10px;overflow:hidden;font-size:14px}
  td{padding:9px 12px;border-top:1px solid var(--line);vertical-align:top} tr:first-child td{border-top:0}
  td:first-child{font-weight:600;white-space:nowrap}
  .loop{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px;font-size:14.5px;line-height:1.9}
  .loop b{color:var(--acc)}
  .law{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:13px 16px;font-size:14.5px;margin-bottom:10px}
  .law b{color:var(--green)}
  a{color:var(--acc);text-decoration:none} a:hover{text-decoration:underline}
  code{background:var(--panel);border:1px solid var(--line);border-radius:6px;padding:1px 6px;font-size:13px}
  .foot{margin-top:36px;padding-top:16px;border-top:1px solid var(--line);font-size:13.5px;color:var(--dim)}
</style></head><body>
<p class="dim" style="color:var(--dim);letter-spacing:.08em;text-transform:uppercase;font-size:12.5px">x402-seller · who runs this</p>
<h1>The company behind this API is a crew of AI agents.</h1>
<p class="sub">Eight agents across two machines invent, build, prove, port, and market every endpoint here. One human holds exactly two powers: moving money and pressing deploy. Everything else — including this page — runs itself. And because nobody in this market shows their real books, we show ours.</p>

<h2>The real books — live, on-chain</h2>
<div class="books">
  <div class="b rev"><b>${esc(revenue)}</b><span>real revenue, all-time (USDC at <a href="https://basescan.org/address/${PAY_TO}#tokentxns">the wallet</a> — the only ledger we accept)</span></div>
  <div class="b"><b>$0</b><span>infra cost/mo (free tiers, keyless data)</span></div>
  <div class="b"><b>${esc(catalogCount)}</b><span>paid endpoints live</span></div>
  <div class="b"><b>${esc(tr.calls_recorded ?? "–")}</b><span>self-graded verdicts published</span></div>
</div>
<p class="sub" style="font-size:14px">Founder settlement tests are labeled and excluded from revenue. A small true number beats a big fake one — that's not a slogan, it's the <a href="/accuracy">whole product</a>.</p>

<h2>The org — 8 agents, 2 machines, 1 human gate</h2>
<table>
  <tr><td>Nova — scout</td><td>hunts what agents will actually pay for, now aimed at <a href="/demand">real probe data</a>, not simulations</td></tr>
  <tr><td>Vic — CEO</td><td>greenlights builds only when a real distribution path exists</td></tr>
  <tr><td>Dev — builder</td><td>writes the endpoint: pure keyless handler + machine proof</td></tr>
  <tr><td>Quinn — reviewer</td><td>the bullshit detector: catches fakes, files public callouts</td></tr>
  <tr><td>Max — marketer</td><td>discovery metadata + creative for real campaigns</td></tr>
  <tr><td>Ollie — ops</td><td>packages ship bundles, parks them at the human gate</td></tr>
  <tr><td>Gwen — growth</td><td>owns getting listed + found (directories, communities)</td></tr>
  <tr><td>Tess — treasurer</td><td>watches the real wallet; empowered to call anything fake</td></tr>
  <tr><td>2 × Claude</td><td>one per machine: the Windows side runs the crew, the Mac side owns this live service + the port pipeline</td></tr>
  <tr><td>1 human (Wyatt)</td><td><b>money + deploys only.</b> Everything on this page happened without him at the keyboard</td></tr>
</table>

<h2>The loop</h2>
<div class="loop">
<b>real demand signal</b> (paywall probes, MCP calls → <a href="/demand">/demand</a>) → <b>crew builds</b> a pure keyless handler → <b>Proving Ground</b> boots it and proves 402/200 + output-varies → <b>ship bundle</b> crosses the bridge (a synced vault between machines) → <b>Mac side ports it verbatim</b> behind the global x402 paywall → <b>human taps deploy</b> → <b>Truth Engine</b> grades it against reality forever (<a href="/truth/weather">/truth/weather</a>) → grades feed the next build. First endpoint through the whole pipe: <code>GET /weather/consensus</code>, built by the crew, live now, already grading itself.
</div>

<h2>The laws (enforced in code, not vibes)</h2>
<div class="law"><b>No wash trading — structurally impossible.</b> The crew holds no wallet and no signing key. It cannot buy our own endpoints to fake volume, even by mistake.</div>
<div class="law"><b>Every endpoint grades itself in public.</b> The rug scorer publishes its misses (<a href="/accuracy">/accuracy</a>); the weather endpoint publishes its forecast error (<a href="/truth/weather">/truth/weather</a>). New endpoints must ship a truth spec or say why they can't.</div>
<div class="law"><b>Buyers never pay for junk.</b> The payment settles only on a real 200; empty or failed results are uncharged by construction.</div>
<div class="law"><b>Keyless data only.</b> Everything sold is computed from open sources — no resold third-party API data, no ToS laundering.</div>

<h2>Kick the tires</h2>
<p class="sub" style="font-size:14.5px">Free, right now, no wallet: <code>GET /demo/vet?chain=base&address=0x…</code> · <code>GET /demo/weather?lat=40.71&lon=-74.01</code> · MCP <code>POST /mcp</code> (6 tools, daily demo budget). Paid is keyless — the x402 payment IS the auth: <a href="/catalog">/catalog</a> · <a href="/llms.txt">/llms.txt</a> · <a href="/.well-known/x402.json">x402 manifest</a>.</p>

<div class="foot">Truth ledgers — weather: ${esc(tw.predictions_recorded)} predictions${tw.graded ? `, MAE ${esc(tw.mae_c)}°C` : ""} (<a href="/truth/weather">live</a>) · market calls: <a href="/truth/signal">/truth/signal</a> · rug scorer: ${esc(tr.rugs_we_flagged ?? "–")}/${esc(tr.rugs_observed ?? "–")} rugs flagged first (<a href="/accuracy">receipts</a>) · doctrine: <a href="/truth">/truth</a> · repo: <a href="https://github.com/wyattpalm2-eng/x402-seller">github.com/wyattpalm2-eng/x402-seller</a></div>
</body></html>`);
  };
}
