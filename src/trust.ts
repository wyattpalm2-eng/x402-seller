/**
 * /x402/check — "Should my agent pay this x402 seller?"
 *
 * Why this exists (research 2026-11-24): across the 352 crypto sellers in the Bazaar and PayAI
 * directories the whole category took ~$930 in 30 days, but the biggest REPEAT relationship we
 * could find on-chain was one wallet paying a trust/recommendation API 5,766 times. Agents pay,
 * repeatedly, to decide whom to pay. This answers that from public evidence only:
 *
 *   1. Directory index: every Base seller in Coinbase's Bazaar and PayAI's discovery (refreshed
 *      daily), so we know a payTo's listed routes, domains and prices.
 *   2. Live probe of the endpoint: is it a valid x402 402, what does it charge, and does it pay
 *      the SAME wallet the directories list (a swapped payTo is the classic scam).
 *   3. On-chain settlement history of that wallet over the last 3 days: payments, distinct buyers, and
 *      REPEAT buyers. Directory samplers pay thousands of sellers once each; repeat buyers are the
 *      signal they cannot fake.
 *
 * Safety: only hosts that appear in the public directories are ever probed (never an arbitrary
 * host from the caller), on top of the SSRF guard in ported/lib/web.cjs, with no redirects
 * followed and a size cap. Everything is cached.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { getReceiveAddress } from "./wallet.js";
import { cached, getJson } from "./data.js";
import web from "./ported/lib/web.cjs";
import { blocksPerHour } from "./blocktime.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_X402_CHECK = process.env.PRICE_X402_CHECK || "$0.005";

const BASE = "eip155:8453";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const RPCS = ["https://base-rpc.publicnode.com", "https://mainnet.base.org"];
const WINDOW_HOURS = 72; // 3 days; at 0.2s blocks that is ~1.3M blocks, read in 50k-block slices
const STEP = 50_000;

// ─── Directory index ─────────────────────────────────────────────────────────
type Seller = { routes: number; hosts: Set<string>; prices: number[]; sources: Set<string> };
let INDEX: { at: number; sellers: Map<string, Seller>; hosts: Set<string> } | null = null;
let building: Promise<void> | null = null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function absorb(items: any[], source: string, sellers: Map<string, Seller>, hosts: Set<string>) {
  for (const it of items) {
    const url = typeof it?.resource === "string" ? it.resource : it?.resource?.url;
    let host = "";
    try { host = new URL(String(url)).hostname.toLowerCase(); } catch { continue; }
    for (const a of it?.accepts ?? []) {
      if (a?.network !== BASE || String(a?.asset ?? "").toLowerCase() !== USDC) continue;
      const pay = String(a?.payTo ?? "").toLowerCase();
      if (!/^0x[0-9a-f]{40}$/.test(pay)) continue;
      const s = sellers.get(pay) ?? { routes: 0, hosts: new Set(), prices: [], sources: new Set() };
      s.routes++;
      if (s.hosts.size < 6) s.hosts.add(host);
      const amt = Number(a?.amount ?? a?.maxAmountRequired) / 1e6;
      if (Number.isFinite(amt) && amt > 0 && s.prices.length < 40) s.prices.push(amt);
      s.sources.add(source);
      sellers.set(pay, s);
      hosts.add(host);
    }
  }
}

async function buildIndex(): Promise<void> {
  const sellers = new Map<string, Seller>();
  const hosts = new Set<string>();
  for (let off = 0; off < 60_000; off += 1000) {
    const j: any = await getJson(`https://api.cdp.coinbase.com/platform/v2/x402/discovery/resources?limit=1000&offset=${off}`).catch(() => null);
    const items = j?.items ?? [];
    absorb(items, "coinbase_bazaar", sellers, hosts);
    if (items.length < 1000) break;
    await sleep(1500); // gentle: this is someone else's API
  }
  for (let off = 0; off < 10_000; off += 100) {
    const j: any = await getJson(`https://facilitator.payai.network/discovery/resources?limit=100&offset=${off}`).catch(() => null);
    const items = j?.items ?? [];
    absorb(items, "payai", sellers, hosts);
    if (items.length < 100) break;
    await sleep(500);
  }
  if (sellers.size > 100) INDEX = { at: Date.now(), sellers, hosts };
}

function ensureIndex(): void {
  const stale = !INDEX || Date.now() - INDEX.at > 24 * 3600 * 1000;
  if (stale && !building) building = buildIndex().finally(() => { building = null; });
}
export function startTrustIndex(): void {
  setTimeout(() => ensureIndex(), 60_000).unref?.();
  setInterval(() => ensureIndex(), 6 * 3600 * 1000).unref?.();
}

const median = (xs: number[]) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

// ─── On-chain history ────────────────────────────────────────────────────────
async function rpc(method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (const url of RPCS) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(20_000) });
      const j: any = await r.json();
      if (j.error) throw new Error(String(j.error.message || "rpc error"));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error("rpc failed");
}

async function settlementHistory(payTo: string) {
  return cached(`trust:onchain:${payTo}`, async () => {
    const head = parseInt(await rpc("eth_blockNumber", []), 16) - 6;
    const from = head - WINDOW_HOURS * (await blocksPerHour("base"));
    const topic = "0x" + "0".repeat(24) + payTo.slice(2);
    let truncated = false;
    // A refused range (rate limit, or too many results on a busy wallet) is split in half and
    // retried down to a floor, rather than silently counted as zero: an earlier version marked
    // whole weeks as empty and reported a wallet with a sale 6 days ago as having none.
    const getRange = async (a: number, b: number, depth = 0): Promise<any[]> => {
      try {
        return await rpc("eth_getLogs", [{ address: USDC, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16), topics: [TRANSFER, null, topic] }]);
      } catch {
        if (b - a < 2000 || depth > 5) { truncated = true; return []; }
        const m = Math.floor((a + b) / 2);
        return [...(await getRange(a, m, depth + 1)), ...(await getRange(m + 1, b, depth + 1))];
      }
    };
    const ranges: [number, number][] = [];
    for (let b = from; b <= head; b += STEP) ranges.push([b, Math.min(b + STEP - 1, head)]);
    const results: any[][] = [];
    for (let i = 0; i < ranges.length; i += 4) { // four at a time: public RPCs refuse bursts
      results.push(...(await Promise.all(ranges.slice(i, i + 4).map(([a, b]) => getRange(a, b)))));
    }
    const per = new Map<string, number>();
    let n = 0, usd = 0, lastBlock = 0;
    for (const logs of results) for (const l of logs as any[]) {
      const v = parseInt(l.data, 16) / 1e6;
      if (v > 5) continue; // owner top-ups and transfers, not x402 sales
      const from = "0x" + String(l.topics[1]).slice(-40);
      per.set(from, (per.get(from) ?? 0) + 1);
      n++; usd += v; lastBlock = Math.max(lastBlock, parseInt(l.blockNumber, 16));
    }
    const repeat = [...per.values()].filter((c) => c >= 2).length;
    return {
      window_hours: WINDOW_HOURS,
      payments: n,
      usdc: Number(usd.toFixed(4)),
      distinct_buyers: per.size,
      repeat_buyers: repeat,
      last_payment_blocks_ago: lastBlock ? head - lastBlock : null,
      incomplete: truncated, // a slice was refused (very high volume); counts are a floor
    };
  });
}

// ─── Live probe ──────────────────────────────────────────────────────────────
async function probe(url: string) {
  await web.assertSafeUrl(url); // throws on private/reserved targets, credentials, bad schemes
  const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(8000), headers: { "user-agent": "x402-seller-trust-check/1" } });
  const header = r.headers.get("payment-required");
  let req: any = null;
  if (header) { try { req = JSON.parse(Buffer.from(header, "base64").toString("utf8")); } catch { /* malformed */ } }
  if (!req && r.status === 402) {
    const text = (await r.text()).slice(0, 200_000);
    try { req = JSON.parse(text); } catch { /* not json */ }
  }
  const acc = (req?.accepts ?? []).find((a: any) => a?.network === BASE) ?? req?.accepts?.[0] ?? null;
  return {
    status: r.status,
    valid_402: r.status === 402 && !!acc,
    x402_version: req?.x402Version ?? null,
    network: acc?.network ?? null,
    pay_to: acc?.payTo ? String(acc.payTo).toLowerCase() : null,
    price_usd: acc ? Number(acc.amount ?? acc.maxAmountRequired) / 1e6 : null,
  };
}

// ─── The answer ──────────────────────────────────────────────────────────────
export async function x402Check(input: { url?: string; payTo?: string }) {
  ensureIndex();
  const why: string[] = [];
  let host: string | null = null;
  if (input.url) { try { host = new URL(input.url).hostname.toLowerCase(); } catch { return null; } }

  const indexed = !!INDEX;
  const listedHost = host ? !!INDEX?.hosts.has(host) : null;

  let live: Awaited<ReturnType<typeof probe>> | null = null;
  let probeNote: string | null = null;
  if (input.url && listedHost) {
    live = await probe(input.url).catch((e) => { probeNote = String(e?.message ?? e).slice(0, 100); return null; });
  } else if (input.url && indexed) {
    probeNote = "not probed: this host is not in Coinbase's Bazaar or PayAI's directory, and we only probe listed hosts";
  } else if (input.url) {
    probeNote = "not probed yet: the directory index is still loading after a restart, try again in a few minutes";
  }

  const payTo = (input.payTo || live?.pay_to || "").toLowerCase() || null;
  const seller = payTo ? INDEX?.sellers.get(payTo) ?? null : null;
  const chain = payTo && /^0x[0-9a-f]{40}$/.test(payTo) ? await settlementHistory(payTo).catch(() => null) : null;
  if (!live && !chain && !seller) return null;

  let score = 40;
  if (live) {
    if (!live.valid_402) { score -= 30; why.push(`endpoint answered ${live.status}, not a valid x402 payment request`); }
    else { score += 10; why.push(`live: valid x402 v${live.x402_version ?? "?"} payment request, $${live.price_usd} on ${live.network}`); }
  } else if (probeNote) why.push(probeNote);

  if (seller) {
    const listedPays = INDEX!.sellers.has(payTo!);
    if (live?.pay_to && input.payTo && live.pay_to !== input.payTo.toLowerCase()) { score -= 50; why.push("the endpoint pays a DIFFERENT wallet than the one you gave: possible payment-address swap"); }
    if (live?.pay_to && host && !seller.hosts.has(host) && listedPays) why.push(`this wallet is listed under other hosts (${[...seller.hosts].slice(0, 3).join(", ")})`);
    why.push(`listed in ${[...seller.sources].join(" and ")} with ${seller.routes} route(s)`);
    score += 10;
    const med = median(seller.prices);
    if (live?.price_usd != null && med != null && live.price_usd > med * 5) { score -= 25; why.push(`live price $${live.price_usd} is over 5x this seller's listed median ($${med})`); }
  } else if (indexed && payTo) {
    score -= 10; why.push("this wallet is not in Coinbase's Bazaar or PayAI's directory");
  }

  if (chain) {
    if (chain.payments === 0) { score -= 20; why.push("no settled x402-size payments to this wallet in the last 3 days"); }
    else {
      score += 10;
      why.push(`${chain.payments}${chain.incomplete ? "+" : ""} payments from ${chain.distinct_buyers} buyers in the last 3 days, $${chain.usdc}`);
      if (chain.repeat_buyers >= 3) { score += 25; why.push(`${chain.repeat_buyers} buyers came back (repeat customers are the signal directory samplers cannot fake)`); }
      else if (chain.repeat_buyers > 0) { score += 5; why.push(`${chain.repeat_buyers} repeat buyer(s): some evidence, not yet a customer base`); }
      else why.push("every buyer paid once: consistent with directory samplers, not proven customers");
      if (chain.distinct_buyers >= 10) score += 10;
    }
    if (chain.incomplete) why.push("part of the on-chain window could not be read (very busy wallet or RPC limits): counts are a floor");
  }

  score = Math.max(0, Math.min(100, score));
  // "pay" needs customer evidence, not just a listing and a few one-off samplers.
  const proven = !!chain && (chain.repeat_buyers >= 3 || chain.distinct_buyers >= 10);
  const verdict = live && !live.valid_402 ? "avoid" : score >= 70 && proven ? "pay" : score >= 35 ? "caution" : "avoid";
  return {
    verdict, // pay | caution | avoid, read this first
    score,
    why,
    seller: payTo ? {
      pay_to: payTo,
      listed: !!seller,
      sources: seller ? [...seller.sources] : [],
      routes: seller?.routes ?? 0,
      hosts: seller ? [...seller.hosts] : [],
      listed_median_price_usd: seller ? median(seller.prices) : null,
    } : null,
    endpoint: input.url ? { url: input.url, listed_host: listedHost, ...(live ?? {}), note: probeNote } : null,
    onchain: chain,
    index: INDEX ? { sellers: INDEX.sellers.size, refreshed_at: new Date(INDEX.at).toISOString() } : { status: "loading" },
    method: "Public evidence only: Coinbase Bazaar + PayAI directories, a live unpaid request to the endpoint, and USDC transfers to the seller's wallet on Base. We never pay the endpoint.",
    as_of: new Date().toISOString(),
  };
}

export const trustRouter: Router = Router();
trustRouter.get("/x402/check", (req: Request, res: Response) => {
  const url = req.query.url ? String(req.query.url) : undefined;
  const payTo = req.query.payTo ? String(req.query.payTo) : undefined;
  return serve(res, "GET /x402/check", priceToUsd(PRICE_X402_CHECK), (payTo || url || "").slice(0, 60), () => x402Check({ url, payTo }),
    "Nothing to judge: the URL's host is not in the public x402 directories and no on-chain history was found for that wallet.");
});

const DESC =
  "Should my agent pay this x402 seller? Give an endpoint URL or a seller's payTo wallet and get pay / caution / avoid with reasons: is the endpoint a valid x402 402 right now and at what price, does it pay the same wallet the directories list (a swapped payTo is a classic scam), is it listed in Coinbase's Bazaar and PayAI, and its real settled payments on Base over the last 3 days, including how many buyers came back. Public evidence only; we never pay the endpoint.";
export const trustRoutes = {
  "GET /x402/check": { accepts: [{ scheme: "exact", price: PRICE_X402_CHECK, network: NETWORK, payTo: getReceiveAddress() }], description: DESC, mimeType: "application/json" },
};
export const trustCatalog = [{ route: "GET /x402/check", price: PRICE_X402_CHECK, params: "?url=https://… or ?payTo=0x…", desc: DESC }];
export function validateTrust(q: Record<string, any>): string | null {
  if (q.url === undefined && q.payTo === undefined) return null; // let crawlers see the 402
  if (q.payTo !== undefined && !/^0x[0-9a-fA-F]{40}$/.test(String(q.payTo))) return "payTo must be a 0x address";
  if (q.url !== undefined) {
    let u: URL;
    try { u = new URL(String(q.url)); } catch { return "url must be an absolute https URL"; }
    if (u.protocol !== "https:") return "url must use https";
    if (String(q.url).length > 500) return "url too long";
  }
  return null;
}
type In = Record<string, { type: string; required: boolean; default?: string; example?: string }>;
export const trustDiscovery = {
  method: "GET" as const,
  path: "/x402/check",
  price: PRICE_X402_CHECK,
  description: DESC,
  input: {
    url: { type: "string", required: false, example: "https://x402-seller-m8nx.onrender.com/vet" },
    payTo: { type: "string", required: false, example: "0x72B944dA66263bE35c2a2eDFeF5c525d58fa53Df" },
  } as In,
  output_example: {
    verdict: "caution",
    score: 55,
    why: ["live: valid x402 v2 payment request, $0.05 on eip155:8453", "listed in coinbase_bazaar and payai with 32 route(s)", "3 payments from 3 buyers in the last 3 days, $0.03", "every buyer paid once: consistent with directory samplers, not proven customers"],
    onchain: { window_hours: 72, payments: 3, usdc: 0.03, distinct_buyers: 3, repeat_buyers: 0 },
  },
};
