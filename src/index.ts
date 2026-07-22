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
import { weatherRouter, weatherRoutes, weatherCatalog, validateWeather } from "./ported/weather-consensus.js";
import weatherHandler from "./ported/weather-consensus.handler.cjs";
import { accuracyPage } from "./accuracy.js";
import { startRecord, trackRecordSummary, rawRows } from "./record.js";
import { handleMcp, mcpMethodNotAllowed } from "./mcphttp.js";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";
import { discoveryRouter, ENDPOINTS } from "./discovery.js";
import { recordSale, priceToUsd, stats } from "./stats.js";
import { recordView, markBuyer, funnel } from "./funnel.js";

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
  price: process.env.PRICE_CRYPTO || "$0.001",
  stock: process.env.PRICE_STOCK || "$0.002",
  markets: process.env.PRICE_MARKETS || "$0.005",
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
// Trust exactly ONE proxy hop (the tunnel/PaaS in front) so req.ip is the real
// client. NOT `true` — that would let a client spoof X-Forwarded-For to dodge the
// rate limiter. Override via TRUST_PROXY if your platform chains more proxies.
app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));

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
app.get("/health", freeRateLimit, (_req, res) => res.json({ ok: true, network: NETWORK, payTo: PAY_TO }));
app.get("/catalog", freeRateLimit, (_req, res) =>
  res.json({ payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR_LABEL, endpoints: CATALOG }),
);
app.get("/stats", freeRateLimit, (_req, res) => res.json(stats()));
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
  res.type("html").send(DASHBOARD_HTML);
});

// FREE public self-graded track record — the proof a skeptical agent needs
// before paying: our scorer graded against real outcomes, misses included.
app.get("/track-record", freeRateLimit, (_req, res) => res.json(trackRecordSummary()));
// The human-shareable wedge page rendering the same ledger ("we publish our misses").
app.get("/accuracy", freeRateLimit, accuracyPage);
// Crawler hints: everything public, and point agents at the machine docs.
app.get("/robots.txt", freeRateLimit, (_req, res) =>
  res.type("text/plain").send("User-agent: *\nAllow: /\n\n# agent-readable docs\n# /llms.txt  /catalog  /openapi.json  /.well-known/x402.json  /accuracy\n"));
// Raw rows for the git snapshot Action (free; public on-chain data only, no PII).
app.get("/track-record/raw", freeRateLimit, (_req, res) => res.json({ rows: rawRows() }));

// FREE live demo: ONE real /vet per IP per hour (global daily cap). Agents
// integrate what they can test end-to-end without money — the paid calls come
// after it's wired in. The demo runs the exact paid code path, no watered-down
// output; the limiter (not a paywall) is the only difference.
const _demoLast = new Map<string, number>();
let _demoDay = "";
let _demoCount = 0;
const DEMO_PER_IP_MS = 60 * 60 * 1000;
const DEMO_DAILY_CAP = 200;
app.get("/demo/vet", freeRateLimit, async (req, res) => {
  const q = req.query as Record<string, any>;
  const err = validateVet(q);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  if (q.address === undefined)
    return void res.status(400).json({ error: "bad_request", detail: "usage: /demo/vet?chain=base&address=0x… (or chain=solana&address=<mint>)" });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _demoDay) { _demoDay = today; _demoCount = 0; _demoLast.clear(); }
  const ip = req.ip || "unknown";
  const last = _demoLast.get(ip) ?? 0;
  if (Date.now() - last < DEMO_PER_IP_MS)
    return void res.status(429).json({
      error: "demo_limit",
      detail: "1 free demo vet per hour per caller. The paid endpoint has no limits.",
      paid_endpoint: "/vet", price: process.env.PRICE_VET || "$0.05",
      retry_after_s: Math.ceil((DEMO_PER_IP_MS - (Date.now() - last)) / 1000),
    });
  if (_demoCount >= DEMO_DAILY_CAP)
    return void res.status(429).json({ error: "demo_limit", detail: "daily demo budget exhausted — the paid endpoint /vet is always available" });
  try {
    const data = await vetToken(String(q.chain ?? "base").toLowerCase().trim(), String(q.address));
    if (data == null) return void res.status(404).json({ error: "not_found", detail: "no data for that token" });
    // Consume the slot only on a SUCCESSFUL demo — a 404/502 must not lock the
    // caller out for an hour (that would sabotage demo→paid conversion).
    _demoLast.set(ip, Date.now());
    _demoCount++;
    res.json({
      ...data,
      demo: { note: "free demo — identical output to the paid /vet, limited to 1/hour", unlimited: "/vet via x402", price: process.env.PRICE_VET || "$0.05" },
    });
  } catch {
    res.status(502).json({ error: "upstream_unavailable" });
  }
});
// FREE weather demo, same thesis as /demo/vet: an agent integrates what it can
// test without money. 1 real consensus per IP per hour, small daily cap, exact
// paid output. (Own state maps — the vet demo's slots stay independent.)
const _wDemoLast = new Map<string, number>();
let _wDemoDay = "";
let _wDemoCount = 0;
app.get("/demo/weather", freeRateLimit, async (req, res) => {
  const q = req.query as Record<string, any>;
  const err = validateWeather(q);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _wDemoDay) { _wDemoDay = today; _wDemoCount = 0; _wDemoLast.clear(); }
  const ip = req.ip || "unknown";
  const last = _wDemoLast.get(ip) ?? 0;
  if (Date.now() - last < DEMO_PER_IP_MS)
    return void res.status(429).json({
      error: "demo_limit",
      detail: "1 free weather consensus per hour per caller. The paid endpoint has no limits.",
      paid_endpoint: "/weather/consensus", price: process.env.PRICE_WEATHER || "$0.03",
      retry_after_s: Math.ceil((DEMO_PER_IP_MS - (Date.now() - last)) / 1000),
    });
  if (_wDemoCount >= DEMO_DAILY_CAP)
    return void res.status(429).json({ error: "demo_limit", detail: "daily demo budget exhausted — the paid endpoint /weather/consensus is always available" });
  try {
    const data = await weatherHandler({ lat: String(q.lat), lon: String(q.lon) });
    if (data == null) return void res.status(404).json({ error: "not_found", detail: "no consensus for those coordinates" });
    // Slot consumed only on success — a 404/502 must not lock the caller out.
    _wDemoLast.set(ip, Date.now());
    _wDemoCount++;
    res.json({
      ...data,
      demo: { note: "free demo — identical output to the paid /weather/consensus, limited to 1/hour", unlimited: "/weather/consensus via x402", price: process.env.PRICE_WEATHER || "$0.03" },
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

// Pre-paywall validation: reject malformed paid requests with 400 BEFORE the
// paywall charges, so a bot never pays for a request that can't succeed.
// Order matters: /onchain/safety has its own (EVM-only) rules, checked first.
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
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  next();
});

// The paywall. Only the routes listed in `routes` are charged. Startup syncs
// supported kinds across the REDUNDANT facilitator set — any one advertising
// this network's "exact" scheme is enough, so a single flaky operator can't
// break settlement. (Total outage of all facilitators fails the deploy, and
// Render then keeps the previous healthy build — the correct failsafe.)
app.use(paymentMiddleware(routes, resourceServer));

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
  startHistory(); // begin collecting the liquidity time-series (the /onchain/liquidity moat)
  startRecord(); // begin the self-graded track record (/track-record — the public receipts)
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
  const proof =
    s.graded > 0
      ? `<p><b>Live track record</b> (self-graded, misses included — <a href="/track-record">full data</a>):
         ${s.rugs_we_flagged}/${s.rugs_observed} rugs flagged before they happened · ${s.rugs_we_missed} missed ·
         ${s.false_alarms} false alarms · ${s.graded} calls graded.</p>${catches ? `<ul>${catches}</ul>` : ""}`
      : `<p><b>Live track record</b>: grading in progress — every 30min we score fresh Base launches with the exact
         paid scorer and grade ourselves 6h later. <a href="/track-record">Watch it build</a> (${s.calls_recorded} calls recorded, ${s.pending} pending grade).</p>`;
  return `<!doctype html><meta charset="utf-8"><title>x402-seller</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#111}
  h1{font-size:22px;margin-bottom:4px} .sub{color:#666;margin-top:0}
  table{border-collapse:collapse;width:100%;margin:20px 0} td,th{border:1px solid #e3e3e3;padding:8px 10px;text-align:left}
  th{background:#fafafa} code{background:#f4f4f5;padding:1px 5px;border-radius:4px}
  .k{color:#666} .pay{word-break:break-all}
</style>
<h1>x402-seller</h1>
<p class="sub">Rug protection + decision-ready intelligence for autonomous trading agents. No signup,
no API key — pay per call in USDC (x402). Composite rug scores (static + live buy/sell simulation),
a self-collected liquidity-drain detector, EVM + Solana. Verdict-first JSON, one call per decision.
Agents: fetch <code>/llms.txt</code> or <code>/.well-known/x402.json</code> and go.
<b>Try it free right now:</b> <code>GET /demo/vet?chain=base&address=0x…</code> (1/hour, full paid output).</p>
${proof}
<table><tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>${rows}</table>
<p><span class="k">Network:</span> ${NET_LABEL}<br>
<span class="k">Pay to:</span> <span class="pay">${PAY_TO}</span><br>
<span class="k">Machine-readable catalog:</span> <code>GET /catalog</code><br>
<span class="k">Proof we're right:</span> <code>GET /track-record</code> — our rug verdicts graded against real outcomes, misses included (free)</p>
<p class="k">Hit any paid endpoint with no payment and you get an HTTP 402 with instructions.
An x402-capable client pays automatically and retries.</p>`;
}
