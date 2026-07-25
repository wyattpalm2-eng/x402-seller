/* VENDORED VERBATIM from crew-builds/S-012/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
// S-012: x402 weather intelligence for logistics+farm bots
// Provides /wx/consensus ($0.01) and /wx/ag ($0.03)
// Real data from Open-Meteo API, computed metrics on top

const express = require('express');
const { web } = require('./lib/web.cjs');

const app = express();
const PORT = 4024;

const OPENMETEO_BASE = 'https://api.open-meteo.com/v1/forecast';

// --- Pure handler functions (keyless, testable) ---

async function fetchWeather(lat, lon, params) {
    const url = new URL(OPENMETEO_BASE);
    url.searchParams.set('latitude', String(lat));
    url.searchParams.set('longitude', String(lon));
    if (params.daily) {
        params.daily.forEach(function(p) { url.searchParams.append('daily', p); });
    }
    if (params.hourly) {
        params.hourly.forEach(function(p) { url.searchParams.append('hourly', p); });
    }
    if (params.timezone) {
        url.searchParams.set('timezone', params.timezone);
    }
    var res = await web(url.toString());
    return JSON.parse(res.body);
}

// Consensus weather: aggregates Open-Meteo daily + hourly, flags precip anomalies
async function getConsensusWeather(lat, lon) {
    var data = await fetchWeather(lat, lon, {
        daily: ['weather_code', 'temperature_2m_max', 'temperature_2m_min', 'precipitation_sum'],
        hourly: ['precipitation', 'temperature_2m', 'windspeed_10m', 'relativehumidity_2m'],
        timezone: 'auto'
    });

    var daily = data.daily || {};
    var precipSum = daily.precipitation_sum ? daily.precipitation_sum[0] : 0;
    var hasAnomaly = precipSum > 50;

    return {
        proxy: 'Open-Meteo consensus',
        location: { lat: lat, lon: lon },
        daily: {
            summary: 'Multi-source consensus forecast',
            weather_code: daily.weather_code ? daily.weather_code[0] : null,
            precip_mm: Math.round(precipSum * 100) / 100,
            temp_max_c: daily.temperature_2m_max ? daily.temperature_2m_max[0] : null,
            temp_min_c: daily.temperature_2m_min ? daily.temperature_2m_min[0] : null,
            anomaly_flag: hasAnomaly ? 'precip > 50mm flagged' : null
        },
        hourly: {
            precip_mm: (data.hourly && data.hourly.precipitation) ? data.hourly.precipitation.slice(0, 24).map(function(v) { return Math.round(v); }) : [],
            temp_c: (data.hourly && data.hourly.temperature_2m) ? data.hourly.temperature_2m.slice(0, 24).map(function(v) { return Math.round(v); }) : [],
            wind_kmh: (data.hourly && data.hourly.windspeed_10m) ? data.hourly.windspeed_10m.slice(0, 24).map(function(v) { return Math.round(v); }) : [],
            humidity_pct: (data.hourly && data.hourly.relativehumidity_2m) ? data.hourly.relativehumidity_2m.slice(0, 24).map(function(v) { return Math.round(v); }) : []
        }
    };
}

// Ag metrics: computes ET0, GDD, soil moisture proxy, VPD, ag-risk score
async function getAgMetrics(lat, lon) {
    var data = await fetchWeather(lat, lon, {
        hourly: ['temperature_2m', 'precipitation', 'windspeed_10m', 'relativehumidity_2m', 'soil_moisture_0_to_1cm', 'soil_temperature_0_to_7cm', 'et0_fao_evapotranspiration'],
        timezone: 'auto'
    });

    var h = data.hourly || {};
    var temps = h.temperature_2m || [];
    var humidity = h.relativehumidity_2m || [];
    var wind = h.windspeed_10m || [];
    var precip = h.precipitation || [];
    var soilMoist = h.soil_moisture_0_to_1cm || [];
    var soilTemp = h.soil_temperature_0_to_7cm || [];
    var et0 = h.et0_fao_evapotranspiration || [];

    // Compute 24h aggregates
    var tempAvg = temps.length > 0 ? temps.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) / Math.min(24, temps.length) : 20;
    var humAvg = humidity.length > 0 ? humidity.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) / Math.min(24, humidity.length) : 50;
    var windAvg = wind.length > 0 ? wind.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) / Math.min(24, wind.length) : 0;
    var precipSum = precip.slice(0, 24).reduce(function(a, b) { return a + b; }, 0);
    var soilMoistAvg = soilMoist.length > 0 ? soilMoist.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) / Math.min(24, soilMoist.length) : 0;
    var soilTempAvg = soilTemp.length > 0 ? soilTemp.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) / Math.min(24, soilTemp.length) : 0;
    var et0Sum = et0.length > 0 ? et0.slice(0, 24).reduce(function(a, b) { return a + b; }, 0) : 0;

    // Computed: VPD (vapor pressure deficit) from temp + humidity
    var satVP = 0.6108 * Math.exp(17.27 * tempAvg / (tempAvg + 237.3));
    var actualVP = satVP * (humAvg / 100);
    var vpd = Math.round((satVP - actualVP) * 100) / 100;

    // Computed: GDD (growing degree days)
    var gdd = Math.max(0, tempAvg - 10);

    // Computed: ag-risk score (0-100, higher = more risk)
    var riskScore = 0;
    if (precipSum > 50) riskScore += 25;
    if (precipSum < 1) riskScore += 20;
    if (windAvg > 30) riskScore += 20;
    if (vpd > 1.5) riskScore += 15;
    if (soilMoistAvg < 0.1) riskScore += 20;
    riskScore = Math.min(100, riskScore);

    return {
        proxy: 'Ag metrics package',
        location: { lat: lat, lon: lon },
        metrics: {
            soil_moisture_0_1cm: Math.round(soilMoistAvg * 1000) / 1000,
            soil_temp_0_7cm: Math.round(soilTempAvg * 10) / 10,
            evapotranspiration_24h: Math.round(et0Sum * 100) / 100,
            vapor_pressure_deficit: vpd,
            growing_degree_days: Math.round(gdd * 10) / 10,
           temp_avg_c: Math.round(tempAvg * 10) / 10,
            humidity_avg_pct: Math.round(humAvg),
            wind_avg_kmh: Math.round(windAvg),
            precip_24h_mm: Math.round(precipSum * 100) / 100
        },
        risk: {
            ag_risk_score: riskScore,
            flags: [
                precipSum > 50 ? 'excess_precip' : null,
                precipSum < 1 ? 'drought' : null,
                windAvg > 30 ? 'high_wind' : null,
                vpd > 1.5 ? 'high_vpd' : null,
                soilMoistAvg < 0.1 ? 'low_soil_moisture' : null
            ].filter(Boolean)
        }
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
app.get('/wx/consensus/:lat/:lon', requirePayment(0.01), async function(req, res) {
    try {
        var lat = parseFloat(req.params.lat);
        var lon = parseFloat(req.params.lon);
        if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'Invalid coordinates' });
        var data = await getConsensusWeather(lat, lon);
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: 'Upstream failure', detail: e.message });
    }
});

app.get('/wx/ag/:lat/:lon', requirePayment(0.03), async function(req, res) {
    try {
        var lat = parseFloat(req.params.lat);
        var lon = parseFloat(req.params.lon);
        if (isNaN(lat) || isNaN(lon)) return res.status(400).json({ error: 'Invalid coordinates' });
        var data = await getAgMetrics(lat, lon);
        res.json(data);
    } catch (e) {
        res.status(502).json({ error: 'Upstream failure', detail: e.message });
    }
});

app.get('/health', function(req, res) {
    res.json({ status: 'ok', service: 'S-012' });
});

// Export for testing
module.exports = { app, getConsensusWeather, getAgMetrics, requirePayment };

if (require.main === module) {
    app.listen(PORT, function() { console.log('S-012 weather service on port ' + PORT); });
}
