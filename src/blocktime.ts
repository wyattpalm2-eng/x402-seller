/**
 * Blocks per hour, measured from the chain instead of assumed.
 *
 * Several windows in this service were written for Base at 2s blocks (1,800/hour). Base actually
 * produces a block every 0.2s (18,000/hour, measured 2026-11-24), so every "hours" label was 10x
 * too long: /token/wash said 10.7h while reading ~1h, and wallet-watch rescanned 36 minutes while
 * calling it 6 hours. This measures the rate from two block timestamps and caches it, so a future
 * change in block time cannot silently break the windows again.
 */
const RPC: Record<string, string[]> = {
  base: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
  eth: ["https://ethereum-rpc.publicnode.com"],
};
const FALLBACK: Record<string, number> = { base: 18_000, eth: 300 };
const memo = new Map<string, { at: number; bph: number }>();

async function rpc(chain: string, method: string, params: unknown[]): Promise<any> {
  let last: unknown;
  for (const url of RPC[chain] ?? []) {
    try {
      const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: AbortSignal.timeout(10_000) });
      const j: any = await r.json();
      if (j.error) throw new Error(String(j.error.message));
      return j.result;
    } catch (e) { last = e; }
  }
  throw last instanceof Error ? last : new Error("rpc failed");
}

export async function blocksPerHour(chain: string): Promise<number> {
  const hit = memo.get(chain);
  if (hit && Date.now() - hit.at < 6 * 3600 * 1000) return hit.bph;
  try {
    const head = parseInt(await rpc(chain, "eth_blockNumber", []), 16);
    const back = chain === "base" ? 100_000 : 2_000;
    const [a, b] = await Promise.all([
      rpc(chain, "eth_getBlockByNumber", ["0x" + head.toString(16), false]),
      rpc(chain, "eth_getBlockByNumber", ["0x" + (head - back).toString(16), false]),
    ]);
    const secs = parseInt(a.timestamp, 16) - parseInt(b.timestamp, 16);
    const bph = secs > 0 ? Math.round((back / secs) * 3600) : FALLBACK[chain];
    memo.set(chain, { at: Date.now(), bph });
    return bph;
  } catch {
    return FALLBACK[chain] ?? 18_000;
  }
}
