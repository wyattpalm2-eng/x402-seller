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
import express, { type Request, type Response } from "express";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { HTTPFacilitatorClient } from "@x402/core/server";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { createThirdwebClient } from "thirdweb";
import { facilitator as createThirdwebFacilitator } from "thirdweb/x402";
import { getReceiveAddress } from "./wallet.js";
import { cryptoPrice, stockQuote, topMarkets } from "./data.js";
import { premiumRouter, premiumRoutes, premiumCatalog } from "./premium.js";
import { cryptoRouter, cryptoRoutes, cryptoCatalog, validateOnchain } from "./crypto.js";
import { safetyRouter, safetyRoutes, safetyCatalog, validateSafety } from "./safety.js";
import { derivsRouter, derivsRoutes, derivsCatalog, validateDerivs } from "./derivs.js";
import { compositesRouter, compositesRoutes, compositesCatalog, validateVet, validateBrief } from "./composites.js";
import { discoveryRouter } from "./discovery.js";
import { recordSale, priceToUsd, stats } from "./stats.js";

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 4021);
const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`; // CAIP-2, Base Sepolia default
const FACILITATOR_URL = process.env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
const PAY_TO = getReceiveAddress();

// thirdweb facilitator (mainnet, gasless). Active only when BOTH are set.
const THIRDWEB_SECRET_KEY = process.env.THIRDWEB_SECRET_KEY?.trim();
const THIRDWEB_SERVER_WALLET = process.env.THIRDWEB_SERVER_WALLET?.trim();
const USE_THIRDWEB = !!(THIRDWEB_SECRET_KEY && THIRDWEB_SERVER_WALLET);

const IS_MAINNET = NETWORK === "eip155:8453";
const NET_LABEL = IS_MAINNET ? "Base mainnet (REAL money)" : "Base Sepolia (testnet)";
const FACILITATOR_LABEL = USE_THIRDWEB ? "thirdweb (api.thirdweb.com/v1/payments/x402)" : FACILITATOR_URL;

// ─── Go-live safety guards ────────────────────────────────────────────────
// Refuse to run a config that would advertise real-money payments against the
// testnet facilitator (or claim testnet while pointed at a mainnet facilitator).
const FAC_IS_TESTNET = /x402\.org\/facilitator/.test(FACILITATOR_URL);
if (IS_MAINNET && !USE_THIRDWEB && FAC_IS_TESTNET) {
  console.error(
    "\n  FATAL: NETWORK is Base mainnet but no real-money facilitator is configured.\n" +
      "  Set THIRDWEB_SECRET_KEY + THIRDWEB_SERVER_WALLET to settle real USDC via thirdweb.\n",
  );
  process.exit(1);
}
if (USE_THIRDWEB && THIRDWEB_SERVER_WALLET && !/^0x[a-fA-F0-9]{40}$/.test(THIRDWEB_SERVER_WALLET)) {
  console.error(`\n  FATAL: THIRDWEB_SERVER_WALLET is not a valid EVM address: ${THIRDWEB_SERVER_WALLET}\n`);
  process.exit(1);
}
if (!IS_MAINNET && USE_THIRDWEB) {
  console.warn("  WARN: thirdweb facilitator is set but NETWORK is testnet — set NETWORK=eip155:8453 to earn real USDC.");
}
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
  ...derivsCatalog,
  ...compositesCatalog,
];

// ─── x402 wiring ─────────────────────────────────────────────────────────
// thirdweb runs a hosted facilitator; its {url, createAuthHeaders} slot straight
// into @x402's HTTPFacilitatorClient. Settlement is gasless via thirdweb's server
// wallet. No secret key = keyless testnet facilitator.
function buildFacilitator(): HTTPFacilitatorClient {
  if (USE_THIRDWEB) {
    const twClient = createThirdwebClient({ secretKey: THIRDWEB_SECRET_KEY! });
    const tw = createThirdwebFacilitator({ client: twClient, serverWalletAddress: THIRDWEB_SERVER_WALLET! });
    return new HTTPFacilitatorClient({ url: tw.url, createAuthHeaders: tw.createAuthHeaders });
  }
  return new HTTPFacilitatorClient({ url: FACILITATOR_URL });
}
const facilitator = buildFacilitator();
const resourceServer = new x402ResourceServer(facilitator).register(NETWORK, new ExactEvmScheme());

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
  ...derivsRoutes,
  ...compositesRoutes,
};

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
  res.json({ payTo: PAY_TO, network: NETWORK, facilitator: FACILITATOR_URL, endpoints: CATALOG }),
);
app.get("/stats", freeRateLimit, (_req, res) => res.json(stats()));
app.get("/", freeRateLimit, (_req, res) => res.type("html").send(landingPage()));

// Bot-discovery manifests (free): /.well-known/x402.json + /.well-known/agent.json
app.use(discoveryRouter);

// Pre-paywall validation: reject malformed paid requests with 400 BEFORE the
// paywall charges, so a bot never pays for a request that can't succeed.
// Order matters: /onchain/safety has its own (EVM-only) rules, checked first.
app.use((req, res, next) => {
  const q = req.query as Record<string, any>;
  let err: string | null = null;
  if (req.path === "/onchain/safety") err = validateSafety(q);
  else if (req.path.startsWith("/onchain/")) err = validateOnchain(req.path, q);
  else if (req.path === "/derivs") err = validateDerivs(q);
  else if (req.path === "/vet") err = validateVet(q);
  else if (req.path === "/brief") err = validateBrief(q);
  if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  next();
});

// The paywall. Only the routes listed in `routes` are charged.
app.use(paymentMiddleware(routes, resourceServer));

// Paid handlers. Only run AFTER payment has settled (paywall above).
app.use(premiumRouter);
app.use(safetyRouter); // before cryptoRouter so /onchain/safety wins over any generic /onchain match
app.use(cryptoRouter);
app.use(derivsRouter);
app.use(compositesRouter);

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
});

function landingPage(): string {
  const rows = CATALOG.map(
    (e) => `<tr><td><code>${e.route}${e.params}</code></td><td>${e.price}</td><td>${e.desc}</td></tr>`,
  ).join("");
  return `<!doctype html><meta charset="utf-8"><title>x402-seller</title>
<style>
  body{font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;max-width:720px;margin:48px auto;padding:0 20px;color:#111}
  h1{font-size:22px;margin-bottom:4px} .sub{color:#666;margin-top:0}
  table{border-collapse:collapse;width:100%;margin:20px 0} td,th{border:1px solid #e3e3e3;padding:8px 10px;text-align:left}
  th{background:#fafafa} code{background:#f4f4f5;padding:1px 5px;border-radius:4px}
  .k{color:#666} .pay{word-break:break-all}
</style>
<h1>x402-seller</h1>
<p class="sub">Decision-ready market intelligence for autonomous agents. No signup, no API key —
you can't fill a form, but you can pay a cent. Verdict-first JSON, one call per decision.
Agents: fetch <code>/llms.txt</code> or <code>/.well-known/x402.json</code> and go.</p>
<table><tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>${rows}</table>
<p><span class="k">Network:</span> ${NET_LABEL}<br>
<span class="k">Pay to:</span> <span class="pay">${PAY_TO}</span><br>
<span class="k">Machine-readable catalog:</span> <code>GET /catalog</code></p>
<p class="k">Hit any paid endpoint with no payment and you get an HTTP 402 with instructions.
An x402-capable client pays automatically and retries.</p>`;
}
