/* VENDORED VERBATIM from crew-builds/S-026/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
// S-026 server wrapper - uses the pure handler from handler.js
const express = require('express');
const { handler } = require('./handler');

const app = express();
const PORT = 4024;

function requirePayment(price) {
  return function(req, res, next) {
    const ph = req.headers['x-payment'];
    const amount = parseFloat(req.headers['x-payment-amount'] || '0');
    if (!ph || amount < price) {
      return res.status(402).json({ error: 'Payment required', price: price, endpoint: '/liquidation/risk', usage: '?address=0x...&chain=base|eth|arb' });
    }
    next();
  };
}

app.get('/liquidation/risk', requirePayment(0.01), async function(req, res) {
  try {
    const address = String(req.query.address || '').trim();
    const chain = String(req.query.chain || 'base').trim();
    if (!address || !/^0x[a-fA-F0-9]{40}$/.test(address)) {
      return res.status(400).json({ error: 'address must be a 40-char hex address; chain=base|eth|arb' });
    }
    const result = await handler({ address, chain });
    if (result === null) {
      return res.status(404).json({ error: 'No data available for this address/chain combination', address, chain });
    }
    res.json(result);
  } catch (e) {
    res.status(502).json({ error: 'Upstream failure', detail: e.message });
  }
});

app.get('/health', function(req, res) { res.json({ status: 'ok', service: 'S-026', endpoint: '/liquidation/risk', price: 0.01 }); });

if (require.main === module) {
  app.listen(PORT, () => console.log('S-026 /liquidation/risk on port ' + PORT));
}

module.exports = { app, handler };
