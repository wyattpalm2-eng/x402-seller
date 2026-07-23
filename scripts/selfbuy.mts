/**
 * selfbuy.mts — end-to-end SETTLEMENT PROOF against the LIVE seller on Base mainnet.
 *
 *   402 challenge → sign USDC EIP-3009 authorization → facilitator verifies + settles → data.
 *
 * WHY: thousands of 402s verified, but never a SETTLED mainnet payment. If settlement
 * is silently broken (facilitator config, asset mismatch), every real buyer bounces and
 * the funnel never says why. ONE tiny self-purchase proves the entire pipe — that's QA,
 * not fake demand (Tess logs it as "founder settlement test", not revenue). It also
 * auto-catalogs the service on directories that index on first settled payment.
 *
 * USAGE (burner wallet holding ~$1 USDC on Base; gas is the FACILITATOR's problem —
 * the exact scheme is EIP-3009 transferWithAuthorization, the buyer only SIGNS):
 *
 *   npx tsx scripts/selfbuy.mts                     # key from wallet.json (repo burner), buys /price $0.001
 *   npx tsx scripts/selfbuy.mts --full              # buys /price ($0.001) then /weather/consensus ($0.03)
 *   BUYER_PK=0x… npx tsx scripts/selfbuy.mts <url>  # explicit key + explicit target
 *
 * NEVER a real wallet's key. The repo burner (wallet.json, gitignored, chmod 600) is fine.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { privateKeyToAccount } from "viem/accounts";

const BASE = "https://x402-seller-m8nx.onrender.com";
const NETWORK = "eip155:8453" as const; // Base MAINNET — this script exists to prove real settlement
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = "https://mainnet.base.org";
const PAY_TO = "0x72B944dA66263bE35c2a2eDFeF5c525d58fa53Df";

const argUrl = process.argv.find((a) => a.startsWith("http"));
const FULL = process.argv.includes("--full");
const TARGETS = argUrl
  ? [argUrl]
  : FULL
    ? [`${BASE}/price?symbol=BTC`, `${BASE}/weather/consensus?lat=40.71&lon=-74.01`]
    : [`${BASE}/price?symbol=BTC`];

// ── key: env wins; else the repo burner wallet.json ─────────────────────────
let pk = process.env.BUYER_PK?.trim();
if (!pk) {
  try {
    const wPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "wallet.json");
    pk = (JSON.parse(fs.readFileSync(wPath, "utf8")) as { privateKey: string }).privateKey;
    console.log("(using the repo burner from wallet.json — gitignored, chmod 600)");
  } catch { /* fall through */ }
}
if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("No key. Either create wallet.json (npm run wallet) or set BUYER_PK=0x<burner key>.");
  process.exit(1);
}
const account = privateKeyToAccount(pk as `0x${string}`);

// ── preflight: burner USDC balance + seller PAY_TO baseline ─────────────────
async function usdcBal(addr: string): Promise<number | null> {
  try {
    const r = await fetch(RPC, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
        params: [{ to: USDC, data: "0x70a08231000000000000000000000000" + addr.slice(2).toLowerCase() }, "latest"] }),
      signal: AbortSignal.timeout(8000),
    });
    const j: any = await r.json();
    return j?.result && j.result !== "0x" ? Number(BigInt(j.result)) / 1e6 : null;
  } catch { return null; }
}

const [buyerUsdc, sellerBefore] = await Promise.all([usdcBal(account.address), usdcBal(PAY_TO)]);
console.log(`\nbuyer:        ${account.address}   (USDC: ${buyerUsdc ?? "?"})`);
console.log(`seller PAY_TO: ${PAY_TO}   (USDC before: ${sellerBefore ?? "?"})`);
if (buyerUsdc !== null && buyerUsdc <= 0) {
  console.error(`\n❌ The burner holds no USDC on Base. Send ~$1 USDC (Base network!) to:\n   ${account.address}\nthen re-run. (No ETH needed — the facilitator pays gas via EIP-3009.)`);
  process.exit(1);
}
if (buyerUsdc === null)
  console.warn("⚠ Couldn't verify the burner's balance (Base RPC unreachable) — proceeding anyway. If the payment fails with an insufficient-funds error, fund the burner and re-run.");

const payFetch = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
});

let allOk = true;
for (const url of TARGETS) {
  console.log(`\n── GET ${url}`);
  const t0 = Date.now();
  try {
    const res = await payFetch(url, { method: "GET" });
    const ms = Date.now() - t0;
    console.log(`   HTTP ${res.status} in ${ms}ms`);
    const settle = res.headers.get("payment-response") ?? res.headers.get("x-payment-response");
    if (settle) {
      try { console.log("   settlement:", JSON.stringify(decodePaymentResponseHeader(settle))); }
      catch { console.log("   settlement header (raw):", settle.slice(0, 200)); }
    }
    const body = await res.text();
    console.log("   body:", body.slice(0, 400));
    if (res.status !== 200) allOk = false;
  } catch (err: any) {
    allOk = false;
    console.error("   ❌ failed:", err?.message ?? err);
    console.error("   (this is exactly what a real buyer would hit — the failure IS the finding)");
  }
}

// ── receipt: did USDC actually land at PAY_TO? (settlement can lag a few s) ──
await new Promise((r) => setTimeout(r, 6000));
const sellerAfter = await usdcBal(PAY_TO);
console.log(`\nseller USDC after: ${sellerAfter ?? "?"}   (before: ${sellerBefore ?? "?"})`);
if (allOk && sellerAfter !== null && sellerBefore !== null && sellerAfter > sellerBefore) {
  console.log(`\n✅ FULL LOOP PROVEN: challenge → signed payment → facilitator settlement → data delivered,`);
  console.log(`   and +$${(sellerAfter - sellerBefore).toFixed(6)} USDC landed on-chain at PAY_TO.`);
  console.log(`   Within ~15 min: wallet-watch opens a GitHub issue; telemetry.json updates for Tess`);
  console.log(`   (she logs this as "founder settlement test", NOT revenue).`);
} else if (allOk) {
  console.log(`\n🟡 HTTP loop worked but the balance delta isn't visible yet — settlement can lag.`);
  console.log(`   Check in a minute: https://basescan.org/address/${PAY_TO}#tokentxns`);
} else {
  console.log(`\n❌ Loop did NOT complete — the status/body above is the exact bug a real buyer hits. Fix that first.`);
}
