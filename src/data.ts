/**
 * The actual product: the data your endpoints sell.
 *
 * All three sources are free and keyless, so this runs with zero setup. Swap in
 * your own higher-value data (StockFit, your calibrated weather model, private
 * scrapes) to sell something agents can't get for free — that's where real
 * demand and pricing power live.
 */

const TIMEOUT_MS = 8000;

// Tiny in-memory TTL cache so paid buyers rarely hit a dead/slow upstream and
// repeat calls (same args, within TTL) return instantly. No deps, best-effort.
const CACHE_TTL_MS = 10_000;
const _cache = new Map<string, { at: number; val: any }>();

async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.val;
  const val = await fn();
  _cache.set(key, { at: Date.now(), val });
  return val;
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
  const s = symbol.toUpperCase();
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
