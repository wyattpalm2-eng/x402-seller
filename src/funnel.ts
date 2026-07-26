/**
 * funnel.ts — the demand funnel: who LOOKS vs who BUYS.
 *
 * A "view" is a caller that hit a paid endpoint and got the 402 payment
 * challenge but never paid — a window-shopper. stats.ts already tracks BUYS;
 * this tracks the VIEWS, so /funnel shows the whole picture: are agents even
 * finding us (traffic), and if so, are they converting (paying)?
 *
 * "Who" is best-effort: an unpaid caller has NO wallet (they didn't pay), so
 * all we have is IP + User-Agent. Known callers (our own keep-warm cron, the
 * x402scan indexer, plain curl/scripts) are labeled so they don't masquerade
 * as real demand. An IP that later 200s a paid route is marked CONVERTED and
 * drops off the window-shopper list.
 *
 * All state is in-memory + bounded (Render's disk is ephemeral anyway). It
 * resets on restart — this is a live funnel view, not an audit ledger.
 */
import type { Request } from "express";

const MAX_EVENTS = 300; // ring buffer of recent view events
const MAX_IPS = 1000; // bound the per-IP table

type ViewEvent = { path: string; ip: string; ua: string; label: string; at: string };
type Visitor = {
  ip: string;
  ua: string;
  label: string;
  views: number;
  paths: Set<string>;
  firstAt: string;
  lastAt: string;
  converted: boolean;
};

const _events: ViewEvent[] = [];
const _visitors = new Map<string, Visitor>();
let _totalViews = 0;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

function ipOf(req: Request): string {
  return clip(String(req.ip || req.socket?.remoteAddress || "unknown"), 64);
}
function uaOf(req: Request): string {
  return clip(String(req.get?.("user-agent") || req.headers?.["user-agent"] || ""), 200);
}

/**
 * Best-effort label so bot noise doesn't read as real demand. We can only go on
 * User-Agent (no wallet on an unpaid call). Unknown real agents stay "unknown".
 */
export function labelFor(ua: string): string {
  const u = ua.toLowerCase();
  if (!u) return "no-user-agent";
  if (u.includes("x402scan") || u.includes("bazaar")) return "x402scan-indexer";
  if (u.includes("keepwarm") || u.includes("x402-seller")) return "self/keep-warm";
  // Uptime/trust monitors (incl. x402-observer, x402.fuchss.app) — NOT demand.
  // Checked before the generic "x402/fetch → agent-client" rule so a monitor
  // never masquerades as a real agent.
  if (u.includes("uptimerobot") || u.includes("pingdom") || u.includes("render") ||
      u.includes("observer") || u.includes("monitor") || u.includes("uptime") || u.includes("trust"))
    return "monitor/uptime";
  if (u.includes("curl") || u.includes("wget") || u.includes("httpie")) return "curl/manual";
  if (u.includes("bot") || u.includes("crawler") || u.includes("spider") || u.includes("scan")) return "crawler";
  // Common programmatic clients — plausibly a real agent's HTTP stack.
  if (u.includes("axios") || u.includes("node-fetch") || u.includes("undici") || u.includes("go-http") ||
      u.includes("python") || u.includes("okhttp") || u.includes("x402") || u.includes("fetch"))
    return "agent-client";
  return "unknown";
}

function touch(req: Request): Visitor {
  const ip = ipOf(req);
  const ua = uaOf(req);
  const now = new Date().toISOString();
  let v = _visitors.get(ip);
  if (!v) {
    // Bound the table: evict the least-recently-seen when full.
    if (_visitors.size >= MAX_IPS) {
      let oldestKey: string | undefined;
      let oldestAt = Infinity;
      for (const [k, val] of _visitors) {
        const t = Date.parse(val.lastAt);
        if (t < oldestAt) { oldestAt = t; oldestKey = k; }
      }
      if (oldestKey !== undefined) _visitors.delete(oldestKey);
    }
    v = { ip, ua, label: labelFor(ua), views: 0, paths: new Set(), firstAt: now, lastAt: now, converted: false };
    _visitors.set(ip, v);
  }
  v.ua = ua;
  v.label = labelFor(ua);
  v.lastAt = now;
  return v;
}

/** Called on every 402 (paywall challenge with no valid payment) = a window-shopper. */
export function recordView(req: Request): void {
  const v = touch(req);
  v.views += 1;
  v.paths.add(clip(req.path, 64));
  _totalViews += 1;
  _events.push({ path: clip(req.path, 64), ip: v.ip, ua: v.ua, label: v.label, at: v.lastAt });
  if (_events.length > MAX_EVENTS) _events.shift();
}

/** Called when an IP successfully gets a paid 200 → it converted, stop calling it a shopper. */
export function markBuyer(req: Request): void {
  const v = touch(req);
  v.converted = true;
}

/**
 * PUBLIC-SAFE demand aggregate: per-endpoint 402-probe counts split into
 * plausible-agent signal vs labeled noise. NO IPs, NO user-agents — safe to
 * publish and to sync into the crew's vault. This is the real-demand oracle:
 * what actual callers probe (and walk away from) beats any simulated buyer.
 */
/* ── THE WANT LIST ──────────────────────────────────────────────────────────
 * Every 404 from a non-browser client is a bot telling us, in its own words, what it came here
 * for and did not find. That is the only demand signal in this company that nobody invented:
 * not an Arena score, not a persona's hunch, not a projection on a card -- an actual external
 * agent reaching for a route that does not exist.
 *
 * The crew has been guessing what to build while this evidence went straight to /dev/null.
 * Nova reads it now. A path asked for by several distinct callers is a product brief.
 */
type Want = { path: string; hits: number; callers: Set<string>; agents: Set<string>; firstSeen: string; lastSeen: string };
const wants = new Map<string, Want>();
const MAX_WANTS = 400;

/**
 * Paths we actually serve. A 404 on one of these is a METHOD mismatch (OPTIONS/POST preflight),
 * not a bot asking for a product we lack — and recording it as demand is actively harmful: the
 * want list drove Nova toward speccing `/price`, an endpoint that has existed since day one.
 * Set by index.ts at startup so this stays in sync with the real route table.
 */
let servedPaths: string[] = [];
export function setServedPaths(paths: string[]): void {
  servedPaths = paths.map((p) => p.split("/:")[0]).filter(Boolean);
}

export function recordMiss(req: Request): void {
  try {
    const p = String(req.path || "").slice(0, 120);
    if (!p || p === "/" || p === "/favicon.ico") return;
    // Only GET can be a genuine "I wanted this product" signal. A 404 from OPTIONS/POST/PUT on a
    // route we serve is a preflight or a client error, and counting it as demand invents customers.
    if (String(req.method || "GET").toUpperCase() !== "GET") return;
    if (servedPaths.some((sp) => p === sp || p.startsWith(sp + "/"))) return;
    // Browsers and scanners hunting for wordpress are noise, not demand.
    const ua = String(req.headers["user-agent"] || "");
    if (/Mozilla|Chrome|Safari|Edg\//i.test(ua) && !/bot|node|python|curl|agent/i.test(ua)) return;
    if (/\.(php|asp|aspx|jsp|env|git|sql|zip)$/i.test(p) || /wp-|phpmyadmin|admin/i.test(p)) return;

    const now = new Date().toISOString();
    const w = wants.get(p) ?? { path: p, hits: 0, callers: new Set<string>(), agents: new Set<string>(), firstSeen: now, lastSeen: now };
    w.hits += 1;
    w.lastSeen = now;
    const ip = String((req.headers["x-forwarded-for"] as string) || req.ip || "").split(",")[0].trim();
    if (ip) w.callers.add(ip);
    if (ua) w.agents.add(ua.slice(0, 60));
    wants.set(p, w);

    if (wants.size > MAX_WANTS) {
      // drop the coldest single-hit entry so a scanner cannot evict real signal
      const coldest = [...wants.values()].filter(x => x.hits === 1).sort((a, b) => a.lastSeen.localeCompare(b.lastSeen))[0];
      if (coldest) wants.delete(coldest.path);
    }
  } catch { /* never let bookkeeping break a 404 */ }
}

/** What bots asked for and we did not have. Sorted by distinct callers, then hits. */
export function wantList() {
  const rows = [...wants.values()]
    .map(w => ({ path: w.path, hits: w.hits, distinctCallers: w.callers.size, agents: [...w.agents].slice(0, 3), firstSeen: w.firstSeen, lastSeen: w.lastSeen }))
    .sort((a, b) => b.distinctCallers - a.distinctCallers || b.hits - a.hits)
    .slice(0, 50);
  return {
    note:
      "Routes external clients requested that do not exist. This is OBSERVED demand -- not an Arena " +
      "score, not a projection. A path with 2+ distinct callers is a product brief, not a hunch.",
    tracked: wants.size,
    strongest: rows.filter(r => r.distinctCallers >= 2).slice(0, 10),
    all: rows,
  };
}

export function demandByEndpoint(): Record<string, { views: number; agent_signal: number }> {
  const out: Record<string, { views: number; agent_signal: number }> = {};
  for (const e of _events) {
    const slot = (out[e.path] ??= { views: 0, agent_signal: 0 });
    slot.views += 1;
    if (e.label === "unknown" || e.label === "agent-client") slot.agent_signal += 1;
  }
  return out;
}

export function funnel(totalBuys: number) {
  const visitors = [..._visitors.values()];
  const shoppers = visitors.filter((v) => !v.converted);
  const converted = visitors.filter((v) => v.converted);

  // Views broken down by endpoint.
  const viewsByPath: Record<string, number> = {};
  for (const e of _events) viewsByPath[e.path] = (viewsByPath[e.path] ?? 0) + 1;

  // Rough conversion: buys vs distinct viewing IPs that didn't convert. Honest
  // and imperfect (an IP can span many agents; a repeat buyer is one IP).
  const denom = totalBuys + shoppers.length;
  const conversionPct = denom > 0 ? Number(((totalBuys / denom) * 100).toFixed(1)) : null;

  const fmtShopper = (v: Visitor) => ({
    ip: v.ip,
    user_agent: v.ua || null,
    label: v.label,
    views: v.views,
    endpoints: [...v.paths],
    first_seen: v.firstAt,
    last_seen: v.lastAt,
  });

  return {
    summary: {
      total_views: _totalViews, // every 402 challenge served
      total_buys: totalBuys, // paid deliveries (from stats)
      unique_viewers: _visitors.size,
      converted_viewers: converted.length,
      window_shoppers: shoppers.length, // viewed, never paid
      conversion_pct: conversionPct,
    },
    views_by_endpoint: viewsByPath,
    // Callers whose IP later hit a paid 200 — they converted. Surfaced so the
    // dashboard can show buyers as their own rows (the payoff at the top).
    converted: converted.slice(0, 20).map(fmtShopper),
    // Who looked and didn't buy — real (unlabeled/agent) callers first, bots last.
    window_shoppers: shoppers
      .sort((a, b) => {
        const noise = (l: string) => (l === "unknown" || l === "agent-client" ? 0 : 1);
        return noise(a.label) - noise(b.label) || b.views - a.views;
      })
      .slice(0, 50)
      .map(fmtShopper),
    recent_views: _events.slice(-25).reverse(),
    note:
      "A view = a 402 payment challenge with no payment. 'Who' is an IP/User-Agent " +
      "fingerprint (unpaid callers have no wallet). Labeled bots (x402scan, keep-warm) " +
      "are not real demand. In-memory, resets on restart.",
  };
}
