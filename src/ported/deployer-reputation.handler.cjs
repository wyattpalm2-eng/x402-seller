/* Adapter for S-036. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./deployer-reputation.impl.cjs');

module.exports = async function handler(params) {
  const { address, chain } = params || {};
  const out = await impl.computeDeployerReputation({ address, chain });
  return out == null ? null : out;
};
