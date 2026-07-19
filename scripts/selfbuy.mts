/**
 * selfbuy.mts — end-to-end SETTLEMENT PROOF. Makes ONE real x402 purchase
 * against the live service, exactly like a customer agent would:
 *
 *   402 challenge → sign USDC payment → facilitator verifies+settles on Base → data.
 *
 * WHY THIS EXISTS: we have verified thousands of 402 challenges but never a
 * SETTLED mainnet payment. If settlement is silently broken (facilitator
 * config, asset mismatch), every real buyer bounces and the funnel never tells
 * us why. One 5-cent self-purchase proves the entire pipe — that's QA, not
 * fake demand (and it also auto-catalogs the service on Bazaar-style
 * directories that index on first settled payment).
 *
 * USAGE (needs a BURNER wallet holding a little USDC on Base + a hair of ETH):
 *   BUYER_PK=0x<burner-private-key> npx tsx scripts/selfbuy.mts \
 *     "https://x402-seller-m8nx.onrender.com/vet?chain=eth&address=0x6982508145454Ce325dDbE47a25d4ec3d2311933"
 *
 * NEVER use a real wallet's key. Fund a fresh burner with ~$1 USDC, use it here,
 * sweep it back after. The key stays in the env var — never written anywhere.
 */
import { wrapFetchWithPayment } from "@x402/fetch";
import { privateKeyToAccount } from "viem/accounts";

const url = process.argv[2] || "https://x402-seller-m8nx.onrender.com/vet?chain=eth&address=0x6982508145454Ce325dDbE47a25d4ec3d2311933";
const pk = process.env.BUYER_PK;

if (!pk || !/^0x[0-9a-fA-F]{64}$/.test(pk)) {
  console.error("Set BUYER_PK to a BURNER wallet private key (0x + 64 hex). Fund it with ~$1 USDC on Base first.");
  process.exit(1);
}

const account = privateKeyToAccount(pk as `0x${string}`);
console.log(`buyer:  ${account.address}`);
console.log(`target: ${url}\n`);

const payFetch = wrapFetchWithPayment(fetch, account as any);

const t0 = Date.now();
const res = await payFetch(url);
const ms = Date.now() - t0;
const body = await res.text();

console.log(`HTTP ${res.status} in ${ms}ms`);
const payResp = res.headers.get("x-payment-response");
if (payResp) {
  try {
    const decoded = JSON.parse(Buffer.from(payResp, "base64").toString("utf8"));
    console.log("settlement:", JSON.stringify(decoded, null, 2));
  } catch {
    console.log("x-payment-response (raw):", payResp);
  }
}
console.log("\nbody:", body.slice(0, 1200));

if (res.status === 200) {
  console.log("\n✅ FULL LOOP PROVEN: challenge → payment → settlement → data. The pipe works.");
  console.log("   USDC should now be visible at the PAY_TO wallet on Base.");
} else {
  console.log("\n❌ Loop did NOT complete — inspect the status/body above. This is exactly the failure a real buyer would hit.");
}
