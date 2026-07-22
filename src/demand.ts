/**
 * demand.ts — the REAL-demand loop: aggregate, public-safe usage signal.
 *
 * GET /demand publishes what real callers actually do — 402 paywall probes per
 * endpoint (from the funnel), MCP tool calls, and free-demo usage — with zero
 * PII (no IPs, no user-agents). Three consumers:
 *   1. the crew's Nova/Vic on the Windows machine (via bridge telemetry): they
 *      aim builds at what REAL traffic probes, not simulated-buyer guesses;
 *   2. the Mac telemetry writer (works even after /funnel is FUNNEL_KEY-locked);
 *   3. anyone deciding whether to integrate: live proof of what agents sniff.
 *
 * In-memory like /stats — resets on redeploy. Trend truth lives in the vault's
 * telemetry history; on-chain USDC stays the only revenue ledger.
 */
import { demandByEndpoint } from "./funnel.js";

const _mcpToolCalls: Record<string, number> = {};
const _demoCalls: Record<string, number> = {};
const startedAt = new Date().toISOString();

/** Count one MCP tool invocation (called from mcphttp.ts). */
export function bumpTool(name: string): void {
  _mcpToolCalls[name] = (_mcpToolCalls[name] ?? 0) + 1;
}

/** Count one successful free-demo call (called from the /demo/* routes). */
export function bumpDemo(name: string): void {
  _demoCalls[name] = (_demoCalls[name] ?? 0) + 1;
}

export function demandReport() {
  return {
    what_this_is:
      "Real usage signal, aggregated + anonymized: paywall probes per endpoint (a 402 served = a real caller sniffed a price and walked), MCP tool calls, free-demo calls. No IPs, no user-agents. In-memory since startedAt — resets on redeploy.",
    startedAt,
    paywall_probes: demandByEndpoint(), // { "/vet": { views, agent_signal }, ... }
    mcp_tool_calls: { ..._mcpToolCalls },
    demo_calls: { ..._demoCalls },
    how_to_read:
      "agent_signal = probes from plausible programmatic agents (unknown/agent-client UAs); the rest is labeled noise (indexers, monitors, curl). An endpoint with agent_signal and no buys is a real caller who priced it and passed — the most actionable demand data there is.",
    as_of: new Date().toISOString(),
  };
}
