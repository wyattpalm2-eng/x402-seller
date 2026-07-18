/**
 * Wallet helper.
 *
 * The x402 SELLER only needs a receiving ADDRESS to collect USDC. No private
 * key is required on the server to get paid. But to ever MOVE the USDC you
 * collect, you need the key. So this generates a real keypair once, stores the
 * key locally (chmod 600), and hands the address to the server.
 *
 * Precedence for the receive address:
 *   1. PAY_TO in .env  (use this once you have your own wallet)
 *   2. wallet.json     (auto-generated hot wallet, created on first run)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WALLET_PATH = path.join(__dirname, "..", "wallet.json");

type WalletFile = { address: string; privateKey: string; createdAt: string };

function loadOrCreateWallet(): WalletFile {
  if (fs.existsSync(WALLET_PATH)) {
    return JSON.parse(fs.readFileSync(WALLET_PATH, "utf-8")) as WalletFile;
  }
  const privateKey = generatePrivateKey();
  const account = privateKeyToAccount(privateKey);
  const wallet: WalletFile = {
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  };
  fs.writeFileSync(WALLET_PATH, JSON.stringify(wallet, null, 2), { mode: 0o600 });
  return wallet;
}

/** The address the server should tell buyers to pay. */
export function getReceiveAddress(): string {
  const fromEnv = process.env.PAY_TO?.trim();
  if (fromEnv) return fromEnv;
  return loadOrCreateWallet().address;
}

// Run directly: `npm run wallet` — generate/show the wallet.
// (pathToFileURL handles spaces in the path, e.g. "Claude Code".)
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const w = loadOrCreateWallet();
  const usingEnv = !!process.env.PAY_TO?.trim();
  console.log("\n  x402-seller wallet");
  console.log("  ------------------");
  console.log(`  Receive address : ${getReceiveAddress()}`);
  if (usingEnv) {
    console.log("  (from PAY_TO in .env — the generated wallet.json is not being used)");
  } else {
    console.log(`  Key stored at   : ${WALLET_PATH}  (chmod 600)`);
    console.log("  ** Back this file up. Whoever holds it controls the funds. **");
  }
  console.log("");
}
