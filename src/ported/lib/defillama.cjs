#!/usr/bin/env node
/*
  TOOLSHED / defillama.js  --  REAL DeFi data (TVL, protocols, chains). Free, no key.
    node defillama.js chains              -> every chain's TVL
    node defillama.js protocol <slug>     -> one protocol's current TVL (e.g. aave, uniswap)
    node defillama.js chain <name>        -> one chain's TVL (e.g. Base, Ethereum)
  Importable: chains(), protocolTVL(slug), chainTVL(name).

  Raw TVL numbers are free -- sell the COMPUTED layer (trends, concentration,
  risk flags, cross-protocol comparisons a lone bot won't assemble).
*/
async function get(url) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try { const r = await fetch(url, { signal: ctl.signal, headers: { 'User-Agent': 'OpenClaw-Crew/1.0' } }); return await r.json(); }
  finally { clearTimeout(t); }
}
async function chains() { return get('https://api.llama.fi/v2/chains'); }
async function protocolTVL(slug) { const v = await get('https://api.llama.fi/tvl/' + encodeURIComponent(slug)); return { protocol: slug, tvlUsd: typeof v === 'number' ? v : null }; }
async function chainTVL(name) {
  const all = await chains();
  const c = Array.isArray(all) ? all.find(x => (x.name || '').toLowerCase() === String(name).toLowerCase()) : null;
  return c ? { chain: c.name, tvlUsd: c.tvl, token: c.tokenSymbol } : { chain: name, tvlUsd: null, note: 'not found' };
}
module.exports = { chains, protocolTVL, chainTVL };

if (require.main === module) {
  (async () => {
    const [cmd, a] = process.argv.slice(2);
    try {
      let out;
      if (cmd === 'chains') { const c = await chains(); out = (c || []).filter(x => x.tvl > 0).sort((x, y) => y.tvl - x.tvl).slice(0, 15).map(x => ({ chain: x.name, tvlUsd: Math.round(x.tvl) })); }
      else if (cmd === 'protocol') out = await protocolTVL(a);
      else if (cmd === 'chain') out = await chainTVL(a);
      else { console.error('usage: node defillama.js <chains|protocol <slug>|chain <name>>'); process.exit(2); }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
  })();
}
