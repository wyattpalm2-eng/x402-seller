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
import { cryptoRouter, cryptoRoutes, cryptoCatalog, validateOnchain } from "./crypto.js";
import { discoveryRouter } from "./discovery.js";
import { recordSale, priceToUsd, stats } from "./stats.js";

// ─── Config ──────────────────────────────────────────────────────────────
const PORT = Number(process.env.PORT || 4021);
const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`; // CAIP-2, Base Sepolia default
const FACILITATOR_URL = process.env.FACILITATOR_URL?.trim() || "https://x402.org/facilitator";
const PAY_TO = getReceiveAddress();

const IS_MAINNET = NETWORK === "eip155:8453";
const NET_LABEL = IS_MAINNET ? "Base mainnet (REAL money)" : "Base Sepolia (testnet)";

// ─── Go-live safety guards ────────────────────────────────────────────────
// Refuse to run a config that would advertise real-money payments against the
// testnet facilitator (or claim testnet while pointed at a mainnet facilitator).
const FAC_IS_TESTNET = /x402\.org\/facilitator/.test(FACILITATOR_URL);
if (IS_MAINNET && FAC_IS_TESTNET) {
  console.error(
    "\n  FATAL: NETWORK is Base mainnet but FACILITATOR_URL is the TESTNET facilitator.\n" +
      "  Buyers would be told to pay real USDC against a testnet settler.\n" +
      "  Set FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402 (+ CDP keys) first.\n",
  );
  process.exit(1);
}
if (!IS_MAINNET && !FAC_IS_TESTNET) {
  console.warn("  WARN: testnet network with a non-testnet facilitator — double-check FACILITATOR_URL.");
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
  { route: "GET /price",   price: PRICES.price,   params: "?symbol=BTC",   desc: "Spot crypto price (Coinbase)" },
  { route: "GET /stock",   price: PRICES.stock,   params: "?ticker=AAPL",  desc: "Stock/ETF quote (Yahoo Finance)" },
  { route: "GET /markets", price: PRICES.markets, params: "?limit=10",     desc: "Top crypto market snapshot (CoinGecko)" },
  ...premiumCatalog,
  ...cryptoCatalog,
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
  ...cryptoRoutes,
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

// Pre-paywall validation: reject malformed /onchain requests with 400 BEFORE the
// paywall charges, so a bot never pays for a request that can't succeed.
app.use((req, res, next) => {
  if (req.path.startsWith("/onchain/")) {
    const err = validateOnchain(req.path, req.query as Record<string, any>);
    if (err) return void res.status(400).json({ error: "bad_request", detail: err });
  }
  next();
});

// The paywall. Only the routes listed in `routes` are charged.
app.use(paymentMiddleware(routes, resourceServer));

// Paid handlers. Only run AFTER payment has settled (paywall above).
app.use(premiumRouter);
app.use(cryptoRouter);

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
    res.json(data);
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
