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
function pointInPolygon(lat, lon, polygon) {
  // polygon is array of [lon, lat] pairs (GeoJSON ring)
  var inside = false;
  for (var i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    var xi = polygon[i][0], yi = polygon[i][1];
    var xj = polygon[j][0], yj = polygon[j][1];
    var intersect = ((yi > lon) !== (yj > lon)) &&
      (lat < (xj - xi) * (lon - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
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
  var containedAlerts = [];
  var features = alertsData.features || [];
  for (var i = 0; i < features.length; i++) {
    var f = features[i];
    var props = f.properties || {};
    var geom = f.geometry;

    if (geom && geom.type === 'Polygon') {
      // Check containment in first ring
      var ring = geom.coordinates[0];
      // GeoJSON ring is [lon,lat] but our point is [lat,lon], convert
      var polyPoints = ring.map(function(c) { return [c[0], c[1]]; });
      if (pointInPolygon(lat, lon, polyPoints)) {
        containedAlerts.push(props);
      }
    } else if (geom && geom.type === 'MultiPolygon') {
      // Check all polygons in multipolygon
      for (var mp = 0; mp < geom.coordinates.length; mp++) {
        var mpRing = geom.coordinates[mp][0];
        var mpPoints = mpRing.map(function(c) { return [c[0], c[1]]; });
        if (pointInPolygon(lat, lon, mpPoints)) {
          containedAlerts.push(props);
          break;
        }
      }
    } else {
      // No geometry -- zone/county based alert, includes our area
      containedAlerts.push(props);
    }
  }

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

  // Return null (no charge) if calm and no alerts
  if (alertCount === 0 && windGust < 10) {
    return null;
  }

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