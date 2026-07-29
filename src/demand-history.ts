/**
 * demand-history.ts — make the demand signal survive a redeploy.
 *
 * /demand and /funnel are in-memory, so every deploy resets them to zero. On
 * 2026-07-29 six deploys in one evening wiped the counters six times, which
 * means there was no way to answer the only question that matters early on:
 * "is anyone finding us yet?" A counter that resets can tell you today's
 * traffic; it can never show you that traffic is growing.
 *
 * That matters more than it sounds. Before the first sale, probe traffic IS the
 * product signal — a 402 served is a real caller who priced us and walked, and
 * the shape of that over days is the difference between "nobody has found us"
 * and "agents keep finding us and keep declining", which imply completely
 * different fixes.
 *
 * Same durability trick as record.ts: append a periodic snapshot to a JSONL in
 * data/, which a GitHub Action commits, so the series outlives Render's
 * ephemeral disk and becomes a public, append-only history.
 *
 * Deliberately snapshots the AGGREGATE only — no IPs, no user-agents — so the
 * committed file carries no PII, matching what /demand already publishes.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { demandReport } from "./demand.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const LEDGER = path.join(DATA_DIR, "demand_history.jsonl");

const SNAPSHOT_MS = Number(process.env.DEMAND_SNAPSHOT_MS || 30 * 60 * 1000);
const MAX_ROWS = 5000;

type Snapshot = {
  /** Unique per snapshot; the snapshot GitHub Action dedupes committed rows by this. */
  id: string;
  at: string;
  /** Which process produced it — lets a reader see redeploy boundaries. */
  bootedAt: string;
  total_probes: number;
  total_agent_signal: number;
  distinct_endpoints_probed: number;
  demo_calls: number;
  mcp_tool_calls: number;
  /** Per-endpoint probe counts, aggregate only. */
  by_endpoint: Record<string, number>;
};

function snapshot(): Snapshot {
  const d = demandReport() as any;
  const probes = (d.paywall_probes ?? {}) as Record<string, { views?: number; agent_signal?: number }>;
  const byEndpoint: Record<string, number> = {};
  let total = 0;
  let agent = 0;
  for (const [k, v] of Object.entries(probes)) {
    const views = Number(v?.views ?? 0);
    byEndpoint[k] = views;
    total += views;
    agent += Number(v?.agent_signal ?? 0);
  }
  const sum = (o: Record<string, number>) => Object.values(o ?? {}).reduce((a, b) => a + Number(b || 0), 0);
  const at = new Date().toISOString();
  return {
    id: `${d.startedAt}|${at}`,
    at,
    bootedAt: d.startedAt,
    total_probes: total,
    total_agent_signal: agent,
    distinct_endpoints_probed: Object.keys(probes).length,
    demo_calls: sum(d.demo_calls),
    mcp_tool_calls: sum(d.mcp_tool_calls),
    by_endpoint: byEndpoint,
  };
}

function append(s: Snapshot): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.appendFileSync(LEDGER, JSON.stringify(s) + "\n");
  } catch {
    /* best-effort: never let telemetry break a paid request */
  }
}

/** Every snapshot ever committed plus this run's — the GitHub Action snapshots this. */
export function demandHistory(): Snapshot[] {
  try {
    if (!fs.existsSync(LEDGER)) return [];
    return fs
      .readFileSync(LEDGER, "utf8")
      .trim()
      .split("\n")
      .slice(-MAX_ROWS)
      .map((l) => {
        try {
          return JSON.parse(l) as Snapshot;
        } catch {
          return null;
        }
      })
      .filter(Boolean) as Snapshot[];
  } catch {
    return [];
  }
}

/**
 * The read a human actually wants: is probe traffic going up, and has anyone
 * started paying? Counters reset per deploy, so we compare per-boot peaks
 * rather than summing across resets (which would double-count).
 */
export function demandTrend() {
  const h = demandHistory();
  const peakByBoot = new Map<string, Snapshot>();
  for (const s of h) {
    const prev = peakByBoot.get(s.bootedAt);
    if (!prev || s.total_probes > prev.total_probes) peakByBoot.set(s.bootedAt, s);
  }
  const boots = [...peakByBoot.values()].sort((a, b) => a.bootedAt.localeCompare(b.bootedAt));
  return {
    what_this_is:
      "Per-deploy peak demand, so the series survives the in-memory counters resetting on every redeploy. Each row is one process lifetime. Aggregate only — no IPs, no user-agents.",
    caveat:
      boots.length < 3
        ? `Only ${boots.length} process lifetimes recorded so far — too few to read a trend. It fills in on its own every ${Math.round(SNAPSHOT_MS / 60000)} minutes.`
        : "Compare total_agent_signal across rows; that is programmatic callers pricing us, which is the earliest demand signal that exists before a first sale.",
    deploys_recorded: boots.length,
    per_deploy_peak: boots,
  };
}

let timer: NodeJS.Timeout | null = null;

/** Start periodic snapshots. Safe to call once at boot. */
export function startDemandHistory(): void {
  if (timer) return;
  append(snapshot()); // one at boot so a short-lived process still leaves a trace
  timer = setInterval(() => append(snapshot()), SNAPSHOT_MS);
  timer.unref?.();
}
