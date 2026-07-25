/* Adapter for S-009. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./wallet-fingerprint.impl.cjs');

module.exports = async function handler(params) {
  const { chain, address } = params || {};
  const out = await impl.fetchWalletSignals(chain, address);
  return out == null ? null : out;
};
