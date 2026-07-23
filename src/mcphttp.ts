/**
 * mcphttp.ts — a REMOTE MCP server (Streamable HTTP) mounted at /mcp.
 *
 * This makes x402-seller directly usable inside Claude / Cursor / any MCP host
 * WITHOUT the user cloning the repo — and, crucially, it's publishable to the
 * official MCP Registry as a REMOTE server (no npm package needed), which
 * PulseMCP / Glama / mcp.so all ingest. That's a free discovery channel.
 *
 * It exposes a FREE taste of the product: a global daily demo budget on the
 * analysis tools (so we don't give away unlimited paid data), plus the always-
 * free track record and catalog. Agents that like it integrate the paid HTTP
 * API (or pass a wallet) for unlimited use.
 *
 * Stateless transport: a fresh server + transport per request (no session
 * state), which is the simplest robust pattern for request/response tools.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { vetToken } from "./composites.js";
import { launchRadar } from "./alpha.js";
import { safetyReport } from "./safety.js";
import { trackRecordSummary } from "./record.js";
import weatherHandler from "./ported/weather-consensus.handler.cjs";
import { gateConsensus } from "./ported/weather-consensus.js";
import { bumpTool } from "./demand.js";

const CHAINS = ["base", "eth", "bsc", "polygon", "arbitrum", "optimism", "solana"] as const;
const BASE_URL = (process.env.PUBLIC_BASE_URL || "https://x402-seller-m8nx.onrender.com").replace(/\/+$/, "");

// Shared daily demo budget across the analysis tools, so the free remote server
// can't be used to farm unlimited paid data. Paid HTTP API has no such cap.
const DEMO_DAILY = Number(process.env.MCP_DEMO_DAILY || 400);
let _day = "";
let _used = 0;
function demoAllowed(): boolean {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== _day) { _day = today; _used = 0; }
  if (_used >= DEMO_DAILY) return false;
  _used++;
  return true;
}
const overBudget = () => ({
  content: [{ type: "text" as const, text: JSON.stringify({ error: "demo_budget_exhausted", note: `Free MCP demo budget is used up for today. The paid HTTP API has no limits — call ${BASE_URL}/vet etc. with an x402 client, or add a funded wallet.`, paid_api: BASE_URL }) }],
});
// Every tool invocation feeds the real-demand signal (/demand) — which tools do
// actual MCP clients reach for? That's the crew's build compass.
function demoAllowedFor(tool: string): boolean {
  bumpTool(tool);
  return demoAllowed();
}
const ok = (data: unknown) => ({ content: [{ type: "text" as const, text: typeof data === "string" ? data : JSON.stringify(data) }] });

function buildServer(): McpServer {
  const server = new McpServer({ name: "x402-seller", version: "1.0.0" });

  server.tool(
    "vet_token",
    "Go/no-go verdict on a token before trading it: composite rug score (static analysis + live buy/sell simulation + LP-lock/liquidity-pull gate) + market → clear/caution/avoid with reasons. EVM + Solana. FREE demo (shared daily budget); unlimited via the paid HTTP API.",
    { chain: z.enum(CHAINS).default("base"), address: z.string().describe("token contract / mint address") },
    async ({ chain, address }) => {
      if (!demoAllowedFor("vet_token")) return overBudget();
      const data = await vetToken(String(chain).toLowerCase(), String(address)).catch(() => null);
      return data == null ? ok({ error: "not_found", detail: "no data for that token" }) : ok(data);
    },
  );

  server.tool(
    "launch_radar",
    "Discover what just launched AND rug-screen it in one call: fresh token launches ranked safest-first, each with a verdict (a clean contract with unlocked LP is caution, not clear — most fresh rugs are liquidity pulls). The proactive 'safe alpha' feed. FREE demo (shared daily budget).",
    { chain: z.enum(CHAINS).default("base") },
    async ({ chain }) => {
      if (!demoAllowedFor("launch_radar")) return overBudget();
      const data = await launchRadar(String(chain).toLowerCase()).catch(() => null);
      return data == null ? ok({ error: "no_fresh_pools" }) : ok(data);
    },
  );

  server.tool(
    "rug_check",
    "Detailed composite rug/honeypot report for one token: red/green flags, 0-100 risk, live-simulation results, disagreement flag. EVM + Solana. FREE demo (shared daily budget).",
    { chain: z.enum(CHAINS).default("base"), address: z.string() },
    async ({ chain, address }) => {
      if (!demoAllowedFor("rug_check")) return overBudget();
      const data = await safetyReport(String(chain).toLowerCase(), String(address)).catch(() => null);
      return data == null ? ok({ error: "not_found" }) : ok(data);
    },
  );

  server.tool(
    "weather_consensus",
    "Cross-source weather consensus for any coordinates: blends Open-Meteo + NOAA/NWS + 7Timer into one temperature with an agreement score (how much independent models agree). Keyless multi-source ground truth in one call — built by the autonomous crew, ported through the bridge. FREE demo (shared daily budget); unlimited via the paid HTTP API ($0.03).",
    { lat: z.number().min(-90).max(90).describe("latitude"), lon: z.number().min(-180).max(180).describe("longitude") },
    async ({ lat, lon }) => {
      if (!demoAllowedFor("weather_consensus")) return overBudget();
      const data = gateConsensus(await weatherHandler({ lat: String(lat), lon: String(lon) }).catch(() => null));
      return data == null ? ok({ error: "not_found", detail: "fewer than 2 weather sources reachable for those coordinates right now — a consensus of one is not a consensus" }) : ok(data);
    },
  );

  server.tool(
    "truth",
    "FREE, always: the Truth Engine — every endpoint this service sells grades itself against reality in public (rug verdicts vs actual rugs, weather forecasts vs the ERA5 archive, market calls vs realized spot). Returns the doctrine + all three live ledgers' summaries. Judge us by receipts, not claims.",
    {},
    async () => {
      bumpTool("truth");
      const { truthWeatherSummary } = await import("./truth.js");
      const { truthSignalSummary } = await import("./truth-signal.js");
      return ok({
        doctrine: "Every endpoint grades itself against reality in public, forever. All ledgers are git-snapshotted — a verdict can't be rewritten after reality grades it.",
        rug_scorer: (trackRecordSummary() as any)?.stats ?? null,
        weather: truthWeatherSummary(),
        market_calls: truthSignalSummary(),
        human_pages: { receipts: `${BASE_URL}/accuracy`, company: `${BASE_URL}/company`, index: `${BASE_URL}/truth` },
      });
    },
  );

  server.tool(
    "track_record",
    "FREE, always: the service's public self-graded track record — its rug verdicts on fresh launches graded against what actually happened, hits AND misses. Judge the scorer by its receipts.",
    {},
    async () => { bumpTool("track_record"); return ok(trackRecordSummary()); },
  );

  server.tool(
    "catalog",
    "FREE: what x402-seller sells, prices, and how to pay. The paid HTTP API is keyless (pay per call in USDC on Base via x402).",
    {},
    async () =>
      ok({
        service: "x402-seller — rug protection + safe-alpha for autonomous trading agents",
        base_url: BASE_URL,
        keyless: "no signup, no API key — pay per call in USDC on Base via x402",
        flagship: {
          "GET /alpha/launches": "$0.08 — launch radar: discover + rug-screen fresh launches, ranked safest-first",
          "GET /vet": "$0.05 — one-token go/no-go",
          "GET /onchain/safety": "$0.03 — composite rug score (static + live sim)",
          "GET /onchain/liquidity": "$0.01 — liquidity-drain detector",
          "GET /weather/consensus": "$0.03 — cross-source weather consensus + agreement score (multi-model ground truth beyond crypto)",
        },
        discovery: { catalog: `${BASE_URL}/catalog`, llms: `${BASE_URL}/llms.txt`, openapi: `${BASE_URL}/openapi.json`, track_record: `${BASE_URL}/track-record` },
        note: "This remote MCP server offers a free daily demo of vet_token / launch_radar / rug_check. For unlimited use, call the paid HTTP API with an x402 client.",
      }),
  );

  return server;
}

/** Express handler for POST /mcp (Streamable HTTP, stateless). */
export async function handleMcp(req: Request, res: Response): Promise<void> {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "internal error" }, id: null });
    }
  }
}

/** Stateless server: GET (server-initiated SSE) and DELETE (session end) are N/A. */
export function mcpMethodNotAllowed(_req: Request, res: Response): void {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed — this MCP server is stateless; use POST /mcp." }, id: null });
}
