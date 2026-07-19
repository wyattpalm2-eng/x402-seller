/**
 * mcp/server.mts — MCP server for x402-seller: rug-checking as an agent tool
 * that PAYS FOR ITSELF via x402.
 *
 * Works in three modes, zero-config first:
 *   1. No env at all       → paid tools route through the FREE /demo/vet
 *                            (1 real call/hour) + all free endpoints. Useful
 *                            immediately, no wallet, no signup.
 *   2. X402_BUYER_PK set   → tools call the PAID endpoints and settle USDC on
 *                            Base automatically per call (a burner wallet with
 *                            a few dollars of USDC + a hair of ETH).
 *   3. X402_SELLER_URL set → point at your own self-hosted instance.
 *
 * Add to Claude Code:
 *   claude mcp add rug-check -- npx -y tsx mcp/server.mts     (from a clone)
 * Or any MCP client: command = "npx", args = ["-y","tsx","mcp/server.mts"].
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const BASE = (process.env.X402_SELLER_URL || "https://x402-seller-m8nx.onrender.com").replace(/\/+$/, "");
const PK = process.env.X402_BUYER_PK;

// Paying fetch when a burner key is provided; plain fetch otherwise.
let payFetch: typeof fetch = fetch;
let paid = false;
if (PK && /^0x[0-9a-fA-F]{64}$/.test(PK)) {
  try {
    const { wrapFetchWithPayment } = await import("@x402/fetch");
    const { privateKeyToAccount } = await import("viem/accounts");
    payFetch = wrapFetchWithPayment(fetch, privateKeyToAccount(PK as `0x${string}`) as any) as typeof fetch;
    paid = true;
  } catch {
    /* fall back to free mode */
  }
}

const CHAINS = ["base", "eth", "bsc", "polygon", "arbitrum", "optimism", "solana"] as const;

async function call(path: string, usePaid: boolean): Promise<string> {
  const res = await (usePaid ? payFetch : fetch)(`${BASE}${path}`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(60_000), // Render free tier can cold-start ~50s
  });
  const text = await res.text();
  if (res.status === 402) {
    return JSON.stringify({
      error: "payment_required",
      note: paid
        ? "x402 auto-payment failed — check the burner wallet's USDC/ETH balance on Base."
        : "This is a paid endpoint. Set X402_BUYER_PK to a burner wallet key holding a little USDC on Base to enable auto-payment, or use the free demo tool (vet_token uses it automatically without a key, 1 call/hour).",
      price_info: text.slice(0, 400),
    });
  }
  return text;
}

const server = new McpServer({ name: "x402-rug-check", version: "1.0.0" });

server.tool(
  "vet_token",
  "Go/no-go verdict on a token BEFORE trading it: composite rug score (static analysis + live buy/sell simulation + serial-rugger check) + market structure + liquidity-drain trend → clear/caution/avoid with reasons. EVM chains + Solana. Uses the free demo (1/hour) without a wallet; unlimited with X402_BUYER_PK set (~$0.05/call).",
  { chain: z.enum(CHAINS).default("base"), address: z.string().describe("token contract address (0x… for EVM, mint address for Solana)") },
  async ({ chain, address }) => {
    const q = `?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`;
    const text = paid ? await call(`/vet${q}`, true) : await call(`/demo/vet${q}`, false);
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "rug_check",
  "Detailed composite rug/honeypot report for a token: red/green flags, 0-100 risk score, live simulation results, needs_review disagreement flag. Paid (~$0.03/call, needs X402_BUYER_PK); without a key returns payment instructions — use vet_token for the free demo path.",
  { chain: z.enum(CHAINS).default("base"), address: z.string() },
  async ({ chain, address }) => {
    const text = await call(`/onchain/safety?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`, true);
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "liquidity_trend",
  "Is liquidity DRAINING from this token's pool right now? Verdict from a self-collected reserve time-series (draining_fast/draining/stable/growing + % change). The earliest rug-in-progress signal; this history exists nowhere else. (~$0.01/call with X402_BUYER_PK.)",
  { chain: z.enum(["base", "eth", "bsc", "polygon", "arbitrum", "optimism"]).default("base"), address: z.string() },
  async ({ chain, address }) => {
    const text = await call(`/onchain/liquidity?chain=${encodeURIComponent(chain)}&address=${encodeURIComponent(address)}`, true);
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "market_brief",
  "One-call market regime read for a crypto symbol: spot + perp funding/OI + sentiment → risk_on/risk_off/neutral with reasons. (~$0.03/call with X402_BUYER_PK.)",
  { symbol: z.string().default("BTC") },
  async ({ symbol }) => {
    const text = await call(`/brief?symbol=${encodeURIComponent(symbol)}`, true);
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "track_record",
  "FREE: the service's public self-graded track record — its rug verdicts on fresh Base launches graded against what actually happened hours later, hits AND misses. Use this to judge whether the scorer is worth paying for.",
  {},
  async () => {
    const text = await call("/track-record", false);
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "catalog",
  "FREE: full catalog of endpoints, prices, and payment details for this x402 service.",
  {},
  async () => {
    const text = await call("/catalog", false);
    return { content: [{ type: "text", text }] };
  },
);

await server.connect(new StdioServerTransport());
console.error(`x402-rug-check MCP server up — target: ${BASE} — mode: ${paid ? "PAID (x402 auto-pay)" : "FREE (demo + free endpoints)"}`);
