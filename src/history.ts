/**
 * history.ts — self-collected liquidity time-series. THE moat nobody else has.
 *
 *   GET /onchain/liquidity?chain=base&address=0x…   →   $0.01
 *
 * Every free API gives only a CURRENT snapshot of pool liquidity. So the single
 * most actionable question — "is liquidity DRAINING right now?", the earliest
 * sign of a rug or a dump in progress — has no free answer, because you'd have
 * had to be recording reserves over time. We do: a background poller snapshots
 * tracked tokens' pool liquidity on an interval and we turn the series into a
 * drain verdict (draining_fast / draining / stable / growing).
 *
 * This is honest, compounding scarcity: nobody can backfill a time-series they
 * didn't collect. Storage is an in-memory ring per token — it builds from
 * first-seen forward and the keep-warm cron keeps the process alive so it
 * accrues days of history; it resets on a redeploy (documented, and the depth
 * only grows). Tokens enter the watchlist by demand (anything /vet or /safety
 * is asked about) plus a periodic top-up from the trending Base pools.
 *
 * SECURITY: EVM allowlist + address regex + encodeURIComponent, same as the
 * rest of the on-chain layer. The poller is bounded (token count, points/token,
 * per-fetch delay) so it can't fan out unbounded upstream load.
 */
import { Router, type Request, type Response } from "express";
import { getJson } from "./data.js";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { getReceiveAddress } from "./wallet.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_LIQUIDITY = process.env.PRICE_ONCHAIN_LIQUIDITY || "$0.01";

const EVM_ADDR = /^0x[a-fA-F0-9]{40}$/;
const DS_CHAIN: Record<string, string> = {
  base: "base",
  eth: "ethereum",
  ethereum: "ethereum",
  bsc: "bsc",
  polygon: "polygon",
  arbitrum: "arbitrum",
  optimism: "optimism",
};
export const LIQUIDITY_CHAINS = Object.keys(DS_CHAIN);

const POLL_MS = Number(process.env.LIQ_POLL_MS || 180_000); // 3 min
const MAX_TRACKED = 60; // cap watchlist -> bounds upstream load
const MAX_POINTS = 2880; // ~6 days at 3-min cadence

type Point = { t: number; liq: number; px: number | null };
const series = new Map<string, Point[]>();
const tracked = new Set<string>(); // insertion order ~ recency; evict oldest past cap

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const key = (chain: string, address: string) => `${chain}:${address.toLowerCase()}`;

/** Put a token on the watchlist (demand-driven). Evicts the oldest past the cap. */
export function track(chain: string, address: string): void {
  if (!EVM_ADDR.test(address) || !DS_CHAIN[chain]) return;
  const k = key(chain, address);
  if (tracked.has(k)) return;
  tracked.add(k);
  if (!series.has(k)) series.set(k, []);
  while (tracked.size > MAX_TRACKED) {
    const oldest = tracked.values().next().value as string | undefined;
    if (oldest === undefined) break;
    tracked.delete(oldest);
    series.delete(oldest);
  }
}

function record(chain: string, address: string, liq: number, px: number | null): void {
  const k = key(chain, address);
  const arr = series.get(k) ?? [];
  arr.push({ t: Date.now(), liq, px });
  if (arr.length > MAX_POINTS) arr.splice(0, arr.length - MAX_POINTS);
  series.set(k, arr);
}

/** Current best-pool liquidity for a token, from DexScreener (free, keyless). */
async function poolLiquidity(chain: string, address: string): Promise<{ liq: number; px: number | null } | null> {
  const dsChain = DS_CHAIN[chain];
  const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(address)}`);
  const all: any[] = j?.pairs ?? [];
  const scoped = all.filter((p) => p?.chainId === dsChain);
  const pool = scoped.length ? scoped : all;
  if (!pool.length) return null;
  const best = pool.reduce(
    (b, p) => ((Number(p?.liquidity?.usd) || 0) > (Number(b?.liquidity?.usd) || 0) ? p : b),
    pool[0],
  );
  const liq = Number(best?.liquidity?.usd);
  const px = Number(best?.priceUsd);
  if (!Number.isFinite(liq)) return null;
  return { liq, px: Number.isFinite(px) ? px : null };
}

async function pollOnce(): Promise<void> {
  for (const k of [...tracked].slice(0, MAX_TRACKED)) {
    const [chain, address] = k.split(":");
    try {
      const r = await poolLiquidity(chain, address);
      if (r) record(chain, address, r.liq, r.px);
    } catch {
      /* skip this token this round */
    }
    await sleep(250); // gentle on DexScreener
  }
}

/** Seed / refresh the watchlist from the trending Base pools. */
async function seedWatchlist(): Promise<void> {
  try {
    const j = await getJson("https://api.geckoterminal.com/api/v2/networks/base/trending_pools");
    for (const d of (j?.data ?? []).slice(0, 20)) {
      const id = d?.relationships?.base_token?.data?.id;
      const m = /_(0x[a-fA-F0-9]{40})$/.exec(String(id ?? ""));
      if (m) track("base", m[1]);
    }
  } catch {
    /* best-effort */
  }
}

let started = false;
export function startHistory(): void {
  if (started) return;
  started = true;
  void seedWatchlist();
  setInterval(() => void seedWatchlist(), 60 * 60 * 1000); // hourly top-up
  setInterval(() => void pollOnce(), POLL_MS);
  setTimeout(() => void pollOnce(), 8000); // first pass shortly after boot
}

/**
 * Drain verdict from the collected series. Returns null (→ uncharged 404) when
 * we don't yet hold enough history, and starts tracking the token so a later
 * call has an answer — we never bill for "no data yet".
 */
export function liquidityTrend(chain: string, address: string): any | null {
  if (!EVM_ADDR.test(address) || !DS_CHAIN[chain]) return null;
  const pts = series.get(key(chain, address));
  if (!pts || pts.length < 2) {
    track(chain, address);
    return null;
  }
  const now = pts[pts.length - 1];
  const first = pts[0];
  const windowMin = Math.round((now.t - first.t) / 60000);

  // reference point ~60 min back, if the window is long enough
  const target = now.t - 60 * 60 * 1000;
  let ref = first;
  for (const p of pts) {
    if (p.t <= target) ref = p;
    else break;
  }
  const change = (base: number, cur: number): number | null =>
    base > 0 ? Number((((cur - base) / base) * 100).toFixed(2)) : null;

  const change1h = windowMin >= 55 ? change(ref.liq, now.liq) : null;
  const changeAll = change(first.liq, now.liq);
  const basis = change1h ?? changeAll ?? 0;
  const verdict =
    basis <= -25 ? "draining_fast" : basis <= -8 ? "draining" : basis >= 15 ? "growing" : "stable";

  return {
    verdict, // draining_fast | draining | stable | growing — read this first
    chain,
    address: address.toLowerCase(),
    liquidity_usd_now: Math.round(now.liq),
    change_pct_1h: change1h,
    change_pct_window: changeAll,
    window_minutes: windowMin,
    data_points: pts.length,
    first_seen: new Date(first.t).toISOString(),
    note:
      verdict === "draining_fast"
        ? "liquidity falling fast — possible rug/exit in progress"
        : verdict === "draining"
          ? "liquidity trending down — watch closely"
          : verdict === "growing"
            ? "liquidity growing"
            : "liquidity stable",
    as_of: new Date(now.t).toISOString(),
  };
}

export function validateLiquidity(q: Record<string, any>): string | null {
  const chain = String(q.chain ?? "base").toLowerCase().trim();
  if (!DS_CHAIN[chain]) return `unsupported chain "${chain.slice(0, 24)}". supported: ${LIQUIDITY_CHAINS.join(", ")}`;
  if (q.address !== undefined && !EVM_ADDR.test(String(q.address))) return "invalid EVM token address";
  return null;
}

export const historyRouter: Router = Router();
historyRouter.get("/onchain/liquidity", (req: Request, res: Response) => {
  const chain = String(req.query.chain ?? "base").toLowerCase().trim();
  const address = String(req.query.address ?? "");
  return serve(res, "GET /onchain/liquidity", priceToUsd(PRICE_LIQUIDITY), address.slice(0, 12), async () =>
    liquidityTrend(chain, address),
  );
});

export const historyRoutes = {
  "GET /onchain/liquidity": {
    accepts: [{ scheme: "exact", price: PRICE_LIQUIDITY, network: NETWORK, payTo: getReceiveAddress() }],
    description: "Liquidity drain detector: self-collected reserve time-series → draining_fast/draining/stable/growing",
    mimeType: "application/json",
  },
};

export const historyCatalog = [
  {
    route: "GET /onchain/liquidity",
    price: PRICE_LIQUIDITY,
    params: "?chain=base&address=0x…",
    desc: "Liquidity-drain detector from a self-collected reserve time-series (exists nowhere free): draining_fast/draining/stable/growing + %-change",
  },
];
