/* Adapter for S-021. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./etf-flows.impl.cjs');

module.exports = async function handler(params) {
  const { symbols, days } = params || {};
  const out = await impl.handler(symbols, days);
  return out == null ? null : out;
};
