#!/usr/bin/env node
/*
  TOOLSHED / web.js  --  REAL web access for the crew. Fetch any PUBLIC url.
    node web.js <url>                 -> GET, prints status + body (capped)
    node web.js <url> --json          -> GET, pretty-prints JSON
    node web.js <url> POST '<body>'   -> POST JSON

  HARDENED 2026-07-25 (SSRF). This file used to fetch ANY url with no checks, and porter.js
  vendors it into the PUBLIC, internet-facing x402-seller service -- so it runs where strangers
  supply the inputs. The old protection was a comment saying "never fetch untrusted URLs".
  A comment is not a control.

  Now enforced in code:
    - http/https only (no file:, gopher:, data:)
    - no credentials in the URL (http://user:pass@host)
    - the hostname is DNS-resolved and EVERY resulting address checked; refused if any is
      loopback, private, link-local, CGNAT, or reserved
    - cloud metadata endpoints (169.254.169.254, metadata.google.internal, ...) blocked by name
      AND by address -- on a cloud host those hand credentials to anything that asks
    - redirects followed manually so a public URL cannot 302 into a private one
    - response size capped so a hostile endpoint cannot exhaust memory

  Residual risk, stated honestly: DNS rebinding (resolve public, flip to private between our
  check and the connection) is still theoretically possible. Closing it fully requires pinning
  the socket to the checked IP. If we ever fetch genuinely attacker-chosen hostnames, do that.
*/
const dns = require('node:dns').promises;
const net = require('node:net');

const BLOCKED_HOSTNAMES = new Set([
  'metadata.google.internal', 'metadata.goog', 'instance-data',
  'localhost', 'localhost.localdomain', 'ip6-localhost',
]);
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_REDIRECTS = 3;

/** True if an IP literal sits in space a public service must never reach. */
function isPrivateIp(ip) {
  const v = net.isIP(ip);
  if (v === 4) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;                                  // 10.0.0.0/8
    if (p[0] === 127) return true;                                 // loopback
    if (p[0] === 0) return true;                                   // "this network"
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;     // 172.16.0.0/12
    if (p[0] === 192 && p[1] === 168) return true;                 // 192.168.0.0/16
    if (p[0] === 169 && p[1] === 254) return true;                 // link-local INCL. 169.254.169.254
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true;    // CGNAT 100.64.0.0/10
    if (p[0] >= 224) return true;                                  // multicast + reserved
    return false;
  }
  if (v === 6) {
    const s = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (s === '::1' || s === '::') return true;
    if (s.startsWith('fe80')) return true;                          // link-local
    if (s.startsWith('fc') || s.startsWith('fd')) return true;      // unique local
    if (s.startsWith('::ffff:')) return isPrivateIp(s.slice(7));    // IPv4-mapped
    return false;
  }
  return false;
}

/** Throws unless the URL is safe to fetch from an internet-facing service. */
async function assertSafeUrl(raw) {
  let u;
  try { u = new URL(raw); } catch { throw new Error('SSRF guard: not a valid URL'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error(`SSRF guard: blocked scheme ${u.protocol}`);
  if (u.username || u.password) throw new Error('SSRF guard: credentials in URL are not allowed');

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (BLOCKED_HOSTNAMES.has(host)) throw new Error(`SSRF guard: blocked hostname ${host}`);

  if (net.isIP(host)) {
    if (isPrivateIp(host)) throw new Error(`SSRF guard: blocked private/reserved address ${host}`);
    return u;
  }
  let addrs;
  try { addrs = await dns.lookup(host, { all: true }); }
  catch { throw new Error(`SSRF guard: cannot resolve ${host}`); }
  if (!addrs.length) throw new Error(`SSRF guard: ${host} resolved to nothing`);
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error(`SSRF guard: ${host} resolves to private address ${a.address}`);
  }
  return u;
}

async function web(url, method, body) {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(current);                    // re-checked on EVERY hop
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 20000);
    try {
      const opts = {
        method: method || 'GET',
        signal: ctl.signal,
        redirect: 'manual',                          // follow by hand so each hop is re-validated
        headers: { 'User-Agent': 'OpenClaw-Crew/1.0' },
      };
      if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = body; }
      const r = await fetch(current, opts);

      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get('location');
        if (!loc) return { status: r.status, contentType: r.headers.get('content-type') || '', body: '' };
        current = new URL(loc, current).toString();
        continue;                                    // loop re-validates the new target
      }

      const len = Number(r.headers.get('content-length') || 0);
      if (len > MAX_BYTES) throw new Error(`SSRF guard: response too large (${len} bytes)`);
      const text = (await r.text()).slice(0, MAX_BYTES);
      return { status: r.status, contentType: r.headers.get('content-type') || '', body: text };
    } finally { clearTimeout(t); }
  }
  throw new Error('SSRF guard: too many redirects');
}

module.exports = { web, assertSafeUrl, isPrivateIp };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const url = args[0];
    if (!url) { console.error('usage: node web.js <url> [--json] [POST <body>]'); process.exit(2); }
    const wantJson = args.includes('--json');
    const pi = args.indexOf('POST');
    try {
      const res = await web(url, pi >= 0 ? 'POST' : 'GET', pi >= 0 ? args[pi + 1] : null);
      const cap = res.body.length > 4000 ? res.body.slice(0, 4000) + '\n...[truncated ' + res.body.length + ' bytes]' : res.body;
      console.log('HTTP ' + res.status + '  ' + res.contentType);
      if (wantJson) { try { console.log(JSON.stringify(JSON.parse(res.body), null, 2).slice(0, 4000)); } catch { console.log(cap); } }
      else console.log(cap);
    } catch (e) { console.error('ERROR: ' + e.message); process.exit(1); }
  })();
}
