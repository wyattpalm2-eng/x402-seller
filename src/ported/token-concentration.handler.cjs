/* Adapter for S-020. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./token-concentration.impl.cjs');

module.exports = async function handler(params) {
  const { address, chain } = params || {};
  // Same defect as /etf/flows: impl.handler takes ONE params object
  // (token-concentration.impl.cjs:42-44 reads params.chain / params.address), but this adapter
  // spread them positionally — so `params` was the address string, params.address was undefined,
  // and every request returned an uncharged 404. The endpoint has never worked.
  const out = await impl.handler({ address, chain });
  return out == null ? null : out;
};
