/* VENDORED VERBATIM from crew-builds/S-022/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
// S-022: /yield/surface $0.01 -- risk-adjusted yield surface across Base+Eth lending/DEX/restaking
// Keyless handler: defillama protocol TVL + yields.llama.fi real pool data
// NOTE: yields.llama.fi/pools returns >5MB JSON, too large for toolshed/web.js cap.
// We fetch directly with a 15MB cap and abort controller. This is a known safe public API.

const express = require('express');
const { chainTVL } = require('./lib/defillama.cjs');

const app = express();
const PORT = 4024;

// --- Real yield data source ---
async function fetchYieldPools(chainFilter) {
  // yields.llama.fi/pools is huge (>100MB full). Use per-chain calls to stay under cap.
  var chains = chainFilter === 'base' ? ['Base'] : chainFilter === 'eth' || chainFilter === 'ethereum' ? ['Ethereum'] : ['Base', 'Ethereum'];
  var allPools = [];
  for (var i = 0; i < chains.length; i++) {
    var url = 'https://yields.llama.fi/pools?chain=' + encodeURIComponent(chains[i]);
    var ctl = new AbortController();
    var t = setTimeout(function() { ctl.abort(); }, 20000);
    try {
      var r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'OpenClaw-Crew/1.0' } });
      if (!r.ok) throw new Error('yields API for ' + chains[i] + ': HTTP ' + r.status);
      var text = await r.text();
      // Per-chain responses should be much smaller; cap at 15MB safety
      if (text.length > 15 * 1024 * 1024) throw new Error('yields API response too large for ' + chains[i]);
      var data = JSON.parse(text);
      var pools = (data.data || []).filter(function(p) {
        return p.tvlUsd && p.tvlUsd > 0;
      }).map(function(p) {
        return {
          project: p.project,
          symbol: p.symbol,
          chain: p.chain,
          apy: p.apy || 0,
          tvlUsd: p.tvlUsd || 0,
          ilRisk: p.ilRisk || 'no',
          exposure: p.exposure || 'unknown',
          stablecoin: !!p.stablecoin
        };
      });
      // After fetch, enforce strict chain filtering so base vs eth are different
      pools = pools.filter(function(p) {
        var pChain = (p.chain || '').toLowerCase();
        if (chains[i].toLowerCase() === 'base') return pChain === 'base';
        if (chains[i].toLowerCase() === 'ethereum') return pChain === 'ethereum' || pChain === 'eth';
        return true;
      });
      allPools = allPools.concat(pools);
    } finally { clearTimeout(t); }
  }
  return allPools.sort(function(a, b) { return b.tvlUsd - a.tvlUsd; }).slice(0, 15);
}

// --- Risk-adjusted computation ---
// Impermanent-loss risk weight + smart-contract risk score from TVL/stability
function computeRiskAdjusted(ranking, params) {
  const minTvl = parseInt(params.minTvl || '0');
  var results = ranking.filter(p => p.tvlUsd >= minTvl);
  // Apply IL adjustment: stablecoin pools get lower risk weight
  results = results.map(p => {
    var baseRisk = (p.ilRisk === 'yes' ? 0.3 : (p.ilRisk === 'high' ? 0.5 : 1.0));
    var exposureRisk = (p.exposure === 'multiple' ? 0.7 : 1.0);
    var stableBonus = p.stablecoin ? 0.2 : 0;
    var adjustedApy = p.apy * baseRisk * exposureRisk + stableBonus;
    return Object.assign({}, p, {
      risk_score: Math.round((baseRisk * 10) + 100),
      adjusted_apy_pct: Math.round(adjustedApy * 10000) / 100,
      distance_to_target: Math.abs(p.apy - 5) // placeholder metric
    });
  });
  results.sort((a, b) => b.adjusted_apy_pct - a.adjusted_apy_pct);
  return results.slice(0, 6);
}

// --- Pure handler ---
async function getYieldSurface(params) {
  var chainFilter = params.chain ? String(params.chain).toLowerCase() : null;
  if (chainFilter && chainFilter !== 'base' && chainFilter !== 'eth' && chainFilter !== 'ethereum') {
    chainFilter = null; // allow any if invalid
  }

  // Fetch real yield pools (free, no key)
  var pools = await fetchYieldPools(chainFilter);
  if (pools.length === 0) {
    // No pools for this filter -> return null (uncharged) per charge signal rules
    return null;
  }

  // Cross-protocol normalization: pull DefiLlama protocol TVL for context
  var defillamaContext = {};
  try {
    var baseTvl = await chainTVL('Base');
    var ethTvl = await chainTVL('Ethereum');
    defillamaContext = { base_tvl_usd: baseTvl.tvlUsd, eth_tvl_usd: ethTvl.tvlUsd };
  } catch (e) { /* ignore upstream failure for context layer */ }

  // Aggregate across lending (Aave/Morpho), DEX (Uniswap v3 pools), restaking (EigenLayer)
  // The yield pools endpoint covers all these categories
  var computed = computeRiskAdjusted(pools, params);

  return {
    surface: computed,
    chains_covered: ['base', 'ethereum'],
    count: computed.length,
    defillama_context: defillamaContext,
    note: 'Risk-adjusted APY computed from real yields.llama.fi pool data + TVL context'
  };
}

// --- x402 gate ---
function requirePayment(price) {
  return function(req, res, next) {
    var paymentHeader = req.headers['x-payment'];
    var amount = parseFloat(req.headers['x-payment-amount'] || '0');
    if (!paymentHeader || amount < price) {
      return res.status(402).json({ error: 'Payment required', price: price, endpoint: req.path });
    }
    next();
  };
}

// --- Routes ---
app.get('/yield/surface', requirePayment(0.01), async function(req, res) {
  try {
    var result = await getYieldSurface(req.query);
    if (result === null) {
      return res.status(404).json({ error: 'No yield pools match filter', uncharged: true });
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Upstream failure', detail: e.message, uncharged: true });
  }
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'S-022' });
});

module.exports = { app, getYieldSurface, fetchYieldPools };

if (require.main === module) {
  app.listen(PORT, function() { console.log('S-022 yield surface service on port ' + PORT); });
}
