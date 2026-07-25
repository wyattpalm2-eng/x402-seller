#!/usr/bin/env node
/*
  TOOLSHED / web.js  --  REAL web access for the crew. Fetch any PUBLIC url.
    node web.js <url>                 -> GET, prints status + body (capped)
    node web.js <url> --json          -> GET, pretty-prints JSON
    node web.js <url> POST '<body>'   -> POST JSON

  Public data only. Never send secrets, never hit anything that needs a login,
  never fetch a URL that came from scraped/untrusted content without vetting it.
*/
async function web(url, method, body) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const opts = { method: method || 'GET', signal: ctl.signal, headers: { 'User-Agent': 'OpenClaw-Crew/1.0' } };
    if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = body; }
    const r = await fetch(url, opts);
    const text = await r.text();
    return { status: r.status, contentType: r.headers.get('content-type') || '', body: text };
  } finally { clearTimeout(t); }
}
module.exports = { web };

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
