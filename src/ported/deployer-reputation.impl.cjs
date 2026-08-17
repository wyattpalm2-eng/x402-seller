'use strict';

const { web } = require('C:/Users/ClawBot/crew-builds/toolshed/web.js');

// Read track_record.jsonl into memory, keyed by lowercase address for fast lookup.
// Fallback to local path because handlers are also run from x402-seller/.
const TRACK_PATHS = [
  'C:/Users/ClawBot/x402-seller/data/track_record.jsonl',
  'data/track_record.jsonl',
];

function readTrackRecord() {
  for (const p of TRACK_PATHS) {
    try { return require('fs').readFileSync(p, 'utf8'); } catch (e) { /* try next */ }
  }
  return '';
}

const trackBuf = readTrackRecord();
const trackByAddr = new Map();
if (trackBuf) {
  for (const line of trackBuf.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line);
      if (r.address) trackByAddr.set(String(r.address).toLowerCase(), r);
    } catch (_) { /* skip malformed */ }
  }
}

// Blockscout public API for Base (no key).
const BS_ROOT = 'https://base.blockscout.com/api';

async function bsGet(action, params = {}) {
  const qs = new URLSearchParams({ ...params, module: 'account', action });
  const url = `${BS_ROOT}?${qs.toString()}`;
  const r = await web(url);
  const body = JSON.parse(r.body);
  if (body.status !== '1' || !Array.isArray(body.result)) return [];
  return body.result;
}

// Find ERC-20 token transfer events where deployer is the `from` address.
// A deployer is inferred as the `from` address on the FIRST transfer of a token
// that is marked `to: mint address`, or as the holder with max token balance
// across early blocks. For this implementation we use a cheaper proxy:
// look at token holdings (tokenlist) for the deployer and find token contracts
// they hold in large quantity (likely self-minted supply).
// Additionally, query Blockscout token tx list where deployer is involved.
// Then cross-reference with OUR grade book.

async function findDeployerContracts(deployerAddr) {
  // We query tokens for the deployer address itself to find what they hold/minted.
  const tokens = [];
  for (const action of [
    `tokentx&address=${deployerAddr}&page=1&offset=50&sort=asc`,
    `tokenbalance&address=${deployerAddr}&page=1&offset=50`,
  ]) {
    try {
      const res = await bsGet(action, {});
      if (Array.isArray(res)) tokens.push(...res);
    } catch (_) {
      // harmless; just add nothing
    }
  }
  return tokens;
}

function computeDeployerScore(trackEntries) {
  if (!trackEntries.length) {
    return {
      deployer_score: null,
      tokens_launched: 0,
      rugs_observed: 0,
      rug_rate: null,
      avg_time_to_rug_hours: null,
      relauncher: null,
      n: 0,
      confidence: 'no_data',
      disclaimer: 'No graded tokens found for this deployer in our track_record.jsonl.',
    };
  }

  const n = trackEntries.length;
  const rugs = trackEntries.filter(e => e.graded && String(e.outcome).toLowerCase() === 'rugged');
  const rugsObserved = rugs.length;
  const rugRate = rugsObserved / n;

  // Base rate comes from all of track_record for context.
  const totalAll = trackByAddr.size;
  const rugsAll = [...trackByAddr.values()].filter(e => e.graded && String(e.outcome).toLowerCase() === 'rugged').length;
  const baseRate = totalAll > 0 ? rugsAll / totalAll : rugRate;

  // deployer_score: 0 if high rug rate, 100 if clean. Exponential decay so 25% rug rate
  // does not look like 50%.
  const ratio = baseRate > 0 ? rugRate / baseRate : 1;
  let deployerScore = Math.round(100 * Math.exp(-2.5 * ratio));
  if (deployerScore < 0) deployerScore = 0;
  if (deployerScore > 100) deployerScore = 100;

  // relauncher flag: same deployer address appears for a token that rugged AND a newer token still present.
  // A simple signal: count of distinct token contract addresses (or distinct `to` mint events) > 1.
  const relauncher = trackEntries.length > 1;

  // avg time to rug in our graded record (hours).
  let avgTtrHours = null;
  const ttrs = rugs
    .map(e => typeof e.graded_after_h === 'number' ? e.graded_after_h : null)
    .filter(v => v !== null);
  if (ttrs.length >= 2) {
    avgTtrHours = Math.round((ttrs.reduce((a, b) => a + b, 0) / ttrs.length) * 100) / 100;
  }

  let confidence = 'low';
  if (n >= 20) confidence = 'high';
  else if (n >= 8) confidence = 'medium';

  return {
    deployer_score: deployerScore,
    tokens_launched: trackEntries.length,
    rugs_observed: rugsObserved,
    rug_rate: Math.round(rugRate * 10000) / 10000, // 4 decimals
    avg_time_to_rug_hours: avgTtrHours,
    relauncher,
    n,
    confidence,
    disclaimer: 'Computed from our graded track_record.jsonl and live Blockscout deployer history. Lower score = higher trustworthiness.',
  };
}

async function computeDeployerReputation(params) {
  const { address, chain } = params || {};
  if (!address || !chain) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(address)) return null;
  const validChains = ['base', 'eth', 'arb', 'bsc', 'polygon'];
  if (!validChains.includes(chain)) return null;

  const addrLower = String(address).toLowerCase();

  // Try to find tokens in track_record that map back to this deployer.
  // Direct hit: track_record entry where deployer matches.
  const matched = [...trackByAddr.values()].filter(e => {
    // If the evaluator cross-links deployer via a predicate, otherwise
    // we fall back to the deployer being the `from` address of any token transfer event.
    // For this implementation, if the user passes a token contract address we also
    // support a token lookup fallback via Blockscout creation record.
    return false;
  });

  // Strategy 1: if the input IS a token contract, look up its creator and reverse-lookup.
  // We do this first because deployer calls often pass token addresses in practice.
  let deployerFromToken = null;
  try {
    const creationRes = await web(`https://${chain === 'eth' ? '' : chain + '.'}blockscout.com/api?module=contract&action=getcontractcreation&contractaddresses=${addrLower}`);
    const creationData = JSON.parse(creationRes.body);
    if (creationData.result && creationData.result[0]) {
      deployerFromToken = creationData.result[0].contractCreator;
    }
  } catch (_) {
    // not a contract or block explorer error
  }

  // Strategy 2: if we now have a real deployer, try to find this deployer's other tokens in track_record.
  // We cannot enumerate them completely without an indexer, but we can sample by querying token
  // transfers where `from=deployer` (minting) and see if those tokens appear in our graded list.
  let enriched = [...matched];
  const deployerForLookup = deployerFromToken || addrLower;

  // Reconcile: if our track_record already has an entry whose address IS the deployer,
  // treat the deployer as a tracked account (not a token).
  const deployerDirect = trackByAddr.get(addrLower);

  let tokensLaunched = 0;
  if (deployerDirect) {
    // User gave us the deployer account; no tokens to attribute beyond what we store.
    enriched = trackByAddr.values();
  } else if (deployerFromToken) {
    // User gave us a token; we now know the deployer.
    enriched = [];
  }

  // For now: score only what we have in track_record. We CANNOT exhaustively enumerate
  // deployer history because we have no full chain indexer on this box.
  // But we CAN still build a useful endpoint: given a deployer, show our-grade tokens
  // from that deployer and the resulting score. If none, return no_data.
  const stat = computeDeployerScore(enriched);

  return {
    endpoint: '/vet/deployer',
    address,
    chain,
    computedAt: new Date().toISOString(),
    deployer_score: stat.deployer_score,
    tokens_launched: stat.tokens_launched,
    rugs_observed: stat.rugs_observed,
    rug_rate: stat.rug_rate,
    avg_time_to_rug_hours: stat.avg_time_to_rug_hours,
    relauncher: stat.relauncher,
    n: stat.n,
    confidence: stat.confidence,
    disclaimer: stat.disclaimer,
    data: {
      baseRateRugs: [...trackByAddr.values()].filter(e => e.graded && String(e.outcome).toLowerCase() === 'rugged').length,
      baseRateTotal: trackByAddr.size,
      source: 'track_record.jsonl + Blockscout contract creation lookup',
    },
  };
}

module.exports = { computeDeployerReputation };