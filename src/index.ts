/**
 * x402-seller — a paywalled market-data API.
 *
 * Free routes:   GET /            (storefront)   GET /health   GET /catalog
 * Paid routes:   GET /price   GET /stock   GET /markets   (USDC per request via x402)
 *
 * A request to a paid route with no payment gets HTTP 402 + payment instructions.
 * The caller's wallet pays, retries, and gets the data. USDC lands in PAY_TO.
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { getReceiveAddress } from "./wallet.js";
import { cryptoPrice, stockQuote, topMarkets } from "./data.js";
import { premiumRouter, premiumRoutes, premiumCatalog } from "./premium.js";
import { cryptoRouter, cryptoRoutes, cryptoCatalog, validateOnchain } from "./crypto.js";
import { safetyRouter, safetyRoutes, safetyCatalog, validateSafety } from "./safety.js";
import { derivsRouter, derivsRoutes, derivsCatalog, validateDerivs } from "./derivs.js";
import { screenRouter, screenRoutes, screenCatalog, validateScreen } from "./screen.js";
import { compositesRouter, compositesRoutes, compositesCatalog, validateVet, validateBrief, vetToken } from "./composites.js";
import { historyRouter, historyRoutes, historyCatalog, validateLiquidity, startHistory } from "./history.js";
import { alphaRouter, alphaRoutes, alphaCatalog, validateAlpha } from "./alpha.js";
import { weatherRouter, weatherRoutes, weatherCatalog, validateWeather, gateConsensus } from "./ported/weather-consensus.js";
import weatherHandler from "./ported/weather-consensus.handler.cjs";
import { etfFlowsRouter, etfFlowsRoutes, etfFlowsCatalog, validateEtfFlows } from "./ported/etf-flows.js";
import { tokenConcentrationRouter, tokenConcentrationRoutes, tokenConcentrationCatalog, validateTokenConcentration } from "./ported/token-concentration.js";
import { wxAgRouter, wxAgRoutes, wxAgCatalog, validateWxAg } from "./ported/wx-ag.js";
import { stormRiskRouter, stormRiskRoutes, stormRiskCatalog, validateStormRisk } from "./ported/storm-risk.js";
import { walletFingerprintRouter, walletFingerprintRoutes, walletFingerprintCatalog, validateWalletFingerprint } from "./ported/wallet-fingerprint.js";
import { tokenRiskRouter, tokenRiskRoutes, tokenRiskCatalog, validateTokenRisk } from "./ported/token-risk.js";
import { accuracyPage } from "./accuracy.js";
import { MODEL_META, CALIBRATION } from "./survival.js";
import { startKeepalive, keepaliveStats } from "./keepalive.js";
import { demandReport, bumpDemo } from "./demand.js";
import { demandHistory, demandTrend, startDemandHistory } from "./demand-history.js";
import { startTruth, truthWeatherSummary, truthWeatherRaw } from "./truth.js";
import { startTruthSignal, truthSignalSummary, truthSignalRaw } from "./truth-signal.js";
import { companyPage } from "./company.js";
import { startRecord, trackRecordSummary, rawRows } from "./record.js";
import { handleMcp, mcpMethodNotAllowed } from "./mcphttp.js";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { discoveryRouter, ENDPOINTS } from "./discovery.js";
import { recordSale, priceToUsd, stats, recordSettlement } from "./stats.js";
import { recordView, markBuyer, funnel, recordMiss, wantList, setServedPaths } from "./funnel.js";
import { getUpstreamHealth, summarize } from "./upstream.js";
import { calibration, signalLift, relaunchStats, currentEraVerdictStats } from "./calibration.js";
import { bazaarRouter } from "./bazaar.js";

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 4021);
const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`; // CAIP-2, Base Sepolia default
const PAY_TO = getReceiveAddress();

const IS_MAINNET = NETWORK === "eip155:8453";
const NET_LABEL = IS_MAINNET ? "Base mainnet (REAL money)" : "Base Sepolia (testnet)";

// Facilitators (keyless, verified 2026-07-18 to advertise the network's "exact"
// scheme). MULTIPLE on mainnet for redundancy: a single small operator flaking
// must not take the service down. FACILITATOR_URL, if set, is tried first.
const MAINNET_FACILITATORS = [
  "https://facilitator.payai.network",
  "https://facilitator.xpay.sh",
  "https://facilitator.0xarchive.io",
];
const FACILITATOR_URLS: string[] = (() => {
  const override = process.env.FACILITATOR_URL?.trim();
  if (IS_MAINNET) {
    const list = override && !/x402\.org/.test(override) ? [override, ...MAINNET_FACILITATORS] : [...MAINNET_FACILITATORS];
    return [...new Set(list)];
  }
  return [override || "https://x402.org/facilitator"];
})();
const FACILITATOR_LABEL = FACILITATOR_URLS.length > 1 ? `${FACILITATOR_URLS.length} redundant (${FACILITATOR_URLS[0]}…)` : FACILITATOR_URLS[0];

if (!/^0x[a-fA-F0-9]{40}$/.test(PAY_TO)) {
  console.warn(`  WARN: PAY_TO does not look like a valid EVM address: ${PAY_TO}`);
}

// Price per call. Cents-to-dollars strings, x402 format.
const PRICES = {
  price: process.env.PRICE_CRYPTO || "$0.01",
  stock: process.env.PRICE_STOCK || "$0.01",
  markets: process.env.PRICE_MARKETS || "$0.01",
};

const CATALOG = [
  { route: "GET /price",   price: PRICES.price,   params: "?symbol=BTC",   desc: "Spot crypto price in USD" },
  { route: "GET /stock",   price: PRICES.stock,   params: "?ticker=AAPL",  desc: "Stock/ETF quote" },
  { route: "GET /markets", price: PRICES.markets, params: "?limit=10",     desc: "Top crypto market snapshot" },
  ...premiumCatalog,
  ...cryptoCatalog,
  ...safetyCatalog,
  ...historyCatalog,
  ...derivsCatalog,
  ...screenCatalog,
  ...compositesCatalog,
  ...alphaCatalog,
  ...weatherCatalog,
  ...etfFlowsCatalog,
  ...tokenConcentrationCatalog,
  ...wxAgCatalog,
  ...stormRiskCatalog,
  ...walletFingerprintCatalog,
  ...tokenRiskCatalog,
];

// ─── x402 wiring ─────────────────────────────────────────────────────────
// Register ALL configured facilitators. x402ResourceServer aggregates their
// supported kinds, so as long as ANY one advertises this network's "exact"
// scheme, paid routes work — one flaky operator can't break settlement.
const facilitators = FACILITATOR_URLS.map((url) => new HTTPFacilitatorClient({ url }));
const resourceServer = new x402ResourceServer(facilitators).register(NETWORK, new ExactEvmScheme());

function accept(price: string, description: string) {
  return {
    accepts: [{ scheme: "exact", price, network: NETWORK, payTo: PAY_TO }],
    description,
    mimeType: "application/json",
  };
}

const routes = {
  "GET /price": accept(PRICES.price, "Spot crypto price"),
  "GET /stock": accept(PRICES.stock, "Stock/ETF quote"),
  "GET /markets": accept(PRICES.markets, "Top crypto market snapshot"),
  ...premiumRoutes,
  ...cryptoRoutes,
  ...safetyRoutes,
  ...historyRoutes,
  ...derivsRoutes,
  ...screenRoutes,
  ...compositesRoutes,
  ...alphaRoutes,
  ...weatherRoutes,
  ...etfFlowsRoutes,
  ...tokenConcentrationRoutes,
  ...wxAgRoutes,
  ...stormRiskRoutes,
  ...walletFingerprintRoutes,
  ...tokenRiskRoutes,
};

// ─── Bazaar discovery extensions ─────────────────────────────────────────
// Attach a machine-readable discovery declaration (input example + JSON schema +
// output example) to every paid route, sourced from the SAME ENDPOINTS spec that
// feeds /.well-known/x402.json. @x402/express detects `extensions.bazaar` on any
// route (checkIfBazaarNeeded) and auto-registers the bazaar resource-server
// extension — the facilitator/settlement wiring below is untouched. This payload
// is what probe-crawled catalogs (PayAI /discovery/resources, CDP Bazaar) ingest,
// so listing there becomes a code artifact, not a manual submission.
for (const ep of ENDPOINTS) {
  const rc = (routes as Record<string, any>)[`GET ${ep.path}`];
  if (!rc) continue; // spec'd but not mounted (shouldn't happen; harmless if it does)
  // Example values must MATCH the declared schema types (the extension validator
  // rejects a string "40.71" against a number field), so coerce numerics.
  const input: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(ep.input)) {
    const ex = v.example ?? v.default ?? v.enum?.[0];
    if (ex === undefined) continue;
    input[k] = (v.type === "number" || v.type === "integer") && isFinite(Number(ex)) ? Number(ex) : ex;
  }
  rc.serviceName = "x402-seller";
  // NOTE: no `method` here — the declare input type omits it; the bazaar server
  // extension stamps the route's real method at enrichment time.
  rc.extensions = declareDiscoveryExtension({
    ...(Object.keys(input).length ? { input } : {}),
    inputSchema: {
      properties: Object.fromEntries(
        Object.entries(ep.input).map(([k, v]) => {
          const numeric = v.type === "number" || v.type === "integer";
          return [k, {
            type: v.type === "integer" ? "integer" : v.type === "number" ? "number" : "string",
            ...(v.enum ? { enum: v.enum } : {}),
            // defaults live as strings in the spec — coerce to the declared type
            ...(v.default !== undefined ? { default: numeric && isFinite(Number(v.default)) ? Number(v.default) : v.default } : {}),
          }];
        }),
      ),
      required: Object.entries(ep.input).filter(([, v]) => v.required).map(([k]) => k),
    },
    output: { example: ep.output_example },
  });
}

// Exact paths that are behind the paywall — used by the funnel to tell a paid
// 200 (a real buy) apart from a free-route 200.
const PAID_PATHS = new Set(Object.keys(routes).map((k) => k.split(" ")[1]));

// ─── App ─────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
// Trust the full proxy chain so req.ip is the ORIGINAL client (leftmost
// X-Forwarded-For). Render's chain includes ROTATING internal hops (10.x.x.x),
// so any fixed hop count keys per-IP logic on a proxy that changes per request
// — which silently broke both demo limiters and funnel identity (found by
// audit 2026-07-23: visitors showed as rotating 10.x internals). Leftmost-XFF
// is client-spoofable, so per-IP limits are best-effort for honest clients;
// the hard backstops are the GLOBAL daily demo caps, which a spoofer can't
// dodge. Override via TRUST_PROXY (number or "true"/"false") if rehosting.
const _tp = process.env.TRUST_PROXY?.trim();
app.set("trust proxy", _tp === undefined ? true : /^\d+$/.test(_tp) ? Number(_tp) : _tp === "true");

// Minimal security headers (JSON API — light touch, no external deps).
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  next();
});

// x402 v2 DISCOVERY FIX: @x402/express puts the payment JSON only in the base64
// PAYMENT-REQUIRED header and sends `{}` as the 402 body. But every probe-based
// directory (PayAI catalog, 402index, x402-list, x402scan auto-add, CDP Bazaar)
// parses the x402 v2 JSON *body* (x402Version, accepts[], resource) — an empty
// body makes us invisible to all of them. Mirror the header into the body.
app.use((_req, res, next) => {
  const origJson = res.json.bind(res);
  res.json = ((body?: any) => {
    if (res.statusCode === 402 && (body == null || (typeof body === "object" && !Array.isArray(body) && Object.keys(body).length === 0))) {
      const hdr = res.getHeader("payment-required");
      if (typeof hdr === "string") {
        try {
          return origJson(JSON.parse(Buffer.from(hdr, "base64").toString("utf8")));
        } catch { /* malformed header — fall through to the original body */ }
      }
    }
    return origJson(body);
  }) as typeof res.json;
  next();
});

// Demand funnel: after each response finishes, a 402 on any route = a paywall
// challenge nobody paid (a window-shopper → recordView); a 200 on a PAID path =
// a real buy (markBuyer, so that IP drops off the shopper list). Read-only,
// never touches the response, so it can't affect a real request.
app.use((req, res, next) => {
  res.on("finish", () => {
    try {
      if (res.statusCode === 402) recordView(req);
      else if (res.statusCode === 200 && PAID_PATHS.has(req.path)) markBuyer(req);
    } catch {
      /* telemetry must never break a request */
    }
  });
  next();
});

// Minimal per-IP rate limiter (60 req/min) for the FREE storefront only, so
// nobody can hammer it. Plain Map, fixed 60s window, no deps. Paid routes are
// unaffected (they're gated by payment, not this).
const FREE_LIMIT = 60;
const FREE_WINDOW_MS = 60_000;
const _hits = new Map<string, { count: number; reset: number }>();
let _lastSweep = Date.now();
function sweepHits(now: number) {
  if (now - _lastSweep < FREE_WINDOW_MS) return; // sweep at most once per window
  _lastSweep = now;
  for (const [k, v] of _hits) if (now > v.reset) _hits.delete(k); // drop expired: bound memory
}
function freeRateLimit(req: Request, res: Response, next: () => void) {
  // Paid routes must never hit this. `app.use(freeRateLimit, bazaarRouter)` mounts
  // at "/" with no path, so this middleware leaked onto EVERY later route —
  // including the paid ones, which sit behind the paywall further down the chain.
  // Two live consequences, both costing money:
  //   1. x402scan's indexer probes all 22 endpoints in one burst. It blew through
  //      60/min and 8 endpoints answered 429 instead of a 402 challenge, so they
  //      were rejected from the directory: "did not return a 402 payment challenge".
  //   2. A real buyer-agent that trips the limit gets a 429 with no `accepts`
  //      block, so it cannot even discover HOW to pay. A rate limiter in front of
  //      a paywall turns a customer away before quoting them a price.
  // Payment is the gate on paid routes; this limiter is only for the free storefront.
  if (PAID_PATHS.has(req.path)) return next();

  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
  sweepHits(now);
  let h = _hits.get(ip);
  if (!h || now > h.reset) {
    h = { count: 0, reset: now + FREE_WINDOW_MS };
    _hits.set(ip, h);
  }
  h.count++;
  if (h.count > FREE_LIMIT) {
    res.setHeader("Retry-After", Math.ceil((h.reset - now) / 1000));
    return void res.status(429).json({ error: "rate_limited", detail: "too many requests to free routes" });
  }
  next();
}

// Free routes — defined BEFORE the paywall so they never get charged.
// /health used to answer `{ ok: true }` and nothing else -- it never looked at the free APIs every
// paid endpoint resells, so it could not have known when we were about to sell degraded data. It
// said "ok" while Open-Meteo was returning a quota refusal and the weather consensus was quietly
// dropping from 3 sources to 2. `ok` now means "we can serve what we advertise", which is the only
// version of the word worth publishing.
app.get("/health", freeRateLimit, async (_req, res) => {
  const results = await getUpstreamHealth().catch(() => []);
  const up = summarize(results);
  res.json({
    ok: up.ok,
    network: NETWORK,
    payTo: PAY_TO,
    // Observable proof the box is staying awake rather than relying on a throttled external cron.
    keepalive: keepaliveStats(),
    upstreams: results,
    ...(up.degraded.length ? { degraded: up.degraded } : {}),
    ...(up.unchecked.length ? { unchecked: up.unchecked } : {}),
    note: up.note,
  });
});
app.get("/catalog", freeRateLimit, (_req, res) =>
  res.json({
    payTo: PAY_TO,
    network: NETWORK,
    facilitator: FACILITATOR_LABEL,
    // Free demos were advertised only on the human HTML page, so a machine reading
    // this catalog saw nothing but paid routes and had to spend to evaluate us.
    // Surfaced here (and in /llms.txt) so an agent can try before it buys.
    free_demos: {
      note: "No payment, no key, no signup. Runs the exact paid code path and returns the full paid output; a shared daily budget is the only limit.",
      endpoints: [
        { path: "/demo/vet", example: "/demo/vet?chain=base&address=0x4d732d1df4a73831024227afb56b01ebea76d465", paid_equivalent: "/vet" },
        { path: "/demo/weather", example: "/demo/weather?lat=40.71&lon=-74.01", paid_equivalent: "/weather/consensus" },
      ],
    },
    endpoints: CATALOG,
  }),
);
app.get("/stats", freeRateLimit, (_req, res) => res.json(stats()));
// THE WANT LIST: routes real external clients asked for and we do not have. Observed demand.
app.get("/wanted", freeRateLimit, (_req, res) => res.json(wantList()));
// Demand funnel: who looked (402) vs who bought. Optionally private: set
// FUNNEL_KEY and pass ?key=… so visitor IPs aren't world-readable.
app.get("/funnel", freeRateLimit, (req, res) => {
  const key = process.env.FUNNEL_KEY?.trim();
  if (key && String(req.query.key ?? "") !== key)
    return void res.status(403).json({ error: "forbidden", detail: "pass ?key= to view the funnel" });
  return void res.json(funnel(stats().totalPaidCalls));
});
// Mission-control dashboard (human-facing): visitors, funnel, revenue, track
// record. Static HTML that client-fetches the JSON endpoints. Optionally gated
// by FUNNEL_KEY (same as /funnel) since it surfaces visitor IPs.
const DASHBOARD_HTML = (() => {
  try {
    const p = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "dashboard.html");
    return fs.readFileSync(p, "utf8");
  } catch {
    return "<!doctype html><title>dashboard</title><p>dashboard.html not found</p>";
  }
})();
app.get("/dashboard", freeRateLimit, (req, res) => {
  const key = process.env.FUNNEL_KEY?.trim();
  if (key && String(req.query.key ?? "") !== key)
    return void res.status(403).type("html").send("<!doctype html><title>locked</title><body style='font:16px system-ui;max-width:40ch;margin:15vh auto;color:#333'><h3>Dashboard is private</h3><p>Append <code>?key=YOUR_KEY</code> to the URL.</p>");
  // A bare "0" on this page reads as "the business did nothing", when it usually means the free
  // tier restarted and wiped in-process counters (its disk does not survive a restart, so the
  // sales ledger cannot be rehydrated either). Say so on the page, with the boot time, so a zero
  // is never mistaken for a fact about the business. The durable figures are the on-chain balance
  // and the lifetime totals accumulated off-host.
  const st = stats();
  const bootedMs = Date.parse(String(st.bootedAt || "")) || Date.now();
  const upMin = Math.max(0, Math.round((Date.now() - bootedMs) / 60000));
  const banner =
    `<div style="margin:8px 12px;padding:10px 14px;border:1px solid #3a3f4b;border-radius:8px;` +
    `background:#11161f;color:#c8d0dc;font:13px/1.5 system-ui,sans-serif">` +
    `<b>Counters below are per-process.</b> This service runs on a free tier that wipes its disk on ` +
    `restart, so these reset to 0 whenever it restarts &mdash; that is the host, not the business. ` +
    `Current process started <b>${new Date(bootedMs).toISOString().replace("T", " ").slice(0, 16)}Z</b> ` +
    `(${upMin} min ago); counters cover only that window. ` +
    `The figures that never reset are <b>settled USDC on-chain</b> and the off-host lifetime ledger.` +
    `</div>`;
  res.type("html").send(DASHBOARD_HTML.replace("<body>", "<body>" + banner));
});

// FREE public self-graded track record — the proof a skeptical agent needs
// before paying: our scorer graded against real outcomes, misses included.
app.get("/track-record", freeRateLimit, (_req, res) => res.json(trackRecordSummary()));
// The human-shareable wedge page rendering the same ledger ("we publish our misses").
app.get("/accuracy", freeRateLimit, accuracyPage);
// The story asset: who runs this (the autonomous company), with the real books.
app.get("/company", freeRateLimit, companyPage(CATALOG.length));
// REAL demand signal, public-safe (no IPs/UAs): what actual callers probe.
// Also the crew's demand oracle via bridge telemetry — and it keeps working
// after /funnel gets FUNNEL_KEY-locked.
app.get("/demand", freeRateLimit, (_req, res) => res.json(demandReport()));
// Demand history: /demand resets on every redeploy, so the trend lives in a
// committed JSONL instead (same durability trick as the track record).
app.get("/demand/history", freeRateLimit, (_req, res) => res.json(demandTrend()));
app.get("/demand/history/raw", freeRateLimit, (_req, res) => res.json({ rows: demandHistory() }));
// THE TRUTH ENGINE: every endpoint grades itself against reality in public.
app.get("/truth", freeRateLimit, (_req, res) =>
  res.json({
    doctrine:
      "Every endpoint we sell grades itself against reality in public, forever. The Proving Ground proves an endpoint works once; the Truth Engine proves it stays right. Endpoints that can't be graded must say so.",
    ledgers: {
      rug_scorer: { summary: "/track-record", raw: "/track-record/raw", human: "/accuracy" },
      weather: { summary: "/truth/weather", raw: "/truth/weather/raw" },
      market_calls: { summary: "/truth/signal", raw: "/truth/signal/raw" },
    },
    tamper_evidence: "all three ledgers are git-snapshotted on a schedule — a verdict can't be rewritten after reality grades it",
    for_new_endpoints: "every ship bundle declares a TRUTH spec (how reality will grade it) or gradeable:false with a reason",
  }));
app.get("/truth/weather", freeRateLimit, (_req, res) => res.json(truthWeatherSummary()));
app.get("/truth/weather/raw", freeRateLimit, (_req, res) => res.json({ rows: truthWeatherRaw() }));
app.get("/truth/signal", freeRateLimit, (_req, res) => res.json(truthSignalSummary()));
app.get("/truth/signal/raw", freeRateLimit, (_req, res) => res.json({ rows: truthSignalRaw() }));
// Crawler hints: everything public, and point agents at the machine docs.
app.get("/robots.txt", freeRateLimit, (_req, res) =>
  res.type("text/plain").send("User-agent: *\nAllow: /\n\n# agent-readable docs\n# /llms.txt  /catalog  /openapi.json  /.well-known/x402.json  /accuracy\n"));
// Raw rows for the git snapshot Action (free; public on-chain data only, no PII).
app.get("/track-record/raw", freeRateLimit, (_req, res) => res.json({ rows: rawRows() }));

// ─── THE HONESTY SURFACE (free, deliberately) ────────────────────────────
// Every rug scanner claims high accuracy and not one publishes its misses, because publishing
// misses requires having graded yourself in public for months. We have. So the differentiator in a
// market where no claim is checkable is being the one that can be checked -- and that argument only
// lands if the numbers are free to read before anyone spends money.
//
// /calibration turns the score into a probability a buyer can put in an expected-value calculation
// ("when we say 30, tokens rug 44% of the time"). /signals reports which of our own inputs actually
// separate rugs from survivors, including the ones that turn out to be decoration. Publishing that
// second one is uncomfortable, which is rather the point.
// We serve a discovery index ourselves rather than waiting to be listed in one. Free and mounted
// before the paywall: a directory behind a paywall is a directory nobody uses.
app.use(freeRateLimit, bazaarRouter);

app.get("/calibration", freeRateLimit, (_req, res) => res.json(calibration(rawRows())));
app.get("/signals", freeRateLimit, (_req, res) => res.json(signalLift(rawRows())));
app.get("/relaunches", freeRateLimit, (_req, res) => res.json(relaunchStats(rawRows())));

// ─── THE MODEL CARD (free) ───────────────────────────────────────────────
// The finding, the validation protocol, and the coefficients' direction — published, because the
// claim "the standard rug heuristics are inverted on Base" is only worth anything if someone can
// check it. Every input below is on our public ledger at /track-record/raw.
app.get("/model", freeRateLimit, (_req, res) =>
  res.json({
    model: MODEL_META,
    the_finding:
      "On Base, the standard contract-safety heuristics are INVERTED. Across 1,022 graded tokens, " +
      "'ownership renounced' tokens rugged 77.5% of the time while NOT-renounced rugged 4.8%; tokens " +
      "carrying 5+ green flags rugged 85% against 25-63% for those with 4 or fewer; and every proxy, " +
      "mintable, vanity-address and prior-honeypot-creator token in the set survived. The cause is " +
      "structural: Base launchpads auto-renounce, auto-verify and auto-lock everything they mint, so " +
      "a full sweep of green flags is the fingerprint of a disposable memecoin, not evidence of safety.",
    why_it_matters:
      "Any scanner that scores 'renounced = safer' is selling the inverse of the outcomes on this chain. " +
      "We shipped that same inversion until 2026-08-11 and our own public ledger is what caught it.",
    horizon_warning:
      "This model predicts survival over 6 HOURS and nothing longer. We sampled tokens this ledger " +
      "graded 'fine' at 6h and re-checked them two weeks later: 12 of 12 were dead, and even among the " +
      "deepest-liquidity clean calls only 2 of 12 survived. Almost everything launched on Base dies. " +
      "The answerable question is whether the pool outlasts your position, which is what this scores.",
    calibration_out_of_sample: CALIBRATION.map((c) => ({
      predicted_rug_prob: `${c.lo}-${c.hi}`,
      n: c.n,
      actually_rugged_pct: Math.round(c.observedRug * 1000) / 10,
      actually_survived_pct: Math.round((1 - c.observedRug) * 1000) / 10,
    })),
    verify_it_yourself: {
      raw_labelled_data: "/track-record/raw",
      grading_formula: "/track-record",
      note: "Every row carries the feature vector we scored on and the outcome we later measured. Refit it and check.",
    },
    as_of: new Date().toISOString(),
  }));

// FREE live demo. Agents integrate what they can test end-to-end without money — the paid calls
// come after it's wired in. The demo runs the exact paid code path, no watered-down output; the
// limiter (not a paywall) is the only difference.
//
// 2026-07-27 — WIDENED FROM 1/HOUR, and the evidence says it was costing us adoption:
// nobody can evaluate a rug-checker at one token per hour. Deciding whether to trust a risk score
// means trying it on a handful of tokens you already know the answer for — that is a five-minute
// job, and the old limit stretched it across half a day, so every evaluator gave up before
// forming an opinion. The funnel showed it: 27 views, 3 unique callers, 0 buys.
// Meanwhile the GLOBAL cap of 200/day was running at roughly 1.5% utilisation — we were
// rationing a budget nobody was consuming. Cost risk is unchanged because the global cap is
// untouched and still the real backstop; this only stops us throttling the first honest evaluator.
const _demoUsed = new Map<string, number>();     // ip -> calls used today
let _demoDay = "";
let _demoCount = 0;
const DEMO_PER_IP_DAY = 15;                      // enough to actually form an opinion
const DEMO_DAILY_CAP = 200;                      // unchanged global backstop
app.get("/demo/vet", freeRateLimit, async (req, res) => {
  const q = req.query as Record<string, any>;
  const err = validateVet(q);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  if (q.address === undefined)
    return void res.status(400).json({ error: "bad_request", detail: "usage: /demo/vet?chain=base&address=0x… (or chain=solana&address=<mint>)" });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _demoDay) { _demoDay = today; _demoCount = 0; _demoUsed.clear(); }
  const ip = req.ip || "unknown";
  const used = _demoUsed.get(ip) ?? 0;
  if (used >= DEMO_PER_IP_DAY)
    return void res.status(429).json({
      error: "demo_limit",
      detail: `${DEMO_PER_IP_DAY} free demo vets per caller per day, and you have used them all. The paid endpoint has no limits.`,
      paid_endpoint: "/vet", price: process.env.PRICE_VET || "$0.01",
      resets: "00:00 UTC",
    });
  if (_demoCount >= DEMO_DAILY_CAP)
    return void res.status(429).json({ error: "demo_limit", detail: "daily demo budget exhausted — the paid endpoint /vet is always available" });
  try {
    const data = await vetToken(String(q.chain ?? "base").toLowerCase().trim(), String(q.address));
    if (data == null) return void res.status(404).json({ error: "not_found", detail: "no data for that token" });
    // Consume the slot only on a SUCCESSFUL demo — a 404/502 must not burn the
    // caller's allowance (that would sabotage demo→paid conversion).
    _demoUsed.set(ip, used + 1);
    _demoCount++;
    bumpDemo("vet"); // real-demand signal → /demand
    res.json({
      ...data,
      demo: {
        note: "free demo — identical output to the paid /vet, no watered-down data",
        remaining_today: DEMO_PER_IP_DAY - (used + 1),
        unlimited: "/vet via x402",
        price: process.env.PRICE_VET || "$0.01",
      },
    });
  } catch {
    res.status(502).json({ error: "upstream_unavailable" });
  }
});
// FREE weather demo, same thesis as /demo/vet: an agent integrates what it can
// test without money. 1 real consensus per IP per hour, small daily cap, exact
// paid output. (Own state maps — the vet demo's slots stay independent.)
const _wDemoUsed = new Map<string, number>();
let _wDemoDay = "";
let _wDemoCount = 0;
// Two paths, one handler. Our own /wanted demand tracker caught a caller asking for
// "/demo/weather/consensus" and 404ing: the natural guess is "/demo/" + the paid path,
// and the paid path is /weather/consensus. Anyone who reads the catalog and reaches for
// the demo makes that guess, so serve it rather than making them get it right.
app.get(["/demo/weather", "/demo/weather/consensus"], freeRateLimit, async (req, res) => {
  const q = req.query as Record<string, any>;
  const err = validateWeather(q);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _wDemoDay) { _wDemoDay = today; _wDemoCount = 0; _wDemoUsed.clear(); }
  const ip = req.ip || "unknown";
  const wUsed = _wDemoUsed.get(ip) ?? 0;
  if (wUsed >= DEMO_PER_IP_DAY)
    return void res.status(429).json({
      error: "demo_limit",
      detail: `${DEMO_PER_IP_DAY} free weather consensus calls per caller per day, and you have used them all. The paid endpoint has no limits.`,
      paid_endpoint: "/weather/consensus", price: process.env.PRICE_WEATHER || "$0.01",
      resets: "00:00 UTC",
    });
  if (_wDemoCount >= DEMO_DAILY_CAP)
    return void res.status(429).json({ error: "demo_limit", detail: "daily demo budget exhausted — the paid endpoint /weather/consensus is always available" });
  try {
    const data = gateConsensus(await weatherHandler({ lat: String(q.lat), lon: String(q.lon) }));
    if (data == null) return void res.status(404).json({ error: "not_found", detail: "fewer than 2 weather sources reachable for those coordinates right now — a consensus of one is not a consensus, try again later" });
    // Slot consumed only on success — a 404/502 must not lock the caller out.
    _wDemoUsed.set(ip, wUsed + 1);
    _wDemoCount++;
    bumpDemo("weather"); // real-demand signal → /demand
    res.json({
      ...data,
      demo: { note: "free demo — identical output to the paid /weather/consensus", remaining_today: DEMO_PER_IP_DAY - (wUsed + 1), unlimited: "/weather/consensus via x402", price: process.env.PRICE_WEATHER || "$0.01" },
    });
  } catch {
    res.status(502).json({ error: "upstream_unavailable" });
  }
});
app.get("/", freeRateLimit, (_req, res) => res.type("html").send(landingPage()));

// Remote MCP server (free, before the paywall): POST /mcp (Streamable HTTP).
// Lets Claude/Cursor use x402-seller directly + makes it official-registry
// listable as a remote server. Its own JSON body parser (the rest of the API
// is GET-only, so no global body parsing).
app.post("/mcp", express.json({ limit: "512kb" }), handleMcp);
app.get("/mcp", mcpMethodNotAllowed);
app.delete("/mcp", mcpMethodNotAllowed);

// Bot-discovery manifests (free): /.well-known/x402.json + /.well-known/agent.json
app.use(discoveryRouter);

// Request validation lives AFTER the paywall now -- see validateParams below, registered between
// the payment middleware and the paid handlers. It used to run here, in front of the paywall, with
// the reasonable-sounding intent "so a bot never pays for a request that can't succeed".
//
// The cost was much larger than the benefit. A discovery crawler fetches the URLs listed in our
// manifest exactly as written, with no query string, and got 400 instead of 402 -- so 8 of our 22
// endpoints (36% of the catalog) read to every indexer as broken or free. Measured against
// production: /weather/consensus, /wx/storm, /wx/ag/{lat}/{lon}, /token/risk/{address},
// /wallet/fingerprint/{address}, /token/concentration/{address}, /onchain/token and /etf/flows.
// For a business whose only real problem is that nobody can find it, that is an expensive trade.
//
// Moving it is safe, and this was checked in the library source rather than assumed:
// @x402/express/dist/esm/index.mjs:257 does `if (res.statusCode >= 400) { await
// cancellationDispatcher.cancel({ reason: "handler_failed" }) ... return }` -- so a paid request
// that fails validation returns 400 and settlement is CANCELLED. The buyer is not charged. The
// original protective intent is preserved by the library; we were paying for it twice.
// The paywall. Only the routes listed in `routes` are charged. Startup syncs
// supported kinds across the REDUNDANT facilitator set — any one advertising
// this network's "exact" scheme is enough, so a single flaky operator can't
// break settlement. (Total outage of all facilitators fails the deploy, and
// Render then keeps the previous healthy build — the correct failsafe.)
// ─── HEAD MUST NOT BYPASS THE PAYWALL ────────────────────────────────────
// Verified 2026-07-25, two library behaviours combining into a free-compute + phantom-revenue bug:
//   1. express/lib/router/route.js:113  `if (method === 'head' && !this.methods['head']) method = 'get'`
//      -- Express dispatches HEAD to the GET handler.
//   2. @x402/core matches routes verb-sensitively:
//      `route.regex.test(path) && (route.verb === "*" || route.verb === upperMethod)`
//      Every paid route is keyed "GET /x", so a HEAD never matches, the paywall answers
//      "no-payment-required", and @x402/express calls next().
// Net effect: HEAD /price ran the paid handler (real upstream API calls, on our budget), returned
// 200, and called recordSale() -- inventing revenue that never existed. That is where the
// "delivered but never settled" backlog came from; the deliveries were partly our own phantom.
// No response body is sent for HEAD, so paid DATA never leaked -- but the compute and the
// accounting both did. 405 is the honest answer: x402 payment is defined for GET here.
// 2026-07-26: the guard below was written with exact string equality and that was not enough.
// Express matches routes CASE-INSENSITIVELY and tolerates a trailing slash, so `HEAD /price/`,
// `HEAD /Price` and `HEAD /PRICE` all missed this check, missed the x402 route table (which is
// keyed "GET /price" and matched verb-sensitively), got dispatched HEAD->GET by Express, ran the
// paid handler and called recordSale(). Verified against production: /price -> 405, but /price/,
// /Price, /PRICE and /onchain/Trending all returned 200.
//
// The cost was not leaked data -- HEAD sends no body -- it was a fabricated business. Every
// crawler and uptime monitor on the internet minted a "paid delivery", which is where all 40
// lifetime deliveries and the entire "delivered but never settled" backlog came from. The crew
// then spent days diagnosing PayAI over a payment that had never happened.
//
// Normalize both sides the way the router does before comparing.
const normPath = (s: string) => s.toLowerCase().replace(/\/+$/, "") || "/";

app.use((req, res, next) => {
  if (req.method !== "HEAD") return next();
  const p = normPath(req.path);
  // reuse the existing PAID_PATHS set; handle both exact routes and /:param routes
  const isPaid = [...PAID_PATHS].some((rp) => {
    const r = normPath(rp);
    const base = normPath(rp.split("/:")[0]);
    return rp.includes("/:") ? (p === base || p.startsWith(base + "/")) : p === r;
  });
  if (!isPaid) return next();
  res.setHeader("Allow", "GET");
  return void res.status(405).json({
    error: "method_not_allowed",
    detail: "Paid endpoints are GET-only. HEAD cannot carry an x402 payment, so it is refused rather than served free.",
  });
});

app.use(paymentMiddleware(routes, resourceServer));

// ─── SETTLEMENT RECEIPTS ─────────────────────────────────────────────────
// The facilitator reports the settle outcome back to us in the `payment-response` header --
// the same header src/client.ts decodes to print "Settlement: ...". Until now the server set
// that header and never looked at it, so a delivery that never settled was indistinguishable
// from one that did. That is how six real signed authorizations turned into $0.053 "revenue"
// and 0.000000 USDC on 2026-07-25.
//
// This hooks response completion (after the paywall and the handler have run), reads the header
// we are about to send, and records what actually happened. It is observation only: it never
// blocks, never mutates the response, and never throws into the request path.
app.use((req, res, next) => {
  res.on("finish", () => {
    try {
      const paid = !!(req.get("x-payment") || req.get("payment-signature"));
      const routeKey = `${req.method} ${req.path}`;

      // This observer was structurally incapable of ever reporting a settlement FAILURE, which is
      // why settlement.failed sat at 0 forever and lastError could only ever say "no settle header".
      // @x402/express turns every settle failure into a non-200 (settle failed -> 402,
      // FacilitatorResponseError -> 502, anything else -> 402 with an empty body), and the old code
      // returned early on any non-200. So the one case worth recording was the one case excluded.
      // The crew read that permanently-fixed string, concluded "PayAI is broken", and drafted a bug
      // report against a facilitator we have never once actually reached.
      if (res.statusCode !== 200) {
        if (paid && (res.statusCode === 402 || res.statusCode === 502)) {
          recordSettlement(routeKey, false, undefined,
            `settlement rejected: the payment verified but the facilitator did not settle (HTTP ${res.statusCode} returned to the buyer)`);
        }
        return;                                            // otherwise nothing was delivered
      }
      // A 200 with no payment header at all is not a sale. Before the HEAD normalization fix this
      // fired constantly on crawler traffic and invented the entire delivery backlog.
      if (!paid) return;
      // The @x402/express middleware buffers the body, calls processSettlement, and on SUCCESS does
      // `Object.entries(settleResult.headers).forEach(([k,v]) => res.setHeader(k,v))`. The core
      // constant is "PAYMENT-RESPONSE" with an "X-PAYMENT-RESPONSE" v1 fallback, so try both --
      // getHeader is case-insensitive but the x- prefix is a different header entirely.
      const raw = res.getHeader("payment-response") ?? res.getHeader("x-payment-response");
      if (!raw) {
        // "no header" was ambiguous: it could mean settlement never ran, or that we looked in the
        // wrong place. Record what headers ARE present so the next real payment is diagnostic
        // instead of another guess. Header NAMES only -- never values, which can carry payer data.
        const names = Object.keys(res.getHeaders() || {}).sort().join(",").slice(0, 300);
        return void recordSettlement(routeKey, undefined, undefined, "no settle header; present: [" + names + "]");
      }

      // The header is base64 JSON in x402 v2. Decode defensively -- an unknown shape must be
      // reported as unknown, never optimistically counted as settled.
      let payload: any = null;
      try { payload = JSON.parse(Buffer.from(String(raw), "base64").toString("utf8")); }
      catch { try { payload = JSON.parse(String(raw)); } catch { /* leave null */ } }

      if (!payload || typeof payload !== "object") {
        return void recordSettlement(routeKey, undefined, undefined, "payment-response present but undecodable");
      }
      const ok = payload.success === true || payload.settled === true;
      const tx = payload.transaction || payload.txHash || payload.transactionHash;
      const err = payload.errorReason || payload.error || payload.reason;
      recordSettlement(routeKey, ok ? true : payload.success === false ? false : undefined, tx, err);
    } catch { /* never let bookkeeping break a paid response */ }
  });
  next();
});

// Reject malformed paid requests -- but only once the paywall has had its say, so an unpaid
// request always sees 402 and a crawler can tell that this endpoint exists and costs money.
// A paid request with bad params still gets a clear 400, and @x402/express cancels settlement on
// any 4xx, so the buyer is not charged for it.
app.use((req, res, next) => {
  const q = req.query as Record<string, any>;
  let err: string | null = null;
  if (req.path === "/onchain/safety") err = validateSafety(q);
  else if (req.path === "/onchain/liquidity") err = validateLiquidity(q);
  else if (req.path.startsWith("/onchain/")) err = validateOnchain(req.path, q);
  else if (req.path === "/derivs") err = validateDerivs(q);
  else if (req.path === "/screen") err = validateScreen(q);
  else if (req.path === "/vet") err = validateVet(q);
  else if (req.path === "/brief") err = validateBrief(q);
  else if (req.path === "/alpha/launches") err = validateAlpha(q);
  else if (req.path === "/weather/consensus") err = validateWeather(q);
  else if (req.path === "/etf/flows") err = validateEtfFlows(q, req.path);
  else if (req.path.startsWith("/token/concentration/")) err = validateTokenConcentration(q, req.path);
  else if (req.path.startsWith("/wx/ag/")) err = validateWxAg(q, req.path);
  else if (req.path === "/wx/storm") err = validateStormRisk(q, req.path);
  else if (req.path.startsWith("/wallet/fingerprint/")) err = validateWalletFingerprint(q, req.path);
  else if (req.path.startsWith("/token/risk/")) err = validateTokenRisk(q, req.path);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  next();
});

// Paid handlers. Only run AFTER payment has settled (paywall above).
app.use(premiumRouter);
app.use(safetyRouter); // before cryptoRouter so /onchain/safety wins over any generic /onchain match
app.use(historyRouter); // /onchain/liquidity
app.use(cryptoRouter);
app.use(derivsRouter);
app.use(screenRouter);
app.use(compositesRouter);
app.use(alphaRouter);
app.use(weatherRouter);
app.use(etfFlowsRouter);
app.use(tokenConcentrationRouter);
app.use(wxAgRouter);
app.use(stormRiskRouter);
app.use(walletFingerprintRouter);
app.use(tokenRiskRouter);

// Paid handlers. These only run AFTER payment has settled.
app.get("/price", (req, res) => {
  const symbol = String(req.query.symbol || "BTC");
  return deliver(res, "GET /price", priceToUsd(PRICES.price), symbol, () => cryptoPrice(symbol));
});
app.get("/stock", (req, res) => {
  const ticker = String(req.query.ticker || "AAPL");
  return deliver(res, "GET /stock", priceToUsd(PRICES.stock), ticker, () => stockQuote(ticker));
});
app.get("/markets", (req, res) => {
  const limit = Number(req.query.limit || 10);
  return deliver(res, "GET /markets", priceToUsd(PRICES.markets), `top${limit}`, () => topMarkets(limit));
});

async function deliver(
  res: Response,
  route: string,
  priceUsd: number,
  symbol: string | undefined,
  fn: () => Promise<any>,
) {
  try {
    const data = await fn(); // SWR cache makes this near-instant once warm
    // Never bill for an empty payload. Source fns throw on junk (→ catch below),
    // this is the belt-and-braces guard mirroring serve() in crypto.ts.
    if (data == null) return void res.status(502).json({ error: "upstream_unavailable" });
    recordSale(route, priceUsd, symbol); // count only successful deliveries
    res.json({ ...data, source: "x402-seller" }); // don't reveal the upstream supply chain
  } catch (err: any) {
    // Payment settled but the upstream failed. The SWR cache serves last-good for
    // 5 min, so this only fires on a truly cold+dead upstream. Not counted as a sale.
    console.error(`[deliver] ${route} error:`, err?.message ?? err); // detail stays server-side
    res.status(502).json({ error: "upstream_unavailable" });
  }
}

// ─── THE WANT LIST ────────────────────────────────────────────────────────
// LAST route: anything that matched nothing above is a client asking for something we do not
// sell. Browsers and vulnerability scanners are filtered out in recordMiss; what remains is an
// external agent naming a product we do not have. That is the only demand signal here that
// nobody in this company invented. Read it at GET /wanted.
// ─── DISCOVERY ALIASES + PREFLIGHT ────────────────────────────────────────
// A real crawler (agent-tools.cloud-crawler/0.1) requested /.well-known/x402 — WITHOUT the .json —
// five times and got a 404 every time. It was trying to index us and could not. The extension is
// not universal across x402 clients, so serve both spellings. Same for the agent card.
// Tell the want list which paths we genuinely serve, so a method mismatch is never mistaken for
// unmet demand. Derived from the real route table + the free routes, so it cannot drift.
setServedPaths([
  ...Object.keys(routes).map((k) => k.split(" ")[1]),
  "/health", "/catalog", "/stats", "/funnel", "/wanted", "/dashboard", "/track-record",
  "/accuracy", "/demand", "/llms.txt", "/.well-known/x402.json", "/.well-known/agent.json",
  "/.well-known/x402", "/.well-known/agent", "/mcp", "/company", "/truth", "/favicon.ico",
  "/model", "/calibration", "/signals", "/relaunches",
]);


// CORS preflight and method errors were falling through to the 404 handler, which recorded them as
// "demand for a product we do not sell" — that is how /price, an endpoint we have always served,
// became the top entry on the want list. Answer preflight properly and say which verb is allowed.
app.options("*", (req, res) => {
  res.setHeader("Allow", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "X-PAYMENT, Content-Type");
  res.status(204).end();
});

app.use((req, res) => {
  recordMiss(req);
  res.status(404).json({
    error: "not_found",
    detail: "No such endpoint. GET /catalog lists everything we sell.",
    catalog: "/catalog",
  });
});
app.listen(PORT, () => {
  console.log("");
  console.log("  ┌────────────────────────────────────────────────────────┐");
  console.log("  │  x402-seller is live                                     │");
  console.log("  └────────────────────────────────────────────────────────┘");
  console.log(`  Local:       http://localhost:${PORT}`);
  console.log(`  Network:     ${NET_LABEL}`);
  console.log(`  Facilitator: ${FACILITATOR_LABEL}`);
  console.log(`  Paid to:     ${PAY_TO}`);
  console.log("");
  console.log("  Paid endpoints:");
  for (const e of CATALOG) console.log(`    ${e.price.padEnd(8)} ${e.route}${e.params}`);
  console.log("");
  console.log(`  Try the paywall:  curl -i http://localhost:${PORT}/price?symbol=BTC`);
  console.log("  (expect HTTP 402 + payment instructions)\n");
  startKeepalive(); // keep Render's free instance awake — a sleeping box loses every agent that probes it
  startHistory(); // begin collecting the liquidity time-series (the /onchain/liquidity moat)
  startRecord(); // begin the self-graded track record (/track-record — the public receipts)
  startTruth(); // begin the truth engine (every endpoint grades itself — /truth/weather)
  startTruthSignal(); // second enrollment: /signal + /brief grade their market calls (/truth/signal)
  startDemandHistory(); // snapshot /demand to a committed JSONL so the trend survives redeploys
});

function landingPage(): string {
  const rows = CATALOG.map(
    (e) => `<tr><td><code>${e.route}${e.params}</code></td><td>${e.price}</td><td>${e.desc}</td></tr>`,
  ).join("");
  // Live proof block: real self-graded track record, rendered server-side.
  // SECURITY: token symbols come from permissionless on-chain metadata
  // (attacker-chosen), so every interpolated value MUST be HTML-escaped or a
  // malicious token symbol becomes stored XSS on this page.
  const esc = (v: unknown) =>
    String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));
  const tr = trackRecordSummary();
  const s = tr.stats;
  const catches = tr.recent_graded
    .filter((r: any) => (r.our_verdict === "danger" || r.our_verdict === "warning") && r.outcome === "rugged")
    .slice(0, 5)
    .map((r: any) => `<li><code>${esc(r.token ?? String(r.address).slice(0, 10))}</code> — flagged <b>${esc(r.our_verdict)}</b> (risk ${esc(r.risk_score)}), then rugged: ${esc(r.liquidity_remaining_pct ?? "?")}% of liquidity left after ${esc(r.graded_after_h)}h</li>`)
    .join("");
  // Headline the DISCRIMINATION, not the recall. "431/530 rugs flagged" reads like a win but we
  // flag ~90% of everything, so that recall is worse than flagging at random — a true number that
  // misleads. What a buyer needs is whether a flag beats a clear, and when it does not we say so
  // on the front page rather than let the flattering number stand.
  // Use flagged_total / ok_total, which count both sides over the SAME predicate. Do NOT rebuild
  // these from rugs_we_flagged + false_alarms: those use different predicates (warning+danger vs
  // danger-only) and the mismatch silently drops every warning that came out fine, which flatters
  // the ratio and hides an inversion. That mistake shipped here once already.
  // Read the CURRENT scoring era only. Pooling eras here published a number about a
  // scorer we retired on 2026-07-25: on 2026-07-29 the pooled figure said our "ok"
  // verdict rugged 80.2% over 1,474 calls, but 940 of those calls belonged to the
  // replaced model. That is the precise error ERAS in calibration.ts exists to stop,
  // and it was costing us on the storefront — self-flagellating with a stale stat.
  const _era = currentEraVerdictStats(rawRows());
  const _tf = _era.flagged_total;
  const _okT = _era.ok_total;
  const _pFlag = _tf > 0 ? (100 * _era.flagged_rugged) / _tf : 0;
  const _pClear = _okT > 0 ? (100 * _era.ok_rugged) / _okT : 0;
  // Only call it inverted when BOTH buckets are thick enough to mean anything —
  // an "ok" bucket of three rows can invert on noise alone.
  const _inverted = _era.reportable && _pClear > _pFlag;
  // A brand-new scoring era legitimately has zero graded calls until six hours of reality have
  // elapsed. Printing a bare "0 calls graded" reads as though we have no evidence at all, when the
  // evidence is the 1,022 rows the new model was fit and validated on. Say which it is.
  const _eraFresh = _era.graded === 0;
  const proof =
    s.graded > 0
      ? `<p><b>Live track record</b> (self-graded, misses included — <a href="/track-record">full data</a>):
         ${_eraFresh
           ? `the survival model went live 2026-08-11 and its first calls need 6h of elapsed reality before they can be
              graded, so this era shows 0 graded so far — deliberately, rather than inheriting the retired scorer's
              numbers. Its <a href="/model">walk-forward validation on the ${MODEL_META.trained_rows} rows already in the ledger</a>
              is the evidence until then, and this counter is the one that will check it.`
           : `${_era.graded} calls graded on the scorer running right now${_era.reportable ? ` · flagged tokens rugged ${_pFlag.toFixed(1)}% · tokens we called ok rugged ${_pClear.toFixed(1)}%` : ` · ${_era.ok_total} graded "ok" calls so far, too few to quote a rate honestly`}.`}
         <span class="k">(${s.graded} graded across all scorer versions; we report the current one, because pooling would average over our own fixes.)</span></p>
         ${_inverted
           ? `<p style="border:1px solid #a33;background:#2a1414;border-radius:8px;padding:10px 12px">
              <b style="color:#ff8a8a">⚠ Our score is currently INVERTED — do not trade on the "ok" verdict.</b>
              A token we call ok rugs ${_pClear.toFixed(1)}% of the time versus ${_pFlag.toFixed(1)}% for one we flag, so a clear
              from us is presently more dangerous than a warning. Cause diagnosed and fixes deployed 2026-07-27;
              they need 6+ hours of elapsed reality to grade. <a href="/accuracy">The full working is public.</a>
              We would rather show you this than sell you a flattering recall number.</p>`
           : ""}${catches ? `<ul>${catches}</ul>` : ""}`
      : `<p><b>Live track record</b>: grading in progress — every 30min we score fresh Base launches with the exact
         paid scorer and grade ourselves 6h later. <a href="/track-record">Watch it build</a> (${s.calls_recorded} calls recorded, ${s.pending} pending grade).</p>`;
  const truthLinks = `<p><b>The Truth Engine</b> — every endpoint here grades itself against reality, in public:
    <a href="/accuracy">rug-scorer receipts</a> · <a href="/truth/weather">weather forecasts</a> ·
    <a href="/truth/signal">market calls</a> · <a href="/company">who runs this (an AI crew) + the real books</a>.</p>`;
  return `<!doctype html><meta charset="utf-8"><title>x402-seller</title>
<style>
  /* Themed via variables because the page previously set color:#111 and no background: a visitor in
     dark mode got near-black text on the browser's near-black canvas and the storefront was
     effectively blank. Both schemes are now explicit. */
  :root{
    --bg:#fff; --fg:#111; --muted:#666; --line:#e3e3e3; --thead:#fafafa; --code:#f4f4f5;
    --callout-bg:#fdf8e8; --callout-line:#d9c48a; --rule:#ccc; --link:#0b5cd5;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --bg:#111315; --fg:#e8e8e8; --muted:#9aa0a6; --line:#2c3034; --thead:#191c1f; --code:#1e2226;
      --callout-bg:#241f10; --callout-line:#7a6a35; --rule:#3a3f44; --link:#7fb2ff;
    }
  }
  html{background:var(--bg)}
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:var(--fg);background:var(--bg)}
  h1{font-size:22px;margin-bottom:4px} .sub{color:var(--muted);margin-top:0}
  a{color:var(--link)}
  table{border-collapse:collapse;width:100%;margin:20px 0} td,th{border:1px solid var(--line);padding:8px 10px;text-align:left}
  th{background:var(--thead)} code{background:var(--code);padding:1px 5px;border-radius:4px}
  .k{color:var(--muted)} .pay{word-break:break-all}
  .callout{border:1px solid var(--callout-line);background:var(--callout-bg);border-radius:8px;padding:14px 16px;margin:20px 0}
  .caveat{border-left:3px solid var(--rule);padding-left:12px;color:var(--muted)}
</style>
<h1>x402-seller</h1>
<p class="sub">Token survival probabilities for autonomous trading agents. No signup, no API key —
pay per call in USDC (x402). One call returns a calibrated probability that a pool will still be
there in six hours, with the out-of-sample hit rate for that confidence band attached.
Agents: fetch <code>/llms.txt</code> or <code>/.well-known/x402.json</code> and go.
<b>Try it free right now:</b> <code>GET /demo/vet?chain=base&address=0x…</code> (15 free per day, full paid output).</p>

<div class="callout">
<b>The standard rug heuristics are backwards on Base — and we have 1,022 graded outcomes showing it.</b>
<p style="margin:8px 0 0">Every scanner scores "ownership renounced, source verified, LP locked" as
<i>safer</i>. On our own ledger those tokens rugged <b>77.5%</b> of the time, while tokens that were
<b>not</b> renounced rugged <b>4.8%</b>. Tokens carrying 5+ green flags rugged 85%. The cause is
structural, not mysterious: Base launchpads auto-renounce, auto-verify and auto-lock everything they
mint, so a full sweep of green flags is the fingerprint of a disposable memecoin, not evidence of
safety.</p>
<p style="margin:8px 0 0">We shipped that same inverted score until 2026-08-11. Our public ledger is
what caught it — it graded our own scorer at <b>AUC 0.545</b>, a coin flip. It is now replaced by a
model fit on those outcomes and validated walk-forward at <b>AUC 0.954</b> across 6 chronological
folds. <a href="/model">The finding, the protocol and the calibration table</a> ·
<a href="/track-record/raw">the raw labelled data, so you can refit it yourself</a>.</p>
</div>

<p class="caveat"><b>What we will not claim.</b>
This predicts survival over <b>six hours</b>, which is the horizon an execution agent needs, and
nothing longer. We pulled tokens this ledger graded "fine" at 6h and re-checked them two weeks later:
<b>12 of 12 were dead</b>, and even among the deepest-liquidity clean calls only 2 of 12 survived.
Almost everything launched on Base dies eventually. Anyone selling you a durable "safe" rating for
this asset class is selling something they have not measured.</p>
${proof}
${truthLinks}
<table><tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>${rows}</table>
<p><span class="k">Network:</span> ${NET_LABEL}<br>
<span class="k">Pay to:</span> <span class="pay">${PAY_TO}</span><br>
<span class="k">Machine-readable catalog:</span> <code>GET /catalog</code><br>
<span class="k">Proof we're right:</span> <code>GET /track-record</code> — our rug verdicts graded against real outcomes, misses included (free)</p>
<p class="k">Hit any paid endpoint with no payment and you get an HTTP 402 with instructions.
An x402-capable client pays automatically and retries.</p>`;
}
