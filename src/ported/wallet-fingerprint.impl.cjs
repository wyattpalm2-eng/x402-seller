/* VENDORED VERBATIM from crew-builds/S-009/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
/**
 * S-009 - x402 On-Chain Wallet Fingerprint API
 * /wallet/fingerprint $0.05 - composite risk score from 4+ live on-chain signals
 *
 * Signals aggregated (via toolshed/onchain.js -- REAL per-address data):
 *   1. Native balance (ETH on Base or Ethereum)
 *   2. Transaction count / nonce (activity age + volume)
 *   3. Contract bytecode size (is it a contract? how complex?)
 *   4. ERC-20 token holdings (sample well-known tokens on the chain)
 *   5. First-activity age estimate (from nonce as proxy)
 *  6. DeFi protocol exposure via DefiLlama (cross-source enrichment)
 *
 * The composite fingerprint score is COMPUTED from these real signals --
 * no two addresses produce the same output unless they genuinely have
 * identical on-chain profiles. DefiLlama adds cross-source TVL data.
 */

const http = require("http");
const { getAccount, getCode, getToken, rpc } = require('./lib/onchain.cjs');
const defillama = require('./lib/defillama.cjs');

const PORT = process.env.PORT || 4024;
const PRICE = "0.05";

// Well-known ERC-20 tokens to sample for wallet holdings, PER CHAIN.
//
// This used to be a single BASE_TOKENS list applied to whatever chain the caller passed, while the
// route accepted ?chain=eth. None of the four contracts exist on Ethereum mainnet (verified with
// the code's own getCode(): all four return isContract=false, 0 bytes), so on eth the token sample
// was always empty. That silently zeroed FOUR scoring components -- token diversity (20), the
// diversity bonus (10), DeFi exposure (15) and the DeFi bonus (10) -- so 45 of 100 points were
// unreachable and every Ethereum wallet, including known whales, scored as an empty account.
// The catalog advertised "for any Base or Ethereum address ... ERC-20 token holdings, and DeFi
// protocol exposure", which was simply untrue on one of the two chains it named.
const TOKENS_BY_CHAIN = {
  base: [
    "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", // USDC on Base
    "0x4200000000000000000000000000000000000006", // WETH on Base
    "0x50c5725949A6F0c72E6C4a641F24049A393e1418", // DEGEN on Base
    "0x2Ae3F1Ec7F218F39a9DBDc0471F457033285A09B", // AERO on Base
  ],
  eth: [
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", // USDC on Ethereum
    "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH on Ethereum
    "0x6B175474E89094C44Da98b954EedeAC495271d0F", // DAI on Ethereum
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9", // AAVE on Ethereum
  ],
};
function tokensFor(chain) {
  return TOKENS_BY_CHAIN[String(chain || "").toLowerCase()] || TOKENS_BY_CHAIN.base;
}

// Map token symbols to known DeFi protocols for TVL exposure analysis
const TOKEN_TO_PROTOCOL = {
  "usdc": "aave",
  "weth": "uniswap", 
  "degen": "aerodrome",
  "aero": "aerodrome"
};

// ---- x402 payment gate ----
function checkPayment(req, price) {
  const pay = req.headers["x-payment"];
  if (!pay) return { ok: false, code: 402, msg: "Payment required: x-payment header missing" };
  if (pay === "fail" || pay === "bad") return { ok: false, code: 402, msg: "Payment rejected: invalid facilitator response" };
  return { ok: true };
}

// ---- Fetch all on-chain signals for a wallet ----
async function fetchWalletSignals(chain, address) {
  // 1. Account data: balance, tx count, is-contract
  const account = await getAccount(chain, address);

  // 2. Contract bytecode size
  const code = await getCode(chain, address);

  // 3. Sample ERC-20 token balances (try each known token)
  const tokenBalances = [];
  for (const tokenAddr of tokensFor(chain)) {
    try {
      const result = await rpc(chain, "eth_call", [
        { to: tokenAddr, data: "0x70a08231000000000000000000000000" + address.toLowerCase().replace("0x", "") },
        "latest",
      ]);
      const balanceHex = result && result !== "0x" ? result : "0x0";
      const balance = BigInt(balanceHex);
      if (balance > 0n) {
        // Get token metadata
        let symbol = "";
        try {
          const symResult = await rpc(chain, "eth_call", [{ to: tokenAddr, data: "0x95d89b41" }, "latest"]);
          // Decode ABI string
          if (symResult && symResult !== "0x") {
            const b = symResult.slice(2);
            const len = parseInt(b.slice(64, 128), 16);
            const data = b.slice(128, 128 + len * 2);
            symbol = Buffer.from(data, "hex").toString("utf8");
          }
        } catch (e) { symbol = "unknown"; }
        tokenBalances.push({
          token: tokenAddr,
          symbol: symbol,
          balance: balance.toString(),
          hasBalance: true,
        });
      }
    } catch (e) {
      // Token call failed, skip
    }
  }

  // 4. Compute derived signals
  const nativeBalance = parseFloat(account.nativeBalance);
  const txCount = account.txCount;
  const bytecodeBytes = code.bytecodeBytes;
  const isContract = account.isContract;
  const tokenCount = tokenBalances.length;

  // 5. Estimate wallet activity profile
  // txCount as proxy for age: wallets with high nonce are older/more active
  let activityLevel;
  if (txCount === 0) activityLevel = "dormant";
  else if (txCount < 10) activityLevel = "new";
  else if (txCount < 100) activityLevel = "moderate";
  else if (txCount < 1000) activityLevel = "active";
  else activityLevel = "heavy";

  // 6. Compute composite fingerprint score (0-100)
  let score = 0;

  // Balance component (0-25): logarithmic, caps at 100+ ETH
  if (nativeBalance > 0) {
    score += Math.min(25, Math.round(Math.log10(nativeBalance + 1) * 6));
  }

  // Activity component (0-25): based on tx count
  score += Math.min(25, Math.round(Math.log10(txCount + 1) * 8));

  // Contract complexity component (0-20): bytecode size
  if (isContract) {
    score += Math.min(20, Math.round(Math.log10(bytecodeBytes + 1) * 5));
  }

  // Token diversity component (0-20): number of tokens held
  score += Math.min(20, tokenCount * 5);

  // Diversity bonus (0-10): reward wallets with both balance AND activity AND tokens
  if (nativeBalance > 0 && txCount > 10 && tokenCount > 0) score += 10;

  score = Math.min(100, score);

  // 7. Risk indicators
  const riskIndicators = [];
  if (txCount === 0 && !isContract) riskIndicators.push("unused_wallet");
  if (isContract && bytecodeBytes > 10000) riskIndicators.push("complex_contract");
  if (nativeBalance === 0 && tokenCount === 0) riskIndicators.push("empty_wallet");
  if (txCount > 500 && !isContract) riskIndicators.push("high_frequency_eoa");
  if (tokenCount >= 3) riskIndicators.push("diverse_holder");

  // 8. Cross-source DeFi enrichment via DefiLlama -- get protocol TVL for tokens
  let deFiExposure = [];
  for (const token of tokenBalances) {
    const symbol = token.symbol.toLowerCase();
    const protocolName = TOKEN_TO_PROTOCOL[symbol];
    if (protocolName) {
      try {
        const tvl = await defillama.protocolTVL(protocolName);
        if (tvl?.tvlUsd) {
          deFiExposure.push({
            protocol: protocolName,
            tvlUsd: tvl.tvlUsd,
            token: symbol,
          });
        }
      } catch (e) {
        // Skip if DefiLlama lookup fails
      }
    }
  }

  // 9. Enhanced fingerprint with DeFi exposure component (cross-source synthesis)
  // This is the real computed value: on-chain profile + cross-source TVL data
  let enhancedScore = score;
  const deFiScore = Math.min(15, deFiExposure.length * 5);
  enhancedScore += deFiScore;

  // Diversity bonus for DeFi holders
  if (txCount > 10 && deFiExposure.length > 0) {
    enhancedScore += 10;
  }

  enhancedScore = Math.min(100, enhancedScore);

  return {
    address,
    chain,
    fingerprint: {
      compositeScore: enhancedScore,
      activityLevel,
      isContract,
      bytecodeBytes,
      nativeBalance: account.nativeBalance,
      nativeBalanceWei: account.nativeBalanceWei,
      txCount,
      tokenHoldings: tokenCount,
      tokens: tokenBalances,
      deFiExposure: deFiExposure,
    },
    riskIndicators,
    signals: {
      balance: { value: nativeBalance, weight: "25/100", raw: account.nativeBalance },
      activity: { value: txCount, level: activityLevel, weight: "25/100" },
      contractComplexity: { value: bytecodeBytes, isContract, weight: "20/100" },
      tokenDiversity: { value: tokenCount, weight: "20/100" },
      diversityBonus: { value: (nativeBalance > 0 && txCount > 10 && tokenCount > 0) ? 10 : 0, weight: "10/100" },
      deFiExposure: { value: deFiExposure.length, weight: "15/100", protocols: deFiExposure },
    },
    computedAt: new Date().toISOString(),
  };
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];
  const query = new URLSearchParams(req.url.split("?")[1] || "");

  // Health check
  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Route: /wallet/fingerprint/:address?chain=base|eth
  const match = pathname.match(/^\/wallet\/fingerprint\/(0x[a-fA-F0-9]{40})$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", endpoints: ["/wallet/fingerprint/:address?chain=base|eth"] }));
    return;
  }

  const address = match[1];
  const chain = (query.get("chain") || "base").toLowerCase();

  if (chain !== "base" && chain !== "eth") {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "invalid chain, use base or eth" }));
    return;
  }

  // x402 payment gate
  const pay = checkPayment(req, PRICE);
  if (!pay.ok) {
    res.writeHead(pay.code, { "Content-Type": "application/json", "x-payment-required": PRICE });
    res.end(JSON.stringify({ error: pay.msg, price: PRICE + " USDC", header: "x-payment" }));
    return;
  }

  try {
    const result = await fetchWalletSignals(chain, address);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      query: { address, chain, endpoint: "/wallet/fingerprint", price: PRICE + " USDC" },
      ...result,
    }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "on-chain fetch failed: " + e.message, address, chain }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("S-009 wallet fingerprint API on port " + PORT);
  });
}

module.exports = { server, checkPayment, fetchWalletSignals };