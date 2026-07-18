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
import { getReceiveAddress } from "./wallet.js";
import { cryptoPrice, stockQuote, topMarkets } from "./data.js";
import { premiumRouter, premiumRoutes, premiumCatalog } from "./premium.js";

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 4021);
const NETWORK = process.env.NETWORK?.trim() || "eip155:84532"; // Base Sepolia
const FACILITATOR_URL = process.env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
const PAY_TO = getReceiveAddress();

const IS_MAINNET = NETWORK === "eip155:8453";
const NET_LABEL = IS_MAINNET ? "Base mainnet (REAL money)" : "Base Sepolia (testnet)";

// Price per call. Cents-to-dollars strings, x402 format.
const PRICES = {
  price: process.env.PRICE_CRYPTO || "$0.001",
  stock: process.env.PRICE_STOCK || "$0.002",
  markets: process.env.PRICE_MARKETS || "$0.005",
};

const CATALOG = [
  { route: "GET /price",   price: PRICES.price,   params: "?symbol=BTC",   desc: "Spot crypto price (Coinbase)" },
  { route: "GET /stock",   price: PRICES.stock,   params: "?ticker=AAPL",  desc: "Stock/ETF quote (Yahoo Finance)" },
  { route: "GET /markets", price: PRICES.markets, params: "?limit=10",     desc: "Top crypto market snapshot (CoinGecko)" },
  ...premiumCatalog,
];

// ─── x402 wiring ─────────────────────────────────────────────────────────
const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL });
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
};

// ─── App ─────────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");

// Minimal per-IP rate limiter (60 req/min) for the FREE storefront only, so
// nobody can hammer it. Plain Map, fixed 60s window, no deps. Paid routes are
// unaffected (they're gated by payment, not this).
const FREE_LIMIT = 60;
const FREE_WINDOW_MS = 60_000;
const _hits = new Map<string, { count: number; reset: number }>();
function freeRateLimit(req: Request, res: Response, next: () => void) {
  const ip = req.ip || req.socket.remoteAddress || "unknown";
  const now = Date.now();
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
app.get("/", freeRateLimit, (_req, res) => res.type("html").send(landingPage()));

// The paywall. Only the routes above in `routes` are charged.
app.use(paymentMiddleware(routes, resourceServer));

// Premium paid handler(s). Only run AFTER payment has settled (paywall above).
app.use(premiumRouter);

// Paid handlers. These only run AFTER payment has settled.
app.get("/price", async (req, res) => deliver(res, () => cryptoPrice(String(req.query.symbol || "BTC"))));
app.get("/stock", async (req, res) => deliver(res, () => stockQuote(String(req.query.ticker || "AAPL"))));
app.get("/markets", async (req, res) => deliver(res, () => topMarkets(Number(req.query.limit || 10))));

async function deliver(res: Response, fn: () => Promise<any>) {
  try {
    res.json(await fn());
  } catch (err: any) {
    // NOTE: payment already settled here. Upstream failure = buyer paid, got an
    // error. For production, validate availability before settling or issue a
    // refund. Fine for v0.1 (free upstreams are reliable).
    res.status(502).json({ error: "upstream_unavailable", detail: err?.message ?? String(err) });
  }
}

app.listen(PORT, () => {
  console.log("");
  console.log("  ┌────────────────────────────────────────────────────────┐");
  console.log("  │  x402-seller is live                                     │");
  console.log("  └────────────────────────────────────────────────────────┘");
  console.log(`  Local:       http://localhost:${PORT}`);
  console.log(`  Network:     ${NET_LABEL}`);
  console.log(`  Facilitator: ${FACILITATOR_URL}`);
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
<p class="sub">Market data, priced per request, paid in USDC by AI agents via the x402 protocol.</p>
<table><tr><th>Endpoint</th><th>Price</th><th>Returns</th></tr>${rows}</table>
<p><span class="k">Network:</span> ${NET_LABEL}<br>
<span class="k">Pay to:</span> <span class="pay">${PAY_TO}</span><br>
<span class="k">Machine-readable catalog:</span> <code>GET /catalog</code></p>
<p class="k">Hit any paid endpoint with no payment and you get an HTTP 402 with instructions.
An x402-capable client pays automatically and retries.</p>`;
}
