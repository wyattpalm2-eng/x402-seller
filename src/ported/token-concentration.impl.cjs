/* VENDORED VERBATIM from crew-builds/S-020/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
const http = require('http');
const { rpc } = require('./lib/onchain.cjs');

const PORT = process.env.PORT || 4024;
const PRICE = '0.05';

// ---- Pure handler: real on-chain computation, keyless ----
function computeGini(values) {
  const sorted = [...values].map(Number).sort((a, b) => a - b);
  const n = sorted.length;
  if (n === 0 || sorted.reduce((s, v) => s + v, 0) === 0) return 0;
  const cum = sorted.map((v, i) => v * (2 * i + 1)).reduce((s, a) => s + a, 0);
  const sum = sorted.reduce((s, v) => s + v, 0);
  return (2 * cum) / (n * sum) - (n + 1) / n;
}

function computeHHI(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  return values.reduce((s, v) => s + Math.pow(v / total, 2), 0);
}

function computeShannon(values) {
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  return -values.reduce((s, v) => {
    const p = v / total;
    return s + (p > 0 ? p * Math.log2(p) : 0);
  }, 0);
}

function computeTop10Pct(values) {
  const sorted = [...values].map(Number).sort((a, b) => b - a);
  const total = values.reduce((s, v) => s + v, 0);
  if (total === 0) return 0;
  return (sorted.slice(0, Math.max(1, Math.ceil(values.length * 0.1))).reduce((s, v) => s + v, 0) / total) * 100;
}

async function handler(params) {
  const chain = params.chain || 'base';
  const address = params.address || params.contract || params.token;
  if (!address || typeof address !== 'string' || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
    return null; // bad input -> uncharged 404
  }

  const transferTopic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  const latestBlockHex = await rpc(chain, 'eth_blockNumber', []);
  const blockNum = parseInt(latestBlockHex, 16);
  let allLogs = [];

  // Public Base RPC supports recent ranges up to ~100 blocks without archive token.
  // Walk backwards in 100-block chunks, max ~1000 blocks back (~4 hours of Base blocks).
  const maxRangeBack = 1000;
  const chunkSize = 100;
  let currentTo = blockNum;

  while (currentTo > Math.max(0, blockNum - maxRangeBack)) {
    const chunkToBlock = currentTo;
    const chunkFromBlock = Math.max(0, currentTo - chunkSize);
    try {
      const logs = await rpc(chain, 'eth_getLogs', [{
        address: address,
        fromBlock: '0x' + chunkFromBlock.toString(16),
        toBlock: '0x' + chunkToBlock.toString(16),
        topics: [transferTopic],
      }]);
      if (logs && logs.length > 0) allLogs = allLogs.concat(logs);
    } catch (e) {
      // A failing chunk stops this direction; break to avoid looping on archive blocks.
      break;
    }
    currentTo = chunkFromBlock - 1;
  }
  const logs = allLogs;

  if (!logs || logs.length === 0) {
    return {
      address: address,
      chain: chain,
      fetched_at: new Date().toISOString(),
      transferEvents: 0,
      note: 'No Transfer events in recent ~1000 blocks; holder concentration unavailable for this token.',
      gini: null, top10_pct: null, hhi: null, entropy: null,
      computed: false,
    };
  }

  // Aggregate recipient volumes from Transfer event log data (real per-address computation)
  const recipientVol = {};
  for (const log of logs) {
    const toRaw = (log.topics && log.topics[2]) || '';
    const toAddr = '0x' + toRaw.slice(-40);
    if (toAddr === '0x0000000000000000000000000000000000000000') continue; // skip burn/mint zero
    const valueHex = log.data || '0x0';
    const value = BigInt(valueHex);
    recipientVol[toAddr] = (recipientVol[toAddr] || 0n) + value;
  }

  const volumes = Object.values(recipientVol);
  if (volumes.length === 0) {
    return {
      address: address,
      chain: chain,
      fetched_at: new Date().toISOString(),
      transferEvents: logs.length,
      note: 'Only mint/burn events found; no active holder distribution.',
      gini: null, top10_pct: null, hhi: null, entropy: null,
      computed: false,
    };
  }

  const volArray = volumes.map(v => Number(v));
  const totalVol = volArray.reduce((s, v) => s + v, 0);
  const fractions = totalVol > 0 ? volArray.map(v => v / totalVol) : volArray.map(() => 0);

  const gini = computeGini(fractions);
  const top10 = computeTop10Pct(fractions);
  const hhi = computeHHI(fractions);
  const entropy = computeShannon(fractions);

  return {
    address: address,
    chain: chain,
    fetched_at: new Date().toISOString(),
    transferEvents: logs.length,
    holderEstimate: fractions.length,
    gini: Math.round(gini * 10000) / 10000,
    top10_pct: Math.round(top10 * 10000) / 10000,
    hhi: Math.round(hhi * 10000) / 10000,
    entropy: Math.round(entropy * 10000) / 10000,
    computed: true,
  };
}

// ---- x402 payment gate ----
function checkPayment(req, priceStr) {
  const price = parseFloat(priceStr);
  const payHeader = req.headers['x-payment-required'] || req.headers['x-payment'];
  const amountHeader = req.headers['x-payment-amount'];
  const amount = parseFloat(amountHeader || '0');
  if (!payHeader || amount < price) {
    return { ok: false, code: 402, msg: 'Payment required' };
  }
  return { ok: true };
}

// ---- HTTP server with x402 gate ----
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split('?')[0];
  const queryStr = req.url.split('?')[1] || '';
  const query = new URLSearchParams(queryStr);

  res.setHeader('Content-Type', 'application/json');

  // Health
  if (pathname === '/health') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', service: 'S-020' }));
    return;
  }

  // Route: /token/concentration/:address?chain=base|eth
  const match = pathname.match(/^\/token\/concentration\/(0x[a-fA-F0-9]{40})$/);
  if (!match) {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'not found', endpoints: ['/token/concentration/:address?chain=base|eth'], price: PRICE + ' USDC', header: 'x-payment-required' }));
    return;
  }

  const address = match[1];
  const chain = (query.get('chain') || 'base').toLowerCase();
  if (chain !== 'base' && chain !== 'eth') {
    res.writeHead(400);
    res.end(JSON.stringify({ error: 'invalid chain, use base or eth', price: PRICE + ' USDC' }));
    return;
  }

  // x402 gate: require x-payment-required header confirming price
  const pay = checkPayment(req, PRICE);
  if (!pay.ok) {
    res.writeHead(402, { 'x-payment-required': PRICE });
    res.end(JSON.stringify({ error: pay.msg, price: PRICE + ' USDC', header: 'x-payment-required' }));
    return;
  }

  try {
    const params = { chain, address };
    const result = await handler(params);
    if (result === null) {
      res.writeHead(404);
      res.end(JSON.stringify({ error: 'no holder data found for input (uncharged 404)', price: PRICE + ' USDC', address: address, chain: chain }));
      return;
    }
    if (!result.computed && result.gini === null) {
      // Real data fetched but no concentration computed; still a valid uncharged response
      res.writeHead(200);
    } else {
      res.writeHead(200);
    }
    res.end(JSON.stringify({
      query: { address, chain, endpoint: '/token/concentration', price: PRICE + ' USDC' },
      ...result,
    }));
  } catch (e) {
    res.writeHead(502);
    res.end(JSON.stringify({ error: 'upstream failure (uncharged 502)', detail: e.message, address: address, chain: chain, price: PRICE + ' USDC' }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log('S-020 token concentration API on port ' + PORT);
  });
}

module.exports = { server, handler, checkPayment };
