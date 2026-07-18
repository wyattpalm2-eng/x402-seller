/**
 * The actual product: the data your endpoints sell.
 *
 * All three sources are free and keyless, so this runs with zero setup. Swap in
 * your own higher-value data (StockFit, your calibrated weather model, private
 * scrapes) to sell something agents can't get for free — that's where real
 * demand and pricing power live.
 */

const TIMEOUT_MS = 8000;

// Stale-while-revalidate cache. A paying buyer must never block on a cold/slow
// upstream or eat a 502 when we hold any recent value:
//   fresh   (< FRESH_MS):        return cached instantly
//   stale   (< SERVE_STALE_MS):  return stale NOW, refresh in the background
//   missing (expired/cold):      fetch and await (only the first caller does)
// In-flight de-dup: concurrent callers for the same key share one upstream call
// (no thundering herd against Coinbase/Yahoo/CoinGecko). No deps, best-effort.
const FRESH_MS = 10_000;         // fresh window: serve without refreshing
const SERVE_STALE_MS = 300_000;  // serve stale up to 5 min while refreshing behind it
const _cache = new Map<string, { at: number; val: any }>();
const _inflight = new Map<string, Promise<any>>();

function _refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const existing = _inflight.get(key);
  if (existing) return existing as Promise<T>;
  const p = (async () => {
    try {
      const val = await fn();
      _cache.set(key, { at: Date.now(), val });
      return val;
    } finally {
      _inflight.delete(key);
    }
  })();
  _inflight.set(key, p);
  return p;
}

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < FRESH_MS) return hit.val;            // fresh
  if (hit && age < SERVE_STALE_MS) {                    // stale: serve now, refresh behind
    void _refresh(key, fn).catch(() => {});             // background; keep last-good on failure
    return hit.val;
  }
  return _refresh(key, fn);                             // cold/expired: must await
}

async function getJson(url: string): Promise<any> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "x402-seller/0.1 (+market-data)" },
  });
  if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
  return res.json();
}

/** Spot crypto price from Coinbase's public API. symbol like "BTC" or "ETH-USD". */
export async function cryptoPrice(symbol: string): Promise<any> {
  const s = symbol.toUpperCase().replace(/[^A-Z0-9-]/g, ""); // sanitize: no path/host injection
  if (!s) throw new Error("empty symbol");
  const pair = s.includes("-") ? s : `${s}-USD`;
  return cached(`price:${pair}`, async () => {
  const j = await getJson(`https://api.coinbase.com/v2/prices/${pair}/spot`);
  return {
    symbol: pair,
    price_usd: Number(j?.data?.amount),
    base: j?.data?.base,
    currency: j?.data?.currency,
    source: "coinbase",
    as_of: new Date().toISOString(),
  };
  });
}

/** Stock/ETF quote from Yahoo Finance (free JSON, keyless). ticker like "AAPL". */
export async function stockQuote(ticker: string): Promise<any> {
  const t = ticker.toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  if (!t) throw new Error("empty ticker");
  return cached(`stock:${t}`, async () => {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${t}?interval=1d&range=1d`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(TIMEOUT_MS),
    headers: { "user-agent": "Mozilla/5.0 (x402-seller)" },
  });
  if (!res.ok) throw new Error(`yahoo ${res.status}`);
  const j = await res.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || meta.regularMarketPrice == null) throw new Error(`unknown ticker "${ticker}"`);
  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.chartPreviousClose ?? meta.previousClose);
  return {
    symbol: meta.symbol ?? t,
    price,
    previous_close: prev,
    change: Number.isFinite(prev) ? Number((price - prev).toFixed(4)) : undefined,
    change_pct: Number.isFinite(prev) && prev ? Number((((price - prev) / prev) * 100).toFixed(3)) : undefined,
    day_high: meta.regularMarketDayHigh,
    day_low: meta.regularMarketDayLow,
    volume: meta.regularMarketVolume,
    currency: meta.currency,
    exchange: meta.exchangeName,
    source: "yahoo",
    as_of: new Date().toISOString(),
  };
  });
}

/** Top crypto market snapshot from CoinGecko's free API. */
export async function topMarkets(limit = 10): Promise<any> {
  const n = Math.min(Math.max(limit, 1), 50);
  return cached(`markets:${n}`, async () => {
  const url =
    `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd` +
    `&order=market_cap_desc&per_page=${n}&page=1&price_change_percentage=24h`;
  const arr = await getJson(url);
  return {
    count: arr.length,
    coins: arr.map((c: any) => ({
      id: c.id,
      symbol: c.symbol,
      name: c.name,
      price_usd: c.current_price,
      market_cap: c.market_cap,
      rank: c.market_cap_rank,
      change_24h_pct: c.price_change_percentage_24h,
    })),
    source: "coingecko",
    as_of: new Date().toISOString(),
  };
  });
}
