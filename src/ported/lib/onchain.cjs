#!/usr/bin/env node
/*
  TOOLSHED / onchain.js  --  REAL on-chain data for the crew. Free, no API key.
  Reads live Base + Ethereum via public JSON-RPC. Use it as a CLI or require() it.

  CLI:
    node onchain.js <chain> code    <address>     -> is it a contract? bytecode size
    node onchain.js <chain> account <address>     -> native balance + tx count (nonce)
    node onchain.js <chain> token   <address>     -> ERC-20 name/symbol/decimals/supply
    node onchain.js <chain> raw <method> <paramsJSON>   -> any JSON-RPC call
  <chain> = base | eth

  This is REAL data any RPC can read -- so DO NOT sell it raw (that's free, bots won't
  pay). The value is what you COMPUTE on top: aggregate many signals into a wallet-risk
  score, holder-concentration analysis, contract fingerprinting, activity patterns, etc.
*/
const RPCS = {
  base: ['https://mainnet.base.org', 'https://base-rpc.publicnode.com'],
  eth: ['https://ethereum-rpc.publicnode.com'],
};

async function rpc(chain, method, params) {
  const urls = RPCS[chain];
  if (!urls) throw new Error('unknown chain: ' + chain + ' (use base|eth)');
  let lastErr;
  for (const url of urls) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 15000);
      const r = await fetch(url, { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      clearTimeout(t);
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      return j.result;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error('all RPCs failed');
}

const hexToBig = (h) => BigInt(h && h !== '0x' ? h : '0x0');
const hexToInt = (h) => Number(hexToBig(h));
function decodeString(hex) { // ABI-encoded string: offset(32) len(32) data
  if (!hex || hex === '0x') return '';
  const b = hex.slice(2);
  const len = parseInt(b.slice(64, 128), 16);
  const data = b.slice(128, 128 + len * 2);
  return Buffer.from(data, 'hex').toString('utf8');
}

async function getCode(chain, addr) {
  const code = await rpc(chain, 'eth_getCode', [addr, 'latest']);
  const bytes = code && code !== '0x' ? (code.length - 2) / 2 : 0;
  return { address: addr, chain, isContract: bytes > 0, bytecodeBytes: bytes };
}
async function getAccount(chain, addr) {
  const [bal, nonce, code] = await Promise.all([
    rpc(chain, 'eth_getBalance', [addr, 'latest']),
    rpc(chain, 'eth_getTransactionCount', [addr, 'latest']),
    rpc(chain, 'eth_getCode', [addr, 'latest']),
  ]);
  const wei = hexToBig(bal);
  return { address: addr, chain, nativeBalanceWei: wei.toString(), nativeBalance: (Number(wei) / 1e18).toFixed(6), txCount: hexToInt(nonce), isContract: !!(code && code !== '0x') };
}
async function getToken(chain, addr) {
  const call = (sel) => rpc(chain, 'eth_call', [{ to: addr, data: sel }, 'latest']);
  const [name, symbol, dec, supply] = await Promise.all([
    call('0x06fdde03').catch(() => '0x'), call('0x95d89b41').catch(() => '0x'),
    call('0x313ce567').catch(() => '0x'), call('0x18160ddd').catch(() => '0x'),
  ]);
  const decimals = hexToInt(dec);
  const raw = hexToBig(supply);
  const human = decimals ? (Number(raw) / 10 ** decimals) : Number(raw);
  return { address: addr, chain, name: decodeString(name), symbol: decodeString(symbol), decimals, totalSupplyRaw: raw.toString(), totalSupply: human };
}

async function getGas(chain) {
  const wei = hexToBig(await rpc(chain, 'eth_gasPrice', []));
  const gwei = Number(wei) / 1e9;
  const label = gwei < 1 ? 'very cheap' : gwei < 10 ? 'cheap' : gwei < 40 ? 'normal' : 'high';
  return { chain, gasPriceWei: wei.toString(), gwei: Number(gwei.toFixed(4)), label };
}

module.exports = { rpc, getCode, getAccount, getToken, getGas };

if (require.main === module) {
  (async () => {
    const [chain, cmd, a, b] = process.argv.slice(2);
    try {
      let out;
      if (cmd === 'code') out = await getCode(chain, a);
      else if (cmd === 'account') out = await getAccount(chain, a);
      else if (cmd === 'token') out = await getToken(chain, a);
      else if (cmd === 'gas') out = await getGas(chain);
      else if (cmd === 'raw') out = await rpc(chain, a, JSON.parse(b || '[]'));
      else { console.error('usage: node onchain.js <base|eth> <code|account|token|gas|raw> <address|method> [params]'); process.exit(2); }
      console.log(JSON.stringify(out, null, 2));
    } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
  })();
}
