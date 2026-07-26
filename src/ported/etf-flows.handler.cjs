/* Adapter for S-021. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./etf-flows.impl.cjs');

module.exports = async function handler(params) {
  const { symbols, days } = params || {};
  // impl.handler takes a SINGLE params OBJECT (etf-flows.impl.cjs:69 `async function handler(params)`
  // reading params.symbols / params.days). This adapter used to spread them positionally, so
  // `params` arrived as the string "IBIT,FBTC", `params.symbols` was undefined, and the impl
  // returned null at line 71 -- meaning /etf/flows answered an uncharged 404 to EVERY request it
  // has ever received. It has never once worked. (Porter generator fixed so no future port with an
  // object-shaped entry repeats this.)
  const out = await impl.handler({ symbols, days });
  return out == null ? null : out;
};
