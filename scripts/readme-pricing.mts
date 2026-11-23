/**
 * Regenerate the README's endpoint/price table from the LIVE /catalog, which is built from the same
 * objects as the 402 challenges, so the README cannot drift from what an agent is actually charged.
 * It did drift once: issue #5 found four rows wrong after a re-price.
 *
 *   npx tsx scripts/readme-pricing.mts            # rewrite README.md between the markers
 *   npx tsx scripts/readme-pricing.mts --check    # exit 1 if README.md is stale (for CI)
 */
import fs from "node:fs";

const BASE = process.env.CATALOG_BASE || "https://x402-seller-m8nx.onrender.com";
const START = "<!-- pricing:start -->";
const END = "<!-- pricing:end -->";

const cat: any = await (await fetch(`${BASE}/catalog`)).json();
const rows: any[] = cat.endpoints ?? cat.catalog ?? [];
if (rows.length === 0) throw new Error("catalog returned no endpoints");

const clean = (d: string) => {
  // Drop shouty lead-ins like "FLAGSHIP ANSWER —" or "ANSWER endpoint —".
  const s = String(d || "").replace(/^[A-Z]{4,}[A-Za-z /&-]{0,24}?\s+[—:-]\s+/, "");
  const first = s.split(/(?<=[.!?])\s/)[0];
  return (first.charAt(0).toUpperCase() + first.slice(1)).replace(/\|/g, "\\|");
};
const price = (p: string) => Number(String(p).replace("$", ""));
const sorted = [...rows].sort((a, b) => price(b.price) - price(a.price) || a.route.localeCompare(b.route));

const table = [
  `Generated from the live [/catalog](${BASE}/catalog) by \`scripts/readme-pricing.mts\` (${rows.length} paid routes). The 402 challenge is the price of record; this table is a copy of it.`,
  "",
  "| Route | Price | What you get |",
  "|---|---|---|",
  // A literal | inside a table cell (even in code) ends the cell in GitHub markdown; escape it.
  ...sorted.map((e) => `| \`${`${e.route}${e.params || ""}`.replace(/\|/g, "\\|")}\` | ${e.price} | ${clean(e.desc)} |`),
].join("\n");

const readme = fs.readFileSync("README.md", "utf8");
const a = readme.indexOf(START), b = readme.indexOf(END);
if (a < 0 || b < a) throw new Error(`README.md needs ${START} ... ${END} markers`);
const next = readme.slice(0, a + START.length) + "\n" + table + "\n" + readme.slice(b);

if (process.argv.includes("--check")) {
  if (next !== readme) { console.error("README pricing table is stale: run npx tsx scripts/readme-pricing.mts"); process.exit(1); }
  console.log("README pricing table matches the live catalog");
} else {
  fs.writeFileSync("README.md", next);
  console.log(`wrote ${rows.length} rows`);
}
