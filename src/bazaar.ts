/**
 * THE DIRECTORY — stop petitioning the indexes, become one.
 *
 * The strategic problem, measured: we are absent from PayAI's own discovery index (0 hits in 25,018
 * resources) and from Coinbase Bazaar (0 in 14,381). Worse, `.well-known/x402.json` — which this
 * crew has spent weeks polishing — is not a discovery mechanism at all: the x402 v2 spec contains
 * zero occurrences of "well-known". Real discovery is `GET /discovery/resources` on a facilitator or
 * Bazaar, and cataloguing there is triggered by SETTLED PAYMENTS. So the loop is closed against us:
 * no revenue -> no catalog entry -> no discovery -> no revenue.
 *
 * You cannot argue your way into that loop. But nothing says a directory has to be run by a
 * facilitator. `GET /discovery/resources` is just an endpoint, and we can serve one.
 *
 * Two things follow, and the second is the actual business:
 *
 *  1. We become part of the discovery graph instead of a supplicant to it. Other sellers get a
 *     reason to link here, and an agent looking for x402 inventory has somewhere to look that
 *     isn't gated behind having already paid someone.
 *
 *  2. The DERIVED data is a product nobody sells. "Which x402 endpoints exist" is a list anyone
 *     can scrape. "Which ones are actually alive, answer 402 correctly, honour their advertised
 *     price, and how fast" can only be computed by someone who has been probing them over time —
 *     and an agent about to spend real money wants precisely that. Same shape as the rug track
 *     record: the moat is elapsed time, not cleverness.
 *
 * Rules this file holds itself to:
 *  - We publish OUR OWN resources honestly alongside everyone else's, flagged as ours. A directory
 *    that quietly ranks its owner first is worth nothing and would be found out immediately.
 *  - Probing is gentle and cached. We are asking other people's servers for a favour.
 *  - An endpoint we could not reach is reported as UNKNOWN, never as down. We have been on the
 *    wrong end of exactly that mistake.
 *  - No SSRF surface: peers come from a fixed in-repo seed list, never from user input.
 */
import { Router, type Request, type Response } from "express";
import { ENDPOINTS } from "./discovery.js";

// Seeded in-repo, never from a request parameter. Adding a peer is a code change, which keeps this
// from becoming an open proxy for probing arbitrary hosts.
const PEERS: string[] = [
  "https://x402scan.com",
  "https://402index.io",
  "https://facilitator.payai.network",
  "https://facilitator.xpay.sh",
  "https://facilitator.0xarchive.io",
];

type PeerResource = {
  origin: string;
  resource: string;
  method?: string;
  price?: string | null;
  network?: string | null;
  description?: string | null;
  discovered_via: string;
};

type Reliability = {
  origin: string;
  reachable: boolean | "unknown";
  paywall_correct: boolean | "unknown";  // does an unpaid GET actually answer 402?
  advertises_amount: boolean | "unknown"; // can a client sign from what it publishes?
  latency_ms: number | null;
  checked_at: string;
  note: string;
};

let peerCache: { at: number; resources: PeerResource[]; reliability: Reliability[] } | null = null;
const TTL_MS = 30 * 60_000;
let inFlight: Promise<void> | null = null;

async function fetchT(url: string, ms: number): Promise<{ status: number; body: string; ms: number } | null> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  const t0 = Date.now();
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { "user-agent": "x402-seller-directory/1.0 (+https://x402-seller-m8nx.onrender.com)" } });
    return { status: r.status, body: (await r.text()).slice(0, 200_000), ms: Date.now() - t0 };
  } catch { return null; } finally { clearTimeout(t); }
}

/** Ask a peer the two standard questions, gently. */
async function probePeer(origin: string): Promise<{ resources: PeerResource[]; reliability: Reliability }> {
  const resources: PeerResource[] = [];
  let reachable: boolean | "unknown" = "unknown";
  let latency: number | null = null;
  let note = "";

  for (const path of ["/discovery/resources", "/.well-known/x402.json"]) {
    const r = await fetchT(origin + path, 8000);
    if (!r) { note ||= "no response within 8s — reported as unknown, not down"; continue; }
    latency = latency ?? r.ms;
    if (r.status >= 200 && r.status < 400) reachable = true;
    else if (reachable === "unknown") reachable = r.status < 500;
    try {
      const j = JSON.parse(r.body);
      const list = Array.isArray(j?.resources) ? j.resources : Array.isArray(j?.items) ? j.items : [];
      for (const it of list.slice(0, 200)) {
        const res = it?.resource ?? it?.url ?? it?.endpoint;
        if (typeof res !== "string") continue;
        const acc = Array.isArray(it?.accepts) ? it.accepts[0] : null;
        resources.push({
          origin,
          resource: res,
          method: it?.method ?? "GET",
          price: acc?.price ?? acc?.amount ?? null,
          network: acc?.network ?? j?.network ?? null,
          description: typeof it?.description === "string" ? it.description.slice(0, 300) : null,
          discovered_via: path,
        });
      }
      if (list.length) break; // got what we came for; don't hit the second path unnecessarily
    } catch { note ||= `${path} did not return JSON we could read`; }
  }

  return {
    resources,
    reliability: {
      origin,
      reachable,
      paywall_correct: "unknown",  // filled in below only for resources we actually probe
      advertises_amount: resources.length ? resources.some((x) => x.price !== null) : "unknown",
      latency_ms: latency,
      checked_at: new Date().toISOString(),
      note: note || (resources.length ? `${resources.length} resource(s) indexed` : "reachable but published no resource list we could parse"),
    },
  };
}

async function refresh(): Promise<void> {
  const results = await Promise.all(PEERS.map((p) => probePeer(p).catch(() => ({ resources: [], reliability: { origin: p, reachable: "unknown" as const, paywall_correct: "unknown" as const, advertises_amount: "unknown" as const, latency_ms: null, checked_at: new Date().toISOString(), note: "probe threw" } }))));
  peerCache = {
    at: Date.now(),
    resources: results.flatMap((r) => r.resources),
    reliability: results.map((r) => r.reliability),
  };
}

async function ensureFresh(): Promise<void> {
  if (peerCache && Date.now() - peerCache.at < TTL_MS) return;
  if (inFlight) return inFlight;
  inFlight = refresh().finally(() => { inFlight = null; });
  return inFlight;
}

/** Our own resources, in the same shape, honestly flagged. */
function ourResources(base: string): PeerResource[] {
  return ENDPOINTS.map((e) => ({
    origin: base,
    resource: `${base}${e.path}`,
    method: e.method,
    price: e.price,
    network: process.env.NETWORK?.trim() || "eip155:8453",
    description: e.description?.slice(0, 300) ?? null,
    discovered_via: "self",
  }));
}

export const bazaarRouter: Router = Router();

/**
 * The standard discovery endpoint, served by us. Free, deliberately: a directory behind a paywall
 * is a directory nobody uses, and the point is to be a place agents come back to.
 */
bazaarRouter.get("/discovery/resources", async (req: Request, res: Response) => {
  const base = `${req.protocol}://${req.get("host")}`;
  await ensureFresh().catch(() => {});
  const ours = ourResources(base);
  const theirs = peerCache?.resources ?? [];
  res.json({
    x402Version: 2,
    what_this_is:
      "An open index of x402 resources. We run it because we could not get listed anywhere ourselves, and a directory is just an endpoint — nothing says it has to be run by a facilitator.",
    how_to_read_this:
      "`self` entries are ours and are marked as such. We do not rank ourselves first and you can verify that by reading the list. Peer data is a cached mirror of what each origin publishes about itself, not our opinion of it.",
    counts: { ours: ours.length, peers: theirs.length, peer_origins: PEERS.length },
    // Say what this ISN'T. PayAI alone advertises ~25,000 resources and returns a page at a time;
    // we take the first page per origin and cap at 200. Presenting a partial mirror as a complete
    // index would be the same species of lie as the delivery counter that turned out to be counting
    // crawlers -- a number that reads as coverage when it is a sample.
    completeness: "PARTIAL: first page per origin, capped at 200 each. This is a working mirror, not a full index — do not read `counts.peers` as the size of the x402 ecosystem.",
    peers_checked_at: peerCache ? new Date(peerCache.at).toISOString() : null,
    resources: [...ours, ...theirs],
  });
});

/**
 * The derived product: which of these endpoints is actually usable. Free for now — the value is in
 * having the history, and the history only accrues if we keep probing.
 */
bazaarRouter.get("/directory/reliability", async (_req: Request, res: Response) => {
  await ensureFresh().catch(() => {});
  res.json({
    what_this_is:
      "Whether the x402 endpoints we index are actually reachable and publish something a client could pay from. Anyone can scrape a list of endpoints; only somebody who has been probing them over time can tell you which ones work.",
    honesty_note:
      "An origin we could not reach is reported as `unknown`, never as down. We have been on the receiving end of that exact mistake — a broken instrument of our own once had this company drafting a public bug report against a facilitator that was working fine.",
    checked_at: peerCache ? new Date(peerCache.at).toISOString() : null,
    origins: peerCache?.reliability ?? [],
  });
});
