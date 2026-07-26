/* VENDORED VERBATIM from crew-builds/S-021/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
// S-021: /etf/flows $0.05 - daily net flow estimates for US spot BTC/ETH ETFs
// Aggregates Yahoo Finance OHLCV across 10+ symbols and computes
// volume-weighted net flow estimates using price-action math.
// Pure keyless handler -- no API keys, free data sources only.

const http = require('http');
const { web } = require('./lib/web.cjs');

const PORT = process.env.PORT || 4024;
const PRICE = '0.05';

// ---- Supported ETF symbols ----
// All are US spot crypto ETFs trading on public exchanges
const SUPPORTED = [
  // BTC spot
  'IBIT',  // iShares Bitcoin Trust (BlackRock)
  'FBTC',  // Fidelity Wise Origin Bitcoin Fund
  'ARKB',  // ARK 21Shares Bitcoin ETF
  'BITB',  // Bitwise Bitcoin ETF
  'HODL',  // VanEck Bitcoin Trust
  'BRRR',  // Valkyrie Bitcoin Fund
  'BTCO',  // Invesco Galaxy Bitcoin ETF
  // 'DEFT' REMOVED 2026-07-26: the comment claimed "Grayscale Bitcoin Mini Trust", but Yahoo
  // resolves DEFT to "DeFi Technologies Inc." -- an operating company, not a spot ETF. Its share
  // price action was being summed into total_net_flow_usd as if it were fund flow. The correct
  // Grayscale Bitcoin Mini ticker is BTC; it is left out rather than swapped in because that
  // substitution was never verified against the live feed.
  // ETH spot
  'ETHA',  // iShares Ethereum Trust (BlackRock)
  'FETH',  // Fidelity Ethereum Fund
  'ETHE',  // Grayscale Ethereum Trust
  'ETHV'   // VanEck Ethereum Trust
];

// ---- Net flow estimation model ----
// Uses daily volume + price change to estimate inflows vs outflows:
// - If close > prev_close: estimated net inflow = volume * abs(price_change_ratio) * confidence
// - If close < prev_close: estimated net outflow = -(volume * abs(price_change_ratio) * confidence)
// - Confidence factor scales with volume relative to avg volume (higher volume = more signal)
// This is an ESTIMATE, not official SEC filings data. Official N-PORT data
// is T+30 stale; this gives same-day directional flow from public market data.

function estimateNetFlow(o, h, l, c, vol, prevClose) {
  if (!c || !vol || !prevClose || prevClose === 0) return 0;
  var priceChange = c - prevClose;
  var pctChange = Math.abs(priceChange / prevClose);
  // Volume-weighted: larger volume on a move day means more flow
  // Typical ETF: ~1-3% of daily volume represents net flow
  var flowRatio = 0.02; // conservative estimate
  var netFlow = vol * priceChange / prevClose * (1 / flowRatio) * flowRatio;
  // Simpler and more defensible: net_flow ~ volume * pctChange * direction * scale
  // Where scale captures that not all volume is flow -- most is churn
  var direction = priceChange >= 0 ? 1 : -1;
  var estimatedNetFlow = direction * vol * pctChange * 0.15;
  // Scale to USD (volume is in shares, price in USD)
  // estimatedNetFlow is in share-volume units; multiply by average price for USD
  var avgPrice = (o + h + l + c) / 4;
  return Math.round(estimatedNetFlow * avgPrice);
}

// ---- Pure handler: keyless, testable, portable ----
// params: { symbols: "IBIT,FBTC,ARKB" (comma-sep), days: 5 (default) }
// Returns: { as_of, symbols_queried, total_net_flow_usd, per_symbol: [...], source, methodology }
// Returns null if no symbols or all invalid
// Throws on upstream failure
async function handler(params) {
  var symbolParam = params.symbols || params.symbol || '';
  if (!symbolParam) return null;

  var symbols = symbolParam.split(',').map(function(s) {
    return s.trim().toUpperCase();
  }).filter(function(s) {
    return SUPPORTED.indexOf(s) !== -1;
  });

  if (symbols.length === 0) return null;

  var days = parseInt(params.days || '5', 10);
  if (isNaN(days) || days < 1) days = 5;
  if (days > 30) days = 30;

  var range = days <= 5 ? '5d' : days <= 10 ? '10d' : days <= 20 ? '1mo' : '1mo';

  var results = [];
  var totalNetFlow = 0;
  var fetchDate = null;

  for (var i = 0; i < symbols.length; i++) {
    var sym = symbols[i];
    var url = 'https://query1.finance.yahoo.com/v8/finance/chart/' + sym +
      '?interval=1d&range=' + range;

    var res = await web(url);
    if (res.status !== 200) {
      // Skip this symbol but continue
      results.push({
        symbol: sym,
        error: 'Upstream returned ' + res.status,
        net_flow_usd: 0
      });
      continue;
    }

    var data;
    try { data = JSON.parse(res.body); } catch (e) {
      results.push({ symbol: sym, error: 'Parse failure', net_flow_usd: 0 });
      continue;
    }

    var result = data.chart && data.chart.result && data.chart.result[0];
    if (!result) {
      results.push({ symbol: sym, error: 'No data', net_flow_usd: 0 });
      continue;
    }

    var meta = result.meta || {};
    var timestamps = result.timestamp || [];
    var quote = result.indicators && result.indicators.quote && result.indicators.quote[0];
    if (!quote) {
      results.push({ symbol: sym, error: 'No quote data', net_flow_usd: 0 });
      continue;
    }

    var opens = quote.open || [];
    var highs = quote.high || [];
    var lows = quote.low || [];
    var closes = quote.close || [];
    var volumes = quote.volume || [];

    // Compute daily net flows for the last N days
    var dailyFlows = [];
    var symbolNetFlow = 0;
    var n = Math.min(days, closes.length);

    // Take the MOST RECENT n bars, not the oldest. The loop used to run d = 1..n from the start of
    // the series, so a caller asking days=20 received bars from 2026-06-26..2026-07-23 while as_of
    // reported 2026-07-24 -- the very bar the loop excluded. days=5 happened to look right, so the
    // defect only appeared once a buyer asked for a longer window: stale data stamped with today.
    var start = Math.max(1, closes.length - n);

    for (var d = start; d < closes.length; d++) {
      var prevClose = closes[d - 1];
      var o = opens[d], h = highs[d], l = lows[d], c = closes[d], v = volumes[d];
      if (!o || !h || !l || !c || !v || !prevClose) continue;

      var flow = estimateNetFlow(o, h, l, c, v, prevClose);
      symbolNetFlow += flow;

      var date = new Date(timestamps[d] * 1000);
      dailyFlows.push({
        date: date.toISOString().split('T')[0],
        close: Math.round(c * 100) / 100,
        volume: v,
        estimated_net_flow_usd: flow
      });
    }

    if (!fetchDate && timestamps.length > 0) {
      fetchDate = new Date(timestamps[timestamps.length - 1] * 1000);
    }

    results.push({
      symbol: sym,
      name: meta.longName || meta.shortName || sym,
      market_price: meta.regularMarketPrice || closes[closes.length - 1] || null,
      net_flow_usd: symbolNetFlow,
      daily: dailyFlows
    });

    totalNetFlow += symbolNetFlow;
  }

  if (results.length === 0) return null;

  return {
    as_of: fetchDate ? fetchDate.toISOString().split('T')[0] : new Date().toISOString().split('T')[0],
    symbols_queried: symbols,
    total_net_flow_usd: Math.round(totalNetFlow),
    per_symbol: results,
    source: 'Yahoo Finance public API (OHLCV)',
    methodology: 'Net flow estimated from daily volume-weighted price action. Conservative model: direction * volume * |%change| * 0.15 * avg_price. This is a same-day ESTIMATE, not official SEC N-PORT filings (which lag 30+ days).'
  };
}

// ---- HTTP server with x402 gate ----
const server = http.createServer(function(req, res) {
  var url = new URL(req.url, 'http://localhost:' + PORT);

  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', service: 'S-021' }));
    return;
  }

  if (url.pathname !== '/etf/flows') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/etf/flows'] }));
    return;
  }

  // x402 payment gate
  var payment = req.headers['x-payment'] || req.headers['x-payment-required'];
  var paymentAmount = parseFloat(req.headers['x-payment-amount'] || '0');
  var price = parseFloat(PRICE);
  if (!payment || paymentAmount < price) {
    res.writeHead(402, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      error: 'Payment required',
      price: PRICE,
      endpoint: '/etf/flows',
      params: 'symbols (comma-sep, e.g. IBIT,FBTC,ARKB), days (1-30, default 5)'
    }));
    return;
  }

  // Parse query params
  var symbols = url.searchParams.get('symbols') || url.searchParams.get('symbol') || '';
  var days = url.searchParams.get('days') || '5';

  handler({ symbols: symbols, days: days }).then(function(data) {
    if (data === null) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        error: 'No valid ETF symbols provided',
        supported: SUPPORTED,
        note: 'Not charged'
      }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
  }).catch(function(e) {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Upstream failure', detail: e.message }));
  });
});

// Export for testing
module.exports = { handler, estimateNetFlow, SUPPORTED, server };

if (require.main === module) {
  server.listen(PORT, function() {
    console.log('S-021 ETF flows service on port ' + PORT);
  });
}
