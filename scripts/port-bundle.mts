/**
 * scripts/port-bundle.mts — the Mac-side intake for the Windows-crew bridge.
 *
 * Reads a ship bundle (handler.js + PROBE.json + meta.json + PROOF.md), enforces
 * the supply-side contract in code (keyless upstreams only, no secrets, pure
 * handler, correct charge-signal), invokes the handler to prove it returns real
 * data, then STAGES a real x402-seller route + discovery entry.
 *
 * Works in two modes:
 *   - specs-only  (PROBE.json + meta.json present, handler.js/PROOF.md not yet
 *                  synced): validates the mapping + emits the discovery entry.
 *   - full        (all four present): also invokes the handler + stages the port.
 *
 * It never deploys and never moves money. It prepares + proves; the live deploy
 * is Wyatt's red-tier step.   npx tsx scripts/port-bundle.mts <bundleDir>
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SELLER_BASE = "https://x402-seller-m8nx.onrender.com";
const K = { scheme: "exact", network: "eip155:8453", asset: "USDC", payTo: "0x72B944dA66263bE35c2a2eDFeF5c525d58fa53Df", mimeType: "application/json" };

// Keyless upstreams the seller already uses. A SOLD handler may only hit these
// (extend deliberately). Anything keyed = a third-party ToS resale breach.
const KEYLESS_HOSTS = [
  "api.coinbase.com", "api.coingecko.com", "api.dexscreener.com", "api.geckoterminal.com",
  "api.gopluslabs.io", "api.honeypot.is", "api.hyperliquid.xyz", "api.llama.fi", "api.rugcheck.xyz",
  "query1.finance.yahoo.com", "mainnet.base.org", "base.blockscout.com", "cloudflare-eth.com", "eth.llamarpc.com",
  // keyless weather sources the crew's S-006 uses:
  "api.open-meteo.com", "api.weather.gov", "www.7timer.info", "7timer.info",
];
const FORBIDDEN_HOSTS = ["etherscan", "alchemy", "infura", "moralis", "quicknode", "covalent", "thegraph", "dune.com", "birdeye", "helius"];

const BAR = "=".repeat(64);
const bareRoute = (r: unknown) => String(r ?? "").replace(/^GET\s+/i, "").replace(/^\//, "");
const routeKey = (r: unknown) => "GET /" + bareRoute(r);
const slugify = (r: unknown) => bareRoute(r).replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
const hostsIn = (s: string) => [...s.matchAll(/https?:\/\/([a-z0-9.\-]+)/gi)].map((m) => m[1].toLowerCase());
const num = (v: unknown) => (v != null && v !== "" && isFinite(Number(v)) ? Number(v) : undefined);
const priceStr = (p: unknown) => { if (typeof p === "string") return p.startsWith("$") ? p : `$${p}`; const n = Number(p); return `$${n.toFixed(n < 0.01 ? 4 : n < 1 ? 3 : 2)}`; };

function safetyScan(src: string) {
  const reasons: string[] = [], warnings: string[] = [];
  if (/process\.env\b/.test(src)) reasons.push("reads process.env — a pure keyless handler needs no env/secrets");
  if (/\b0x[a-fA-F0-9]{64}\b/.test(src)) reasons.push("contains a 64-hex string (possible private key)");
  if (/require\(['"]express['"]\)|from ['"]express['"]/.test(src)) reasons.push("imports express — handler must be pure logic, no server");
  if (/@x402\//.test(src)) reasons.push("references @x402 — the gate is global on the seller, the handler must not touch it");
  if (/["']source["']\s*:/.test(src)) warnings.push("sets a 'source' field — the server injects source, drop it");
  for (const h of hostsIn(src)) {
    if (FORBIDDEN_HOSTS.some((f) => h.includes(f))) reasons.push(`hits KEYED provider ${h} — reselling its data breaches ToS; keyless only`);
    else if (!KEYLESS_HOSTS.some((k) => h === k || h.endsWith("." + k))) warnings.push(`hits ${h}, not in the keyless allowlist — confirm keyless + resale-safe before deploy`);
  }
  if (!/\bthrow\b/.test(src) && !/return\s+(null|undefined|;)/.test(src))
    warnings.push("no throw / return-null found — confirm it signals uncharged 404/502 on bad or empty data (else buyers pay for junk)");
  return { reasons, warnings };
}

function buildInput(meta: any, probe: any) {
  const out: Record<string, any> = {};
  const ex: Record<string, any> = probe?.probes?.[0]?.params ?? {};
  const p = meta?.params;
  if (Array.isArray(p)) {
    for (const x of p) { const { name, ...rest } = x; if (name) out[name] = { type: "string", ...rest, ...(ex[name] != null && rest.example == null ? { example: num(ex[name]) ?? ex[name] } : {}) }; }
  } else if (p && typeof p === "object") {
    for (const [name, val] of Object.entries<any>(p)) {
      if (val && typeof val === "object") out[name] = { type: "string", ...val };
      else {
        const s = String(val ?? "");
        const numeric = /\.\.|^-?\d/.test(s); // "-90..90" style range → number
        out[name] = { type: numeric ? "number" : "string", required: true, ...(s ? { description: s } : {}), ...(ex[name] != null ? { example: num(ex[name]) ?? ex[name] } : {}) };
      }
    }
  } else {
    for (const [name, v] of Object.entries<any>(ex)) out[name] = { type: num(v) != null ? "number" : "string", required: false, example: num(v) ?? v };
  }
  return out;
}

function sampleParams(probe: any, meta: any) {
  const fromProbe = probe?.probes?.[0]?.params;
  if (fromProbe && typeof fromProbe === "object") return { ...fromProbe };
  const out: Record<string, string> = {};
  const first = probe?.probes?.[0]?.path as string | undefined;
  if (first?.includes("?")) for (const kv of first.split("?")[1].split("&")) { const [k, v] = kv.split("="); if (k) out[k] = decodeURIComponent(v ?? ""); }
  return out;
}

function routeSnippet(route: unknown, slug: string, price: unknown, desc: string) {
  return `// src/ported/${slug}.ts — generated from a crew bundle; handler vendored verbatim.
import { Router } from "express";
import { serve } from "../crypto.js";
import { priceToUsd } from "../stats.js";
import handler from "./${slug}.handler.cjs";  // the crew's pure handler (module.exports)

export const ${slug}Price = "${priceStr(price)}";
export const ${slug}Router: Router = Router();
${slug}Router.get("/${bareRoute(route)}", (req, res) =>
  serve(res, "${routeKey(route)}", priceToUsd(${slug}Price), JSON.stringify(req.query), () => handler({ ...req.query })));

// wire into src/index.ts:
//   app.use(${slug}Router);                                   // before the paymentMiddleware line
//   routes["${routeKey(route)}"] = accept(${slug}Price, ${JSON.stringify(desc || "<desc>")});
`;
}

async function main() {
  const dir = process.argv[2];
  if (!dir) { console.error("usage: tsx scripts/port-bundle.mts <bundleDir>"); process.exit(2); }
  const has = (f: string) => fs.existsSync(path.join(dir, f));
  const reasons: string[] = [], warnings: string[] = [];

  if (!has("PROBE.json") || !has("meta.json")) { console.log(`\n${BAR}\nREFUSED — need at least PROBE.json + meta.json in ${dir}\n${BAR}\n`); process.exitCode = 1; return; }
  let probe: any = {}, meta: any = {};
  try { probe = JSON.parse(fs.readFileSync(path.join(dir, "PROBE.json"), "utf8")); } catch { reasons.push("PROBE.json is not valid JSON"); }
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8")); } catch { reasons.push("meta.json is not valid JSON"); }

  const route = meta.route ?? probe.route;
  const price = meta.priceUSDC ?? probe.priceUSDC ?? probe.price;
  if (!route || !/^(GET\s+)?\//i.test(String(route))) reasons.push(`route invalid (need a path like /weather/consensus): ${route}`);
  if (price == null) reasons.push("no priceUSDC in meta/PROBE");

  const fullPort = has("handler.js") && has("PROOF.md");
  let behaviour = "specs-only (handler.js/PROOF.md not synced yet)";
  if (fullPort) {
    const handlerSrc = fs.readFileSync(path.join(dir, "handler.js"), "utf8");
    const proof = fs.readFileSync(path.join(dir, "PROOF.md"), "utf8");
    if (!/PASS|proven|✅/i.test(proof)) reasons.push("PROOF.md does not show passing gates");
    const scan = safetyScan(handlerSrc); reasons.push(...scan.reasons); warnings.push(...scan.warnings);
    if (!reasons.some((r) => /express|@x402|private key|process\.env/.test(r))) {
      try {
        const mod: any = await import(pathToFileURL(path.resolve(dir, "handler.js")).href);
        const handler = mod.default ?? mod;
        if (typeof handler !== "function") reasons.push("handler.js does not export a function");
        else { const r = await handler(sampleParams(probe, meta)); behaviour = r == null ? "returned null on sample (uncharged-404 path) — ok" : typeof r === "object" ? `returned an object {${Object.keys(r).slice(0, 6).join(", ")}}` : (reasons.push(`handler returned ${typeof r}, must be object|null`), "bad"); }
      } catch (e: any) { behaviour = `threw on sample (uncharged-502 path): ${e?.message ?? e}`; }
    }
  }

  if (reasons.length) { console.log(`\n${BAR}\nREFUSED — bundle does not meet the supply-side contract\n`); for (const r of reasons) console.log("  x  " + r); if (warnings.length) { console.log("\n  warnings:"); for (const w of warnings) console.log("  !  " + w); } console.log(BAR + "\n"); process.exitCode = 1; return; }

  const slug = slugify(route);
  const desc = meta.description ?? meta.valueAdd ?? probe.description ?? "";
  const entry: any = {
    resource: `${SELLER_BASE}/${bareRoute(route)}`, method: "GET",
    accepts: [{ scheme: K.scheme, network: K.network, price: priceStr(price), asset: K.asset, payTo: K.payTo }],
    description: desc, mimeType: K.mimeType, input: buildInput(meta, probe),
    ...(meta.output_example || probe.output_example ? { output_example: meta.output_example ?? probe.output_example } : {}),
  };

  const outDir = path.join(dir, "_ported");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "discovery-entry.json"), JSON.stringify(entry, null, 2));
  fs.writeFileSync(path.join(outDir, `${slug}.route.ts`), routeSnippet(route, slug, price, desc));
  if (fullPort) fs.copyFileSync(path.join(dir, "handler.js"), path.join(outDir, `${slug}.handler.cjs`));

  console.log(`\n${BAR}\n${fullPort ? "STAGED" : "ENTRY-STAGED"} — ${routeKey(route)}  (${fullPort ? "ready for Wyatt's red-tier deploy" : "awaiting handler.js + PROOF.md for the real port"})\n`);
  console.log("  behaviour: " + behaviour);
  console.log("  price:     " + priceStr(price));
  console.log("  slug:      " + slug + "   staged → " + outDir);
  if (warnings.length) { console.log("\n  warnings (non-blocking):"); for (const w of warnings) console.log("  !  " + w); }
  console.log("\n  discovery entry:\n" + JSON.stringify(entry, null, 2).split("\n").map((l) => "    " + l).join("\n"));
  console.log(BAR + "\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
