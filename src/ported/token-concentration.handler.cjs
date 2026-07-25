/* Adapter for S-020. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./token-concentration.impl.cjs');

module.exports = async function handler(params) {
  const { address, chain } = params || {};
  const out = await impl.handler(address, chain);
  return out == null ? null : out;
};
