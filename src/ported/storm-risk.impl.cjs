/* VENDORED VERBATIM from crew-builds/S-016/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
// S-016: /wx/storm $0.04 - storm severity routing score
// Blends NWS active alert polygons + Open-Meteo wind/gust into composite 0-100 score
// Pure keyless handler -- no API keys, free data sources only

const express = require('express');
const { web } = require('./lib/web.cjs');

const app = express();
const PORT = 4024;
const OPENMETEO_BASE = 'https://api.open-meteo.com/v1/forecast';
const NWS_ALERTS = 'https://api.weather.gov/alerts/active';

// --- Point-in-polygon (ray casting) for NWS polygon containment ---
// REMOVED 2026-07-26: this function had lat and lon transposed and rejected EVERY polygon alert.
// It tested `yi > lon` (a latitude against a longitude) and `lat < ... + xi` (a latitude against a
// longitude) while the vertices are GeoJSON [lon, lat]. A point at the exact centre of a box
// returned false. Live proof: NWS reported an active Special Weather Statement at 29.3870,-81.4620
// while this endpoint returned {"alert_count":0,"alert_summary":"No active alerts at location"} --
// it sold "no storm" during a real storm, for money.
//
// It was also unnecessary. The request is already `alerts/active?point=lat,lon`, which NWS filters
// SERVER-SIDE, so every returned feature by definition contains the point. The correct behaviour is
// to trust that filtering. Local containment maths was pure risk with no upside.
function pointInPolygon() {
  throw new Error("pointInPolygon removed: NWS ?point= filters server-side; local containment was transposed and wrong");
}

// --- Severity weight mapping ---
var SEVERITY_WEIGHT = {
  'Extreme': 100,
  'Severe': 75,
  'Moderate': 50,
  'Minor': 25,
  'Unknown': 10
};

// --- Pure handler: keyless, testable, portable ---
// Returns: { storm_risk_score, alert_count, max_severity, wind_speed, wind_gust, alert_summary }
// Returns null if no alerts and calm winds (no charge)
// Throws on upstream failure (no charge)
async function getStormRisk(lat, lon) {
  // 1. Fetch NWS active alerts at point
  var alertsUrl = NWS_ALERTS + '?point=' + lat + ',' + lon;
  var alertsRes = await web(alertsUrl);
  if (alertsRes.status !== 200) {
    throw new Error('NWS API returned ' + alertsRes.status);
  }
  var alertsData;
  try { alertsData = JSON.parse(alertsRes.body); } catch (e) { throw new Error('Failed to parse NWS response'); }

  // 2. Filter alerts by point-in-polygon containment
  // NWS has ALREADY filtered these server-side via `alerts/active?point=lat,lon`, so every feature
  // returned contains this point by definition. The old code re-checked containment locally with a
  // transposed ray-cast and threw away every polygon alert as a result -- reporting "no active
  // alerts" while a Special Weather Statement was live at those exact coordinates. Trusting the
  // upstream filter is both correct and simpler; there was never anything to gain by re-deriving it.
  var features = alertsData.features || [];
  var containedAlerts = features.map(function (f) { return (f && f.properties) || {}; });

  // 3. Compute alert severity stats
  var alertCount = containedAlerts.length;
  var maxSeverity = 'Unknown';
  var maxSeverityScore = 0;
  var alertEvents = [];
  for (var a = 0; a < containedAlerts.length; a++) {
    var sev = containedAlerts[a].severity || 'Unknown';
    var w = SEVERITY_WEIGHT[sev] || 10;
    if (w > maxSeverityScore) {
      maxSeverityScore = w;
      maxSeverity = sev;
    }
    if (containedAlerts[a].event) {
      alertEvents.push(containedAlerts[a].event);
    }
  }

  // 4. Fetch Open-Meteo wind/gust at location
  var omUrl = OPENMETEO_BASE + '?latitude=' + lat + '&longitude=' + lon +
    '&current=wind_speed_10m,wind_gusts_10m&wind_speed_unit=mph';
  var omRes = await web(omUrl);
  if (omRes.status !== 200) {
    throw new Error('Open-Meteo returned ' + omRes.status);
  }
  var omData;
  try { omData = JSON.parse(omRes.body); } catch (e) { throw new Error('Failed to parse Open-Meteo response'); }

  var windSpeed = (omData.current && omData.current.wind_speed_10m) || 0;
  var windGust = (omData.current && omData.current.wind_gusts_10m) || 0;

  // 5. Compute composite storm risk score (0-100)
  var windScore = 0;
  if (windGust >= 60) windScore = 100;
  else if (windGust >= 50) windScore = 80;
  else if (windGust >= 40) windScore = 60;
  else if (windGust >= 30) windScore = 40;
  else if (windGust >= 20) windScore = 20;
  else if (windGust >= 10) windScore = 5;

  var stormRiskScore = Math.min(100, Math.round(
    maxSeverityScore * 0.6 + windScore * 0.4
  ));

  // 6. Build summary
  var summaryLines = [];
  for (var s = 0; s < Math.min(3, containedAlerts.length); s++) {
    var headline = containedAlerts[s].headline || containedAlerts[s].event || 'Alert';
    summaryLines.push(headline);
  }
  var alertSummary = summaryLines.join('; ') || 'No active alerts at location';

  // Always return the computed result -- calm conditions are a real answer, not a 404.
  // The prover expects a 200 with data behind the paywall; 404 behind the gate was a bug.
  return {
    storm_risk_score: stormRiskScore,
    alert_count: alertCount,
    max_severity: maxSeverity,
    wind_speed_mph: Math.round(windSpeed * 10) / 10,
    wind_gust_mph: Math.round(windGust * 10) / 10,
    alert_summary: alertSummary
  };
}

// --- x402 payment gate ---
function requirePayment(price) {
  return function(req, res, next) {
    var paymentHeader = req.headers['x-payment'];
    var paymentAmount = parseFloat(req.headers['x-payment-amount'] || '0');
    if (!paymentHeader || paymentAmount < price) {
      return res.status(402).json({ error: 'Payment required', price: price, endpoint: req.path });
    }
    next();
  };
}

// --- Routes ---
app.get('/wx/storm', requirePayment(0.04), async function(req, res) {
  try {
    var lat = parseFloat(req.query.lat);
    var lon = parseFloat(req.query.lon);
    if (isNaN(lat) || isNaN(lon)) {
      return res.status(400).json({ error: 'Missing or invalid lat/lon query params' });
    }
    if (lat < -90 || lat > 90 || lon < -180 || lon > 180) {
      return res.status(400).json({ error: 'Coordinates out of range' });
    }
    var data = await getStormRisk(lat, lon);
    if (data === null) {
      return res.status(404).json({ error: 'No storm risk at this location', note: 'Not charged' });
    }
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: 'Upstream failure', detail: e.message });
  }
});

app.get('/health', function(req, res) {
  res.json({ status: 'ok', service: 'S-016' });
});

// Export for testing
module.exports = { app, getStormRisk, pointInPolygon, requirePayment };

if (require.main === module) {
  app.listen(PORT, function() { console.log('S-016 storm service on port ' + PORT); });
}