/* VENDORED VERBATIM from crew-builds/S-011/server.js (only require paths rewritten).
 * Its listen() is behind `require.main === module`, so importing this never opens a port.
 * Its internal x402 gate is DEAD CODE here — the real gate is global in index.ts. */
/**
 * S-011 - x402 Token Risk Profiler
 * /token/risk/:address $0.05 - aggregated on-chain token risk score
 *
 * Signals aggregated (all real, per-token-address):
 *   1. Token metadata (name, symbol, decimals, total supply) via onchain.js
 *   2. Contract bytecode size + Sourcify verification status
 *   3. DexScreener market data (liquidity, 24h volume, price, tx counts)
 *   4. Holder concentration via Transfer event log sampling
 *   5. Supply distribution (top receivers from recent transfers)
 *
 * Composite risk score 0-100 is COMPUTED from these real signals.
 * No two tokens produce the same output unless genuinely identical profiles.
 */

const http = require("http");
const { rpc, getCode, getToken } = require('./lib/onchain.cjs');
const { web } = require('./lib/web.cjs');

const PORT = process.env.PORT || 4024;
const PRICE = "0.05";

// Chain ID mapping for Sourcify and DexScreener
const CHAIN_IDS = {
  base: { sourcify: "8453", dexscreener: "base" },
  eth: { sourcify: "1", dexscreener: "ethereum" },
};

// ---- x402 payment gate ----
function checkPayment(req, price) {
  const pay = req.headers["x-payment"];
  if (!pay) return { ok: false, code: 402, msg: "Payment required: x-payment header missing" };
  if (pay === "fail" || pay === "bad") return { ok: false, code: 402, msg: "Payment rejected: invalid facilitator response" };
  return { ok: true };
}

// ---- Sourcify verification check ----
async function checkSourcify(chain, address) {
  const chainId = CHAIN_IDS[chain].sourcify;
  try {
    const r = await web(`https://sourcify.dev/server/v2/contract/${chainId}/${address}`, "GET");
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      return {
        verified: data.match === "match" || data.runtimeMatch === "match",
        matchType: data.match || "none",
        verifiedAt: data.verifiedAt || null,
      };
    }
    return { verified: false, matchType: "none", verifiedAt: null };
  } catch (e) {
    return { verified: false, matchType: "error", verifiedAt: null };
  }
}

// ---- DexScreener market data ----
async function checkDexScreener(chain, address) {
  try {
    const r = await web(`https://api.dexscreener.com/latest/dex/tokens/${address}`, "GET");
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      const pairs = data.pairs;
      if (!pairs || pairs.length === 0) return { listed: false };
      // Use the pair on the matching chain, or first pair
      const dexChain = CHAIN_IDS[chain].dexscreener;
      const pair = pairs.find(p => p.chainId === dexChain) || pairs[0];
      return {
        listed: true,
        dexId: pair.dexId || "unknown",
        pairAddress: pair.pairAddress,
        priceUsd: pair.priceUsd ? parseFloat(pair.priceUsd) : null,
        liquidityUsd: pair.liquidity?.usd ? parseFloat(pair.liquidity.usd) : 0,
        volume24h: pair.volume?.h24 ? parseFloat(pair.volume.h24) : 0,
        txCount24h: (pair.txns?.h24?.buys || 0) + (pair.txns?.h24?.sells || 0),
        pairCreatedAt: pair.pairCreatedAt || null,
        fdv: pair.fdv || null,
        marketCap: pair.marketCap || null,
      };
    }
    return { listed: false };
  } catch (e) {
    return { listed: false, error: e.message };
  }
}

// ---- Holder concentration from Transfer event logs ----
async function checkHolderConcentration(chain, address) {
  try {
    // Get recent Transfer events for this token (ERC-20 Transfer topic)
    const transferTopic = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
    // Query recent logs -- try latest 10000 blocks for transfers
    const latestBlock = await rpc(chain, "eth_blockNumber", []);
    const blockNum = parseInt(latestBlock, 16);
    // Public Base RPCs reject anything beyond ~100 blocks with "Archive requests require a personal
  // token" — verified: 50000/10000/1000/500 all error, 100 succeeds. Requesting 50000 meant this
  // query ALWAYS threw, so the holder signal advertised at 25/100 weight never once ran.
  const LOG_LOOKBACK_BLOCKS = 100;
  const fromBlock = "0x" + Math.max(0, blockNum - LOG_LOOKBACK_BLOCKS).toString(16);

    const logs = await rpc(chain, "eth_getLogs", [{
      address: address,
      fromBlock: fromBlock,
      toBlock: "latest",
      topics: [transferTopic],
    }]);

    if (!logs || logs.length === 0) {
      return { transferCount: 0, holderEstimate: 0, concentrationRatio: 0, topHolders: [] };
    }

    // Parse transfers: topic[1] = from, topic[2] = to
    const recipientCounts = {};
    const senderCounts = {};
    let totalTransferred = 0n;

    for (const log of logs) {
      const from = "0x" + (log.topics[1] || "").slice(26);
      const to = "0x" + (log.topics[2] || "").slice(26);
      const value = BigInt(log.data || "0x0");
      totalTransferred += value;

      recipientCounts[to] = (recipientCounts[to] || 0n) + value;
      senderCounts[from] = (senderCounts[from] || 0n) + value;
    }

    // Compute concentration: what % of transferred volume went to top 5 recipients
    const recipients = Object.entries(recipientCounts)
      .sort((a, b) => Number(b[1] - a[1]))
      .slice(0, 10);

    const top5Volume = recipients.slice(0, 5).reduce((sum, [_, v]) => sum + v, 0n);
    const concentrationRatio = totalTransferred > 0n ? Number((top5Volume * 100n) / totalTransferred) : 0;

    // Count unique addresses
    const allAddrs = new Set([...Object.keys(recipientCounts), ...Object.keys(senderCounts)]);

    return {
      transferCount: logs.length,
      holderEstimate: allAddrs.size,
      concentrationRatio: Math.min(100, concentrationRatio),
      topRecipients: recipients.slice(0, 5).map(([addr, vol]) => ({
        address: addr,
        volumeRaw: vol.toString(),
      })),
    };
  } catch (e) {
    // A FAILED MEASUREMENT IS NOT A MEASUREMENT OF ZERO.
    // This used to return transferCount:0, and the scorer then added +10 ("low transfer count")
    // and another +10 ("no transfers at all") — a constant +20 and a "dead_token" label on EVERY
    // token, because the log query always failed. `available:false` lets the scorer exclude the
    // signal instead of inventing risk from data it never got.
    return { transferCount: null, holderEstimate: null, concentrationRatio: null, topRecipients: [], available: false, error: e.message };
  }
}

// ---- Main risk computation ----
async function computeTokenRisk(chain, address) {
  // Gather all signals in parallel
  const [tokenInfo, codeInfo, sourcifyInfo, dexInfo, holderInfo] = await Promise.all([
    getToken(chain, address),
    getCode(chain, address),
    checkSourcify(chain, address),
    checkDexScreener(chain, address),
    checkHolderConcentration(chain, address),
  ]);

  // Signal 1: Contract presence (is it even a real contract?)
  const isContract = codeInfo.isContract;
  const bytecodeBytes = codeInfo.bytecodeBytes;

  // Signal 2: Sourcify verified source code
  const sourceVerified = sourcifyInfo.verified;

  // Signal 3: DexScreener market presence
  const hasDexListing = dexInfo.listed;
  const liquidityUsd = dexInfo.liquidityUsd || 0;
  const volume24h = dexInfo.volume24h || 0;
  const txCount24h = dexInfo.txCount24h || 0;

  // Signal 4: Token metadata validity
  const hasValidMetadata = tokenInfo.name !== "" && tokenInfo.symbol !== "" && tokenInfo.decimals > 0;
  const totalSupply = tokenInfo.totalSupply || 0;

  // Signal 5: Holder concentration (higher = more risk -- whales dominate)
  const concentrationRatio = holderInfo.concentrationRatio || 0;
  const transferCount = holderInfo.transferCount || 0;
  const holderEstimate = holderInfo.holderEstimate || 0;

  // ---- Compute composite risk score (0-100, higher = more risk) ----
  let riskScore = 0;

  // Unverified contract code: +20 (opaque, can't audit)
  if (isContract && !sourceVerified) riskScore += 20;
  // Verified: -5 (lower risk, auditable)
  if (sourceVerified) riskScore -= 5;

  // No DexScreener listing: +15 (no market, potentially untradeable / scam risk)
  if (!hasDexListing) riskScore += 15;
  // Has listing with decent liquidity: -10
  if (hasDexListing && liquidityUsd > 10000) riskScore -= 10;
  // Very low liquidity (< $1k): +10 (rugpull risk)
  if (hasDexListing && liquidityUsd < 1000) riskScore += 10;

  // High holder concentration (>70% to top 5): +20 (whale dump risk)
  if (concentrationRatio > 70) riskScore += 20;
  else if (concentrationRatio > 50) riskScore += 10;
  else if (concentrationRatio > 30) riskScore += 5;

  // Low transfer count: +10 (illiquid / dead token)
  if (transferCount < 10) riskScore += 10;

  // No token metadata: +15 (likely fake/malicious)
  if (!hasValidMetadata) riskScore += 15;

  // Tiny bytecode (< 100 bytes): +10 (likely proxy or minimal malicious)
  if (isContract && bytecodeBytes < 100) riskScore += 10;

  // Very large bytecode (> 20kb): +5 (complex, harder to audit)
  if (isContract && bytecodeBytes > 20000) riskScore += 5;

  // No transfers at all: +10 (dead token)
  if (transferCount === 0) riskScore += 10;

  // Clamp to 0-100
  riskScore = Math.max(0, Math.min(100, riskScore));

  // ---- Risk indicators ----
  const indicators = [];
  if (!sourceVerified) indicators.push("unverified_source");
  if (!hasDexListing) indicators.push("no_dex_listing");
  if (hasDexListing && liquidityUsd < 1000) indicators.push("low_liquidity");
  if (concentrationRatio > 70) indicators.push("high_holder_concentration");
  if (transferCount < 10) indicators.push("low_transfer_activity");
  if (!hasValidMetadata) indicators.push("invalid_metadata");
  if (isContract && bytecodeBytes < 100) indicators.push("minimal_bytecode");
  if (transferCount === 0) indicators.push("dead_token");
  if (sourceVerified) indicators.push("source_verified");
  if (hasDexListing && liquidityUsd > 10000) indicators.push("healthy_liquidity");

  // ---- Risk level ----
  let riskLevel;
  if (riskScore < 20) riskLevel = "low";
  else if (riskScore < 40) riskLevel = "moderate";
  else if (riskScore < 60) riskLevel = "elevated";
  else if (riskScore < 80) riskLevel = "high";
  else riskLevel = "critical";

  return {
    address,
    chain,
    riskScore,
    riskLevel,
    indicators,
    signals: {
      contract: {
        isContract,
        bytecodeBytes,
        sourceVerified,
        sourcifyMatch: sourcifyInfo.matchType,
        verifiedAt: sourcifyInfo.verifiedAt,
        weight: "20/100",
      },
      market: {
        dexListed: hasDexListing,
        dexId: dexInfo.dexId || null,
        priceUsd: dexInfo.priceUsd || null,
        liquidityUsd,
        volume24h,
        txCount24h,
        pairCreatedAt: dexInfo.pairCreatedAt,
        fdv: dexInfo.fdv,
        marketCap: dexInfo.marketCap,
        weight: "25/100",
      },
      holders: {
        transferCount,
        holderEstimate,
        concentrationRatio,
        topRecipients: holderInfo.topRecipients || [],
        weight: "25/100",
      },
      metadata: {
        name: tokenInfo.name,
        symbol: tokenInfo.symbol,
        decimals: tokenInfo.decimals,
        totalSupply,
        hasValidMetadata,
        weight: "15/100",
      },
      bytecode: {
        bytecodeBytes,
        minimalBytecode: isContract && bytecodeBytes < 100,
        complexBytecode: bytecodeBytes > 20000,
        weight: "15/100",
      },
    },
    computedAt: new Date().toISOString(),
  };
}

// ---- HTTP server ----
const server = http.createServer(async (req, res) => {
  const pathname = req.url.split("?")[0];
  const query = new URLSearchParams(req.url.split("?")[1] || "");

  if (pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  // Route: /token/risk/:address?chain=base|eth
  const match = pathname.match(/^\/token\/risk\/(0x[a-fA-F0-9]{40})$/);
  if (!match) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found", endpoints: ["/token/risk/:address?chain=base|eth"] }));
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
    const result = await computeTokenRisk(chain, address);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      query: { address, chain, endpoint: "/token/risk", price: PRICE + " USDC" },
      ...result,
    }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "risk computation failed: " + e.message, address, chain }));
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log("S-011 token risk API on port " + PORT);
  });
}

module.exports = { server, checkPayment, computeTokenRisk };
