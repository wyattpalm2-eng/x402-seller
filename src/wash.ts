/**
 * /token/wash/:address — is this token's trading volume real?
 *
 * Volume is the number every screener ranks by, and it is the cheapest number to fake: a few
 * wallets trading back and forth inflate it for the cost of gas. Screeners report the total; they
 * do not say who made it. This route reads the actual swaps from chain and answers that.
 *
 * Method (all inputs are public chain data, read over JSON-RPC; DexScreener is used only to
 * find the token's deepest pool address, none of its data is resold):
 *   1. Pick the deepest supported pool on the chain (Uniswap v2/v3, Aerodrome, PancakeSwap v3).
 *   2. Pull its Swap events for the most recent window, widening until there are enough swaps.
 *   3. Attribute each swap to the transaction's signer (tx.from). Router contracts make the
 *      event's own sender/recipient fields useless for this; the signer is the trader.
 *   4. Measure: distinct traders, top-3 traders' share of volume, round-trip share (volume from
 *      traders who both bought and sold in near-equal size), and same-block buy+sell pairs.
 *
 * What it cannot tell apart, and says so: a market maker or arbitrage bot also round-trips. The
 * output reports the evidence and a verdict, not an accusation.
 */
import { Router, type Request, type Response } from "express";
import { serve } from "./crypto.js";
import { priceToUsd } from "./stats.js";
import { getReceiveAddress } from "./wallet.js";
import { getJson, cached } from "./data.js";

const NETWORK = (process.env.NETWORK?.trim() || "eip155:84532") as `${string}:${string}`;
export const PRICE_TOKEN_WASH = process.env.PRICE_TOKEN_WASH || "$0.03";

const CHAINS = {
  base: { rpcs: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"], blocksPerHour: 1800, dexChainId: "base" },
  eth: { rpcs: ["https://ethereum-rpc.publicnode.com"], blocksPerHour: 300, dexChainId: "ethereum" },
} as const;
type Chain = keyof typeof CHAINS;

const TOPIC = {
  v2: "0xd78ad95fa46c994b6551d0da85fc275fe613ce37657fb8d5e3d130840159d822",
  v3: "0xc42079f94a6350d7e6235f29174924f928cc2ac818eb64fed8004e115fbcca67",
  aero: "0xb3e2773606abfd36b5bd91394b3a54d1398336c65005baf7bf7a05efeffaf75b",
  pcs3: "0x19b47279256b2a23a1665c810c8d55a1758940ee09377d4f8d26497a3577dc83",
};
const MIN_SWAPS = 20; // below this the verdict is "insufficient_data", not a guess
const MAX_SWAPS = 150; // cap the tx lookups per call
const MAX_WINDOWS = 4; // 10min, 40min, 2.7h, 10.7h of history at most

async function rpc(chain: Chain, method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (const url of CHAINS[chain].rpcs) {
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: AbortSignal.timeout(15_000),
      });
      if (!r.ok) throw new Error(`${method} http ${r.status}`);
      const j: any = await r.json();
      if (j.error) throw new Error(`${method}: ${j.error.message || "rpc error"}`);
      return j.result;
    } catch (e) {
      last = e;
    }
  }
  throw last instanceof Error ? last : new Error("all RPCs failed");
}

/** Run up to `limit` calls at once — public RPCs throttle a 150-wide burst. */
async function pool<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]);
      }
    }),
  );
  return out;
}

const word = (data: string, i: number) => "0x" + data.slice(2 + i * 64, 2 + (i + 1) * 64);
const u = (hex: string) => BigInt(hex);
const s256 = (hex: string) => BigInt.asIntN(256, BigInt(hex));

async function findPool(chain: Chain, token: string) {
  // Same cache key as tokenSnapshot (crypto.ts), so inside /vet the two share ONE DexScreener
  // request, and a 429 spell is answered from the last good reading instead of failing.
  const j = await cached(`ds:tok:${token.toLowerCase()}`, () =>
    getJson(`https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`),
  );
  const pairs = (j?.pairs ?? []).filter(
    (p: any) => p.chainId === CHAINS[chain].dexChainId && /^0x[0-9a-fA-F]{40}$/.test(p.pairAddress ?? ""),
  );
  pairs.sort((a: any, b: any) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));
  return pairs.slice(0, 3); // try the deepest few: the top one may be a type we cannot decode
}

type Swap = { block: number; tx: string; tokenIsBuy: boolean; amount: bigint };

function decode(log: any, tokenIs0: boolean): Swap | null {
  const t = log.topics[0];
  const d: string = log.data;
  let in0: bigint, in1: bigint;
  if (t === TOPIC.v3 || t === TOPIC.pcs3) {
    // signed amounts from the pool's view: positive = paid into the pool
    const a0 = s256(word(d, 0)), a1 = s256(word(d, 1));
    in0 = a0 > 0n ? a0 : 0n;
    in1 = a1 > 0n ? a1 : 0n;
    const tokenIn = tokenIs0 ? in0 : in1;
    const tokenAmt = tokenIs0 ? (a0 < 0n ? -a0 : a0) : (a1 < 0n ? -a1 : a1);
    return { block: Number(log.blockNumber), tx: log.transactionHash, tokenIsBuy: tokenIn === 0n, amount: tokenAmt };
  }
  if (t === TOPIC.v2 || t === TOPIC.aero) {
    const a0In = u(word(d, 0)), a1In = u(word(d, 1)), a0Out = u(word(d, 2)), a1Out = u(word(d, 3));
    const tokenIn = tokenIs0 ? a0In : a1In;
    const tokenOut = tokenIs0 ? a0Out : a1Out;
    return {
      block: Number(log.blockNumber),
      tx: log.transactionHash,
      tokenIsBuy: tokenOut > 0n && tokenIn === 0n,
      amount: tokenOut > tokenIn ? tokenOut : tokenIn,
    };
  }
  return null;
}

async function recentSwaps(chain: Chain, poolAddr: string, tokenIs0: boolean, head: number) {
  // Start small and widen: a busy pool (AERO, thousands of swaps an hour) makes public RPCs
  // reject a full hour of logs, while a quiet token needs hours to show anything. If a wider
  // window is refused, keep the narrower one we already have.
  let span = Math.round(CHAINS[chain].blocksPerHour / 6);
  let logs: any[] = [];
  let hours = 0;
  for (let w = 0; w < MAX_WINDOWS; w++) {
    let got: any[];
    try {
      got = await rpc(chain, "eth_getLogs", [
        {
          address: poolAddr,
          fromBlock: "0x" + Math.max(0, head - span).toString(16),
          toBlock: "0x" + head.toString(16),
          topics: [[TOPIC.v2, TOPIC.v3, TOPIC.aero, TOPIC.pcs3]],
        },
      ]);
    } catch (e) {
      if (w === 0) throw e;
      break;
    }
    logs = got;
    hours = Number((span / CHAINS[chain].blocksPerHour).toFixed(2));
    if (logs.length >= MIN_SWAPS * 2) break;
    span *= 4;
  }
  const swaps = logs
    .map((l) => decode(l, tokenIs0))
    .filter((x): x is Swap => !!x && x.amount > 0n)
    .slice(-MAX_SWAPS);
  return { swaps, hours };
}

export async function washReport(chain: Chain, token: string) {
  const addr = token.toLowerCase();
  const pools = await findPool(chain, addr);
  if (pools.length === 0) return null;
  // A few blocks behind the tip: the fallback RPCs can lag each other, and asking one for a block
  // only the other has seen fails the whole read ("block range extends beyond current head").
  const head = parseInt(await rpc(chain, "eth_blockNumber", []), 16) - 6;

  let chosen: any = null;
  let data: { swaps: Swap[]; hours: number } = { swaps: [], hours: 0 };
  for (const p of pools) {
    const t0: string = await rpc(chain, "eth_call", [{ to: p.pairAddress, data: "0x0dfe1681" }, "latest"]).catch(() => "0x");
    if (!t0 || t0.length < 66) continue; // not a v2/v3-style pool we can read
    const tokenIs0 = ("0x" + t0.slice(-40)).toLowerCase() === addr;
    const got = await recentSwaps(chain, p.pairAddress, tokenIs0, head);
    if (got.swaps.length > data.swaps.length) {
      chosen = p;
      data = got;
    }
    if (got.swaps.length >= MIN_SWAPS) break;
  }

  const poolInfo = chosen
    ? { address: chosen.pairAddress, dex: chosen.dexId, version: chosen.labels?.[0] ?? null, liquidity_usd: chosen.liquidity?.usd ?? null }
    : null;
  const base = {
    query: { address: token, chain },
    token: { symbol: pools[0]?.baseToken?.address?.toLowerCase() === addr ? pools[0].baseToken.symbol : pools[0]?.quoteToken?.symbol },
    pool: poolInfo,
    window_hours: data.hours,
    swaps_analyzed: data.swaps.length,
  };
  if (data.swaps.length < MIN_SWAPS) {
    return {
      ...base,
      verdict: "insufficient_data",
      explanation: `Only ${data.swaps.length} swaps in the last ${data.hours}h on the deepest readable pool, too few to judge. Thin trading is itself worth knowing: a high reported 24h volume with this little on-chain activity is a red flag.`,
      as_of: new Date().toISOString(),
    };
  }

  // Attribute each swap to its transaction signer.
  const uniqueTx = [...new Set(data.swaps.map((s) => s.tx))];
  const froms = await pool(uniqueTx, 8, async (h) => {
    const tx = await rpc(chain, "eth_getTransactionByHash", [h]).catch(() => null);
    return [h, (tx?.from ?? "unknown").toLowerCase()] as const;
  });
  const signer = new Map(froms);

  type T = { buy: bigint; sell: bigint; swaps: number; blocks: Map<number, { b: boolean; s: boolean }> };
  const traders = new Map<string, T>();
  let total = 0n;
  for (const s of data.swaps) {
    const who = signer.get(s.tx) ?? "unknown";
    const t = traders.get(who) ?? { buy: 0n, sell: 0n, swaps: 0, blocks: new Map() };
    if (s.tokenIsBuy) t.buy += s.amount;
    else t.sell += s.amount;
    t.swaps++;
    const blk = t.blocks.get(s.block) ?? { b: false, s: false };
    if (s.tokenIsBuy) blk.b = true;
    else blk.s = true;
    t.blocks.set(s.block, blk);
    traders.set(who, t);
    total += s.amount;
  }

  const pct = (x: bigint) => (total === 0n ? 0 : Number((x * 10000n) / total) / 100);
  const ranked = [...traders.entries()].sort((a, b) => Number(b[1].buy + b[1].sell - (a[1].buy + a[1].sell)));
  const top3 = ranked.slice(0, 3).reduce((acc, [, t]) => acc + t.buy + t.sell, 0n);

  // Round trip: a trader who both bought and sold, with the smaller side at least 80% of the larger.
  let roundTrip = 0n;
  let roundTrippers = 0;
  let sameBlock = 0;
  for (const [, t] of traders) {
    const lo = t.buy < t.sell ? t.buy : t.sell;
    const hi = t.buy < t.sell ? t.sell : t.buy;
    if (lo > 0n && lo * 10n >= hi * 8n) {
      roundTrip += t.buy + t.sell;
      roundTrippers++;
    }
    for (const [, v] of t.blocks) if (v.b && v.s) sameBlock++;
  }

  const m = {
    distinct_traders: traders.size,
    top3_volume_share_pct: pct(top3),
    round_trip_volume_share_pct: pct(roundTrip),
    round_trip_traders: roundTrippers,
    same_block_buy_and_sell: sameBlock,
    swaps_per_trader: Number((data.swaps.length / traders.size).toFixed(2)),
  };

  const why: string[] = [];
  let score = 0;
  if (m.round_trip_volume_share_pct >= 50) { score += 40; why.push(`${m.round_trip_volume_share_pct}% of volume is wallets buying and selling the same size back`); }
  else if (m.round_trip_volume_share_pct >= 25) { score += 20; why.push(`${m.round_trip_volume_share_pct}% of volume is round trips`); }
  if (m.top3_volume_share_pct >= 70) { score += 30; why.push(`3 wallets made ${m.top3_volume_share_pct}% of all volume`); }
  else if (m.top3_volume_share_pct >= 50) { score += 15; why.push(`3 wallets made ${m.top3_volume_share_pct}% of volume`); }
  if (m.distinct_traders < 8) { score += 20; why.push(`only ${m.distinct_traders} distinct traders across ${data.swaps.length} swaps`); }
  if (m.swaps_per_trader >= 6) { score += 10; why.push(`${m.swaps_per_trader} swaps per trader on average`); }
  if (m.same_block_buy_and_sell >= 3) why.push(`${m.same_block_buy_and_sell} same-block buy+sell pairs (typical of MEV bots, not necessarily wash)`);
  score = Math.min(score, 100);
  const verdict = score >= 60 ? "likely_wash" : score >= 30 ? "suspicious" : "organic";

  return {
    ...base,
    verdict,
    wash_score: score,
    reasons: why.length ? why : ["volume is spread across many independent traders"],
    metrics: m,
    top_traders: ranked.slice(0, 5).map(([w, t]) => ({ wallet: w, volume_share_pct: pct(t.buy + t.sell), swaps: t.swaps, bought_and_sold: t.buy > 0n && t.sell > 0n })),
    caveat: "Market makers and arbitrage bots also trade both sides; a high score means the volume is not broad organic demand, not proof of intent.",
    method: "Swap events read from chain over the window, attributed to each transaction's signer.",
    as_of: new Date().toISOString(),
  };
}

export const washRouter: Router = Router();
washRouter.get("/token/wash/:address", (req: Request, res: Response) => {
  const address = String(req.params.address ?? "");
  const chain = (String(req.query.chain ?? "base") as Chain);
  return serve(
    res,
    "GET /token/wash/:address",
    priceToUsd(PRICE_TOKEN_WASH),
    `${address},${chain}`,
    () => washReport(chain, address),
    "No supported DEX pool found for this token on that chain (Uniswap v2/v3, Aerodrome and PancakeSwap v3 are read; Uniswap v4 is not yet).",
  );
});

const DESC =
  "Is this token's trading volume real? Reads the token's recent swaps straight from chain, attributes each to the wallet that signed it, and measures distinct traders, top-3 wallets' share of volume, round-trip (buy-and-sell-back) share and same-block pairs → organic / suspicious / likely_wash with reasons. Screeners report volume; this says who made it. Base + Ethereum.";

export const washRoutes = {
  "GET /token/wash/:address": {
    accepts: [{ scheme: "exact", price: PRICE_TOKEN_WASH, network: NETWORK, payTo: getReceiveAddress() }],
    description: DESC,
    mimeType: "application/json",
  },
};

export const washCatalog = [{ route: "GET /token/wash/:address", price: PRICE_TOKEN_WASH, params: "?chain=base", desc: DESC }];

export function validateWash(q: Record<string, any>, reqPath?: string): string | null {
  const seg = String(reqPath || "").slice("/token/wash/".length).split("/")[0];
  if (!/^0x[a-fA-F0-9]{40}$/.test(seg)) return "usage: /token/wash/:address?chain=base (address must be 0x + 40 hex)";
  if (q.chain !== undefined && !(String(q.chain) in CHAINS)) return "chain must be one of: base, eth";
  return null;
}

export const washDiscovery = {
  method: "GET" as const,
  path: "/token/wash/{address}",
  price: PRICE_TOKEN_WASH,
  description: DESC,
  input: {
    address: { type: "string", required: true, example: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" },
    chain: { type: "string", required: false, default: "base", enum: ["base", "eth"] },
  },
  output_example: {
    verdict: "organic",
    wash_score: 10,
    reasons: ["volume is spread across many independent traders"],
    metrics: { distinct_traders: 61, top3_volume_share_pct: 31.2, round_trip_volume_share_pct: 8.4, round_trip_traders: 3, same_block_buy_and_sell: 1, swaps_per_trader: 2.1 },
    window_hours: 1,
    swaps_analyzed: 128,
  },
};
