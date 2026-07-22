/**
 * SEAM-TEST BUNDLE — ported from crew build S-006 (/weather/consensus), PROVEN.
 * Pure, keyless handler for the real x402-seller. The real x402 gate is GLOBAL on the
 * seller repo, so there is NO gate here — just the valuable computation.
 *
 * CONTRACT (per Mac side):
 *   module.exports = async (params) => result
 *     return object  -> buyer is CHARGED (200)   [we delivered real value]
 *     return null    -> uncharged 404            [no result for this input; don't bill]
 *     throw          -> uncharged 502            [our/upstream failure; don't bill]
 *
 * KEYLESS by design: Open-Meteo, NOAA/NWS, 7Timer are all free/no-key. Reselling a KEYED
 * provider would breach its ToS — keyless-computed consensus is the moat.
 */
const http = require("http");
const https = require("https");

function fetchJson(getUrl, { headers = {}, timeout = 10000 } = {}) {
  return new Promise((resolve) => {
    const lib = getUrl.startsWith("https") ? https : http;
    const req = lib.get(getUrl, { headers, timeout }, (res) => {
      if (res.statusCode !== 200) { let b = ""; res.on("data", (c) => (b += c)); res.on("end", () => resolve({ ok: false, status: res.statusCode, body: b })); return; }
      let body = ""; res.on("data", (c) => (body += c));
      res.on("end", () => { try { resolve({ ok: true, data: JSON.parse(body) }); } catch (e) { resolve({ ok: false, status: 200, body }); } });
    });
    req.on("error", (e) => resolve({ ok: false, status: 0, body: e.message }));
    req.on("timeout", () => { req.destroy(); resolve({ ok: false, status: 0, body: "timeout" }); });
  });
}
const UA = { "User-Agent": "x402-weather-consensus/1.0" };

async function openMeteo(lat, lon) {
  const u = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current=temperature_2m,precipitation&daily=temperature_2m_max,temperature_2m_min,precipitation_sum&timezone=auto&forecast_days=3`;
  const r = await fetchJson(u, { headers: UA });
  if (!r.ok) return { source: "open-meteo", error: r.body || `HTTP ${r.status}` };
  const c = r.data.current || {}, d = r.data.daily || {};
  return { source: "open-meteo", tempC: c.temperature_2m ?? null, precipMm: c.precipitation ?? null,
    daily: { maxTemps: (d.temperature_2m_max || []).slice(0, 3), minTemps: (d.temperature_2m_min || []).slice(0, 3), precipSum: (d.precipitation_sum || []).slice(0, 3) } };
}
async function noaa(lat, lon) {
  const pr = await fetchJson(`https://api.weather.gov/points/${lat},${lon}`, { headers: { ...UA, Accept: "application/geo+json" } });
  if (!pr.ok) return { source: "noaa-nws", error: pr.body || `HTTP ${pr.status}` };
  const fUrl = pr.data.properties && pr.data.properties.forecast;
  if (!fUrl) return { source: "noaa-nws", error: "no forecast URL" };
  const fr = await fetchJson(fUrl, { headers: { ...UA, Accept: "application/geo+json" } });
  if (!fr.ok) return { source: "noaa-nws", error: fr.body || `HTTP ${fr.status}` };
  const periods = (fr.data.properties && fr.data.properties.periods) || [];
  const today = periods.find((p) => p.isDaytime) || periods[0];
  const tempF = today && today.temperature != null ? today.temperature : null;
  const tempC = tempF != null ? Math.round(((tempF - 32) * 5) / 9 * 10) / 10 : null;
  return { source: "noaa-nws", tempC, precipMm: null, shortForecast: today ? today.shortForecast : null };
}
async function sevenTimer(lat, lon) {
  const r = await fetchJson(`http://www.7timer.info/bin/api.pl?lon=${lon}&lat=${lat}&product=civil&output=json`, { headers: UA });
  if (!r.ok) return { source: "7timer", error: r.body || `HTTP ${r.status}` };
  const ds = r.data.dataseries || [];
  if (!ds.length) return { source: "7timer", error: "no data series" };
  const first = ds[0];
  let tempC = null;
  if (first.temp2m && typeof first.temp2m === "object") tempC = first.temp2m.celsius ?? null;
  else if (typeof first.temp2m === "number") tempC = first.temp2m;
  return { source: "7timer", tempC, precipMm: null, weatherType: first.weather || null };
}
function consensus(results) {
  const valid = results.filter((r) => r.tempC != null);
  if (!valid.length) return null;
  const temps = valid.map((r) => r.tempC);
  const mean = temps.reduce((a, b) => a + b, 0) / temps.length;
  const stdev = Math.sqrt(temps.reduce((s, t) => s + (t - mean) ** 2, 0) / temps.length);
  return {
    blendedTempC: Math.round(mean * 10) / 10,
    agreementScore: Math.max(0, Math.round(100 * (1 - Math.min(stdev / 5, 1)))),
    sourceCount: valid.length,
    stdevC: Math.round(stdev * 100) / 100,
    sourceTemps: valid.map((r) => ({ source: r.source, tempC: r.tempC })),
  };
}

module.exports = async function handler(params) {
  const lat = parseFloat(params.lat), lon = parseFloat(params.lon);
  if (isNaN(lat) || isNaN(lon) || lat < -90 || lat > 90 || lon < -180 || lon > 180) return null; // bad input -> uncharged 404
  const [om, nws, t7] = await Promise.all([openMeteo(lat, lon), noaa(lat, lon), sevenTimer(lat, lon)]);
  const c = consensus([om, nws, t7]);
  if (!c) throw new Error("all upstream weather sources failed"); // our failure -> uncharged 502
  return {
    query: { lat, lon, endpoint: "/weather/consensus" },
    sources: [om, nws, t7].map((s) => (s.error ? { source: s.source, error: s.error } : s)),
    consensus: c,
  };
};
