/**
 * Data we are not licensed to sell.
 *
 * DefiLlama's Terms of Use (effective 2025-06-24) grant a licence "for personal, non-commercial
 * purposes", forbid exploiting the data "for commercial purposes without prior written consent",
 * forbid reselling or republishing it "in any form without permission", and set liquidated damages
 * of up to USD 100,000 per violation (§7, §8, §14). Routes that serve DefiLlama data, raw or
 * derived, are therefore retired unless DEFILLAMA_LICENSED=1 is set, which should only happen with
 * written permission in hand. Checked 2026-11-24, after /depeg and /stablecoins/flows had been
 * built on it the day before without reading those terms.
 */
export const DEFILLAMA_LICENSED = process.env.DEFILLAMA_LICENSED?.trim() === "1";

export const DEFILLAMA_ROUTES = ["/onchain/defi", "/depeg", "/stablecoins/flows", "/yield/surface"];

export const RETIRED_PATHS: Set<string> = new Set(DEFILLAMA_LICENSED ? [] : DEFILLAMA_ROUTES);

export const RETIRED_DETAIL =
  "Retired: this route served DefiLlama data, which DefiLlama's terms do not allow us to sell without written permission. It is not charged.";
