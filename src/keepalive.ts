/**
 * keepalive.ts — stop Render's free tier from sleeping through our customers.
 *
 * THE PROBLEM THIS SOLVES (measured 2026-08-11)
 * ---------------------------------------------
 * Render's free web service spins down after 15 minutes with no INBOUND request, and the next
 * request pays a ~50 second cold start. An autonomous agent with a normal HTTP timeout does not
 * wait 50 seconds; it gives up and never comes back. So a sleeping instance does not merely serve
 * slowly, it silently loses every buyer who arrives while it is down.
 *
 * We already had a GitHub Actions cron declared for every 5 minutes. It does not run every 5 minutes.
 * GitHub throttles scheduled workflows on shared runners, and the last 14 real runs came in at gaps
 * of 33, 34, 40, 41, 46, 47, 54, 55, 60, 61, 64, 64 and 139 minutes. Against a 15-minute sleep
 * timer that means the service was asleep for the majority of every hour, which is very likely a
 * larger revenue leak than anything in the pricing.
 *
 * THE FIX
 * -------
 * The process pings its own PUBLIC url on a short interval. Render's idle timer keys on inbound
 * HTTP, and a request that leaves the box and comes back through the public hostname is inbound, so
 * once the instance is awake it stays awake. The Actions cron stays as the cold-recovery path: it
 * is unreliable as a heartbeat but perfectly adequate as a thing that eventually wakes us.
 *
 * Deliberately cheap and deliberately quiet: one GET /health every 10 minutes is ~4.3k requests a
 * month against a 750-hour free allowance for a single service. It no-ops unless a public URL is
 * configured, so local dev and CI never self-ping.
 */

const PING_MS = Number(process.env.KEEPALIVE_MS || 10 * 60 * 1000);

function publicUrl(): string | null {
  // Render injects RENDER_EXTERNAL_URL automatically; PUBLIC_BASE_URL wins when set explicitly.
  const raw = process.env.PUBLIC_BASE_URL?.trim() || process.env.RENDER_EXTERNAL_URL?.trim();
  if (!raw) return null;
  const url = raw.replace(/\/+$/, "");
  // Never self-ping a loopback address: it would not count as inbound traffic anyway, and in local
  // dev it is just noise in the log.
  if (/localhost|127\.0\.0\.1|0\.0\.0\.0/i.test(url)) return null;
  return url;
}

let started = false;

export function startKeepalive(): void {
  if (started) return;
  const base = publicUrl();
  if (!base) {
    console.log("  keepalive:   off (no PUBLIC_BASE_URL / RENDER_EXTERNAL_URL — local run)");
    return;
  }
  started = true;
  const target = `${base}/health`;
  let ok = 0, failed = 0;

  const ping = async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const res = await fetch(target, { signal: ctl.signal, headers: { "user-agent": "x402-seller-keepalive" } });
      if (res.ok) ok++; else failed++;
    } catch {
      failed++; // a failed self-ping is not worth crashing or spamming over
    } finally {
      clearTimeout(timer);
    }
  };

  setInterval(() => { void ping(); }, PING_MS);
  setTimeout(() => { void ping(); }, 30_000); // once shortly after boot
  console.log(`  keepalive:   self-ping ${target} every ${Math.round(PING_MS / 60000)}m (beats Render's 15m idle sleep)`);

  // Exposed for /health so the effect is observable rather than assumed.
  keepaliveStats = () => ({ target, interval_min: Math.round(PING_MS / 60000), ok, failed });
}

export let keepaliveStats: () => { target: string; interval_min: number; ok: number; failed: number } | null =
  () => null;
