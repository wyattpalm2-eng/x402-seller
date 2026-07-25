/* Adapter for S-011. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./token-risk.impl.cjs');

module.exports = async function handler(params) {
  const { chain, address } = params || {};
  const out = await impl.computeTokenRisk(chain, address);
  return out == null ? null : out;
};
