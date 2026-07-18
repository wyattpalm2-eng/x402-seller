/**
 * Test buyer — simulates an AI agent paying to use your API.
 *
 * It hits a paid endpoint, receives the 402, pays USDC from BUYER_PRIVATE_KEY,
 * retries automatically, and prints the data plus the on-chain settlement.
 *
 * Requires a testnet wallet with a little Base Sepolia USDC + ETH for gas:
 *   1. run this once with no BUYER_PRIVATE_KEY — it prints a fresh address
 *   2. fund that address from a Base Sepolia faucet (USDC + a bit of ETH)
 *   3. put the printed key in .env as BUYER_PRIVATE_KEY and run again
 */
import "dotenv/config";
import { wrapFetchWithPaymentFromConfig, decodePaymentResponseHeader } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const NETWORK = process.env.NETWORK?.trim() || "eip155:84532";
const TARGET = process.env.TARGET_URL?.trim() || "http://localhost:4021/price?symbol=BTC";

let key = process.env.BUYER_PRIVATE_KEY?.trim();
if (!key) {
  key = generatePrivateKey();
  const acct = privateKeyToAccount(key as `0x${string}`);
  console.log("\n  No BUYER_PRIVATE_KEY set. Generated a throwaway test buyer wallet:\n");
  console.log(`    address:     ${acct.address}`);
  console.log(`    privateKey:  ${key}`);
  console.log("\n  To run the full pay -> 200 demo:");
  console.log("    1. Fund that address on Base Sepolia (a faucet gives test USDC + ETH):");
  console.log("         https://faucet.circle.com   (USDC)   +   a Base Sepolia ETH faucet for gas");
  console.log("    2. Add to .env:  BUYER_PRIVATE_KEY=" + key);
  console.log("    3. Re-run:       npm run client\n");
  process.exit(0);
}

const account = privateKeyToAccount(key as `0x${string}`);
const fetchWithPayment = wrapFetchWithPaymentFromConfig(fetch, {
  schemes: [{ network: NETWORK, client: new ExactEvmScheme(account) }],
});

console.log(`\n  Buyer:  ${account.address}`);
console.log(`  GET:    ${TARGET}\n`);

try {
  const res = await fetchWithPayment(TARGET, { method: "GET" });
  console.log(`  HTTP ${res.status}`);
  const settle = res.headers.get("payment-response");
  if (settle) {
    try {
      console.log("  Settlement:", JSON.stringify(decodePaymentResponseHeader(settle)));
    } catch {
      /* header present but not decodable — ignore */
    }
  }
  console.log("  Data:", JSON.stringify(await res.json(), null, 2));
  console.log("\n  Paid, delivered. The USDC just moved to your seller wallet.\n");
} catch (err: any) {
  console.error("\n  Payment/request failed:", err?.message ?? err);
  console.error("  Most common cause: the buyer wallet has no test USDC/ETH yet. Fund it and retry.\n");
  process.exit(1);
}
