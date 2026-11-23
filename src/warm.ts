/**
 * Keep the homepage example tokens warm.
 *
 * The free checker on / offers AERO, DEGEN and PEPE as one-click examples. Right after a Render
 * restart the market cache is empty and DexScreener often rate-limits Render's shared IP, so the
 * first visitor to click an example got "market: no DEX pair found" for PEPE (2026-11-23), which
 * is the worst possible first impression. Fetching them shortly after boot and every 10 minutes
 * keeps a good reading in the cache's last-good store (served for up to 6h on a 429).
 */
import { tokenSnapshot } from "./crypto.js";

export const EXAMPLES: { chain: string; address: string }[] = [
  { chain: "base", address: "0x940181a94A35A4569E4529A3CDfB74e38FD98631" }, // AERO
  { chain: "base", address: "0x4ed4E862860beD51a9570b96d89aF5E1B0Efefed" }, // DEGEN
  { chain: "eth", address: "0x6982508145454Ce325dDbE47a25d4ec3d2311933" }, // PEPE
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Returns how many examples now have a reading. */
async function warmOnce(): Promise<number> {
  let ok = 0;
  for (const t of EXAMPLES) {
    if (await tokenSnapshot(t.address, undefined, t.chain).catch(() => null)) ok++;
    await sleep(3000); // spaced out: a burst is what triggers the 429s in the first place
  }
  return ok;
}

// Retry every minute until all examples have a reading (a 429 spell after boot can outlast the
// first attempt, as it did on 2026-11-23), then refresh every 10 minutes.
async function loop(): Promise<void> {
  const ok = await warmOnce().catch(() => 0);
  setTimeout(() => void loop(), ok === EXAMPLES.length ? 10 * 60 * 1000 : 60 * 1000).unref?.();
}

export function startWarm(): void {
  setTimeout(() => void loop(), 15_000).unref?.();
}
