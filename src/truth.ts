/**
 * truth.ts — THE TRUTH ENGINE: every endpoint we sell grades itself against
 * reality, forever, in public.
 *
 * The rug scorer already does this (record.ts → /track-record): verdicts graded
 * against what actually happened, misses included. This module generalizes the
 * doctrine to the newest product line, starting with the crew-built
 * /weather/consensus:
 *
 *   PREDICT: once per UTC day per city, call the EXACT vendored handler buyers
 *   pay for and record its day-max forecast (Open-Meteo leg) + consensus nowcast.
 *   WAIT:    reality happens.
 *   GRADE:   2+ days later, fetch the OBSERVED day-max from the Open-Meteo ERA5
 *   archive (a reanalysis pipeline, independent of the forecast model run) and
 *   publish the absolute error. Hits, misses, bias — all of it.
 *
 * Same durability pattern as record.ts: append-only JSONL ledger, loaded on
 * boot, snapshotted to git by a scheduled Action → tamper-evident public
 * history that survives redeploys.
 *
 * THE BRIDGE CONTRACT this creates: every future crew bundle must ship a truth
 * spec — how reality will grade it. The Proving Ground proves an endpoint works
 * once; the Truth Engine proves it stays right. Endpoints that cannot be graded
 * must say so on the page. Honesty is the product.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import weatherHandler from "./ported/weather-consensus.handler.cjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const LEDGER = path.join(DATA_DIR, "truth_weather.jsonl");
const MAX_ROWS = 4000;
const CYCLE_MS = 3 * 60 * 60 * 1000; // predict/grade sweep every 3h (cheap: ≤6 handler calls)
const GRADE_LAG_DAYS = 2; // day must be over + archive ingested before grading

// Fixed, globally spread panel — same cities forever so the series is comparable.
const CITIES = [
  { city: "nyc", lat: 40.71, lon: -74.01 },
  { city: "la", lat: 34.05, lon: -118.24 },
  { city: "chicago", lat: 41.88, lon: -87.63 },
  { city: "miami", lat: 25.76, lon: -80.19 },
  { city: "london", lat: 51.51, lon: -0.13 },
  { city: "tokyo", lat: 35.68, lon: 139.69 },
] as const;

type Row = {
  id: string; // `${city}:${date}`
  t: number; // predicted_at ms (record.ts-compatible sort key)
  city: string;
  lat: number;
  lon: number;
  date: string; // UTC day the prediction is FOR
  predicted_max_c: number;
  consensus_now_c: number | null; // the nowcast at prediction time (context)
  sources_used: number;
  graded: boolean;
  actual_max_c?: number;
  abs_err_c?: number;
  graded_at?: string;
};

const rows: Row[] = [];
const byId = new Map<string, Row>();

function persist(row: Row): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(row) + "\n");
  } catch { /* best-effort */ }
}

function upsert(row: Row): void {
  const prev = byId.get(row.id);
  if (prev) {
    const i = rows.indexOf(prev);
    if (i >= 0) rows[i] = row;
  } else {
    rows.push(row);
  }
  byId.set(row.id, row);
  persist(row);
}

function load(): void {
  try {
    if (!fs.existsSync(LEDGER)) return;
    const lines = fs.readFileSync(LEDGER, "utf8").trim().split("\n").slice(-MAX_ROWS);
    const m = new Map<string, Row>(); // later lines (graded updates) win
    for (const line of lines) {
      try {
        const r = JSON.parse(line) as Row;
        if (r?.id) m.set(r.id, r);
      } catch { /* skip bad line */ }
    }
    rows.push(...m.values());
    for (const r of rows) byId.set(r.id, r);
    rows.sort((a, b) => a.t - b.t);
  } catch { /* start fresh */ }
}

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(9000), headers: { "user-agent": "x402-seller-truth/1.0" } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

/** Observed day-max from the ERA5 reanalysis archive (independent of the forecast run). */
async function observedMax(lat: number, lon: number, date: string): Promise<number | null> {
  const j = await getJson(
    `https://archive-api.open-meteo.com/v1/archive?latitude=${lat}&longitude=${lon}&daily=temperature_2m_max&start_date=${date}&end_date=${date}&timezone=UTC`,
  );
  const v = j?.daily?.temperature_2m_max?.[0];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

async function predictCity(c: (typeof CITIES)[number], today: string): Promise<void> {
  if (byId.has(`${c.city}:${today}`)) return; // one prediction per city per day
  let out: any;
  try {
    out = await weatherHandler({ lat: String(c.lat), lon: String(c.lon) });
  } catch { return; } // upstreams down — next 3h cycle retries
  if (!out) return;
  const om = (out.sources ?? []).find((s: any) => s?.source === "open-meteo");
  const predicted = om?.daily?.maxTemps?.[0];
  if (typeof predicted !== "number" || !Number.isFinite(predicted)) return; // no forecast leg → nothing gradeable
  upsert({
    id: `${c.city}:${today}`,
    t: Date.now(),
    city: c.city,
    lat: c.lat,
    lon: c.lon,
    date: today,
    predicted_max_c: Math.round(predicted * 10) / 10,
    consensus_now_c: out.consensus?.blendedTempC ?? null,
    sources_used: out.consensus?.sourceCount ?? 0,
    graded: false,
  });
}

async function gradeDue(today: string): Promise<void> {
  const cutoff = new Date(Date.parse(today + "T00:00:00Z") - GRADE_LAG_DAYS * 86400_000).toISOString().slice(0, 10);
  const due = rows.filter((r) => !r.graded && r.date <= cutoff).slice(0, 8); // bound per cycle
  for (const r of due) {
    const actual = await observedMax(r.lat, r.lon, r.date);
    if (actual === null) continue; // archive not ready — retry next cycle
    upsert({
      ...r,
      graded: true,
      actual_max_c: Math.round(actual * 10) / 10,
      abs_err_c: Math.round(Math.abs(r.predicted_max_c - actual) * 10) / 10,
      graded_at: new Date().toISOString(),
    });
  }
}

async function cycle(): Promise<void> {
  try {
    const today = new Date().toISOString().slice(0, 10);
    for (const c of CITIES) await predictCity(c, today);
    await gradeDue(today);
  } catch { /* the truth engine must never take the server down */ }
}

export function startTruth(): void {
  load();
  setTimeout(() => void cycle(), 30_000); // first sweep shortly after boot (non-blocking)
  setInterval(() => void cycle(), CYCLE_MS).unref?.();
}

/** All rows — snapshotted to git by .github/workflows/truth-snapshot.yml. */
export function truthWeatherRaw(): Row[] {
  return rows.slice();
}

export function truthWeatherSummary() {
  const graded = rows.filter((r) => r.graded && typeof r.abs_err_c === "number");
  const mae = graded.length ? graded.reduce((s, r) => s + (r.abs_err_c as number), 0) / graded.length : null;
  const bias = graded.length
    ? graded.reduce((s, r) => s + (r.predicted_max_c - (r.actual_max_c as number)), 0) / graded.length
    : null;
  const byCity: Record<string, { n: number; mae_c: number }> = {};
  for (const r of graded) {
    const slot = (byCity[r.city] ??= { n: 0, mae_c: 0 });
    slot.mae_c = (slot.mae_c * slot.n + (r.abs_err_c as number)) / (slot.n + 1);
    slot.n += 1;
  }
  for (const k of Object.keys(byCity)) byCity[k].mae_c = Math.round(byCity[k].mae_c * 100) / 100;
  return {
    doctrine:
      "Every endpoint we sell grades itself against reality in public. This is /weather/consensus's ledger: each UTC day we record the EXACT paid handler's day-max forecast for 6 fixed cities, then grade it 2+ days later against the ERA5 reanalysis archive (an independent pipeline). Hits, misses, bias — shown, not claimed.",
    endpoint: "GET /weather/consensus",
    predictions_recorded: rows.length,
    graded: graded.length,
    pending: rows.length - graded.length,
    mae_c: mae === null ? null : Math.round(mae * 100) / 100,
    bias_c: bias === null ? null : Math.round(bias * 100) / 100,
    by_city: byCity,
    recent: rows.slice(-12).reverse().map((r) => ({
      city: r.city, date: r.date, predicted_max_c: r.predicted_max_c,
      actual_max_c: r.actual_max_c ?? null, abs_err_c: r.abs_err_c ?? null, graded: r.graded,
    })),
    method: {
      predict: "vendored paid handler, Open-Meteo forecast leg, day-max, 1/city/day (6 cities, fixed forever)",
      grade: `ERA5 archive day-max, ${GRADE_LAG_DAYS}-day lag`,
      durability: "append-only JSONL, git-snapshotted (tamper-evident), survives redeploys",
    },
    as_of: new Date().toISOString(),
  };
}
