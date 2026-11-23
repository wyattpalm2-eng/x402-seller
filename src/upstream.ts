/**
 * UPSTREAM HEALTH -- know when we are about to sell degraded data.
 *
 * /health answered `{ ok: true }` and nothing else. It could not have told us anything useful,
 * because it never looked at the free APIs every paid endpoint is built on. During an audit the
 * weather endpoints were live-returning `{"reason":"Daily API request limit exceeded"}` from
 * Open-Meteo and reporting sourceCount 2 instead of 3 -- a paying customer would have received a
 * thinner consensus than advertised, at full price, while our own health check said everything was
 * fine.
 *
 * That is the No-Fakes doctrine applied to the product rather than to the crew: do not sell work
 * you know is degraded, and make sure you can know. A silent quality drop is the same failure as a
 * hardcoded number -- the buyer pays for something that is not what it claims to be.
 *
 * Constraints this is built under:
 *  - /health is hit constantly by uptime monitors, so probes are CACHED and never run per request.
 *  - A probe must never delay or break /health; everything is best-effort with short timeouts.
 *  - "Could not check" is reported as unknown, never as healthy. Unknown is not OK.
 */

type Probe = { name: string; url: string; feeds: string };

// One cheap, representative call per upstream. Chosen to be the same endpoint family the paid
// handlers use, so a quota block shows up here before a customer finds it.
const PROBES: Probe[] = [
  { name: "open-meteo", url: "https://api.open-meteo.com/v1/forecast?latitude=40.71&longitude=-74.01&current=temperature_2m", feeds: "/weather/consensus, /wx/ag, /wx/storm" },
  { name: "dexscreener", url: "https://api.dexscreener.com/latest/dex/tokens/0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", feeds: "/vet, /screen, /token/risk, /onchain/token" },
  { name: "defillama", url: "https://api.llama.fi/v2/chains", feeds: "/onchain/defi" },
  { name: "coingecko", url: "https://api.coingecko.com/api/v3/ping", feeds: "/price, /markets" },
];

export type UpstreamStatus = {
  name: string;
  status: "ok" | "degraded" | "unknown";
  detail?: string;
  feeds: string;
};

let cache: { at: number; results: UpstreamStatus[] } | null = null;
const TTL_MS = 5 * 60_000;
let inFlight: Promise<UpstreamStatus[]> | null = null;

async function probeOne(p: Probe): Promise<UpstreamStatus> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 6000);
  try {
    const r = await fetch(p.url, { signal: ctl.signal });
    const body = await r.text();
    if (!r.ok) {
      return { name: p.name, status: "degraded", detail: `HTTP ${r.status}`, feeds: p.feeds };
    }
    // A 200 is not enough. Open-Meteo returns its quota refusal INSIDE a 200 body, which is exactly
    // how this went unnoticed -- every status-code-only check called it healthy.
    if (/limit exceeded|rate ?limit|quota|too many requests/i.test(body)) {
      return { name: p.name, status: "degraded", detail: "rate limited (returned inside a 200 body)", feeds: p.feeds };
    }
    return { name: p.name, status: "ok", feeds: p.feeds };
  } catch (e: any) {
    // Distinguish "we could not check" from "it is broken". Reporting a local timeout as an
    // upstream outage would send the crew chasing someone else's system again.
    return { name: p.name, status: "unknown", detail: e?.name === "AbortError" ? "our probe timed out" : String(e?.message || e), feeds: p.feeds };
  } finally { clearTimeout(t); }
}

/** Cached snapshot. Never throws, never blocks longer than one probe round. */
export async function getUpstreamHealth(): Promise<UpstreamStatus[]> {
  const now = Date.now();
  if (cache && now - cache.at < TTL_MS) return cache.results;
  if (inFlight) return inFlight;                       // collapse a stampede into one round
  inFlight = (async () => {
    const results = await Promise.all(PROBES.map(probeOne));
    cache = { at: Date.now(), results };
    inFlight = null;
    return results;
  })();
  return inFlight;
}

/** True when at least one upstream a paid endpoint depends on is known to be degraded. */
export function summarize(results: UpstreamStatus[]) {
  const degraded = results.filter((r) => r.status === "degraded");
  const unknown = results.filter((r) => r.status === "unknown");
  return {
    ok: degraded.length === 0,
    degraded: degraded.map((d) => ({ source: d.name, detail: d.detail, affects: d.feeds })),
    unchecked: unknown.map((u) => u.name),
    note: degraded.length
      ? "At least one free data source we resell is degraded right now. Endpoints listed under `affects` may return thinner results than advertised -- that is a reason to hold a sale, not to hide it."
      : unknown.length
        ? "All reachable sources look healthy; some could not be checked this round. Unchecked is not the same as healthy."
        : "All upstream data sources responding normally.",
  };
}
