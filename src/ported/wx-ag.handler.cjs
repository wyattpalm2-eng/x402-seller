/* Adapter for S-012. Calls the crew's compute function directly — never its HTTP layer.
 * Returning null makes serve() answer an UNCHARGED 404; throwing makes it an UNCHARGED 502.
 * A buyer is never billed for junk. */
'use strict';
const impl = require('./wx-ag.impl.cjs');

module.exports = async function handler(params) {
  const { lat, lon } = params || {};
  const out = await impl.getAgMetrics(lat, lon);
  return out == null ? null : out;
};
