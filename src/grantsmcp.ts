/**
 * grantsmcp.ts — a REMOTE MCP server for U.S. federal grants, mounted at /grants/mcp.
 *
 * Separate endpoint and separate registry listing from /mcp on purpose: that one
 * is rug-protection for trading agents, this is federal funding for nonprofits
 * and small businesses. Same host, different audience — merging them would make
 * both listings incoherent to anyone browsing the registry.
 *
 * Why an MCP server at all: an agent helping a nonprofit find funding has no
 * good way to answer "can we actually apply for this?". Grants.gov publishes
 * machine-readable applicant-type codes on every opportunity, so that question
 * is a mechanical lookup rather than a judgement call — and this exposes it.
 *
 * Everything here runs on keyless public APIs (Grants.gov + USAspending), so
 * there is no budget to protect and the tools are free with no wallet.
 */
import type { Request, Response } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const SEARCH = "https://api.grants.gov/v1/api/search2";
const FETCH = "https://api.grants.gov/v1/api/fetchOpportunity";
const USASPENDING = "https://api.usaspending.gov/api/v2/search/spending_by_award/";

/** Federal applicant-type codes — the whole reason this is mechanical. */
const APPLICANT_TYPES: Record<string, string> = {
  "00": "State governments", "01": "County governments", "02": "City or township governments",
  "04": "Special district governments", "05": "Independent school districts",
  "06": "Public and State controlled institutions of higher education",
  "07": "Native American tribal governments (Federally recognized)",
  "08": "Public housing authorities/Indian housing authorities",
  "11": "Native American tribal organizations (other than Federally recognized)",
  "12": "Nonprofits having a 501(c)(3) status with the IRS",
  "13": "Nonprofits without a 501(c)(3) status with the IRS",
  "20": "Private institutions of higher education", "21": "Individuals",
  "22": "For profit organizations other than small businesses", "23": "Small businesses",
  "25": "Others (see Additional Information on Eligibility)", "99": "Unrestricted",
};
const ORG_TO_CODE: Record<string, string> = {
  nonprofit_501c3: "12", nonprofit_other: "13", small_business: "23", large_business: "22",
  public_university: "06", private_university: "20", state_government: "00",
  county_government: "01", city_government: "02", special_district: "04",
  school_district: "05", tribal_government: "07", tribal_organization: "11",
  housing_authority: "08", individual: "21",
};
const ORG_KEYS = Object.keys(ORG_TO_CODE) as [string, ...string[]];

/** Grants.gov accepts a JSON body under text/plain and 403s an OPTIONS preflight. */
async function gpost(url: string, body: unknown): Promise<any> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 25000);
  try {
    const r = await fetch(url, {
      method: "POST", headers: { "Content-Type": "text/plain" },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!r.ok) throw new Error(`Grants.gov HTTP ${r.status}`);
    return await r.json();
  } finally { clearTimeout(t); }
}

/**
 * Agency titles arrive with HTML entities in them — real example from ACF:
 * "&#8203;&#8203;FY 2026 Basic Center Program&#8203;" (zero-width spaces).
 * Passing those through to an agent means they end up verbatim in whatever the
 * agent writes for a user.
 */
function decodeEntities(s: any): string | null {
  if (s == null) return null;
  return String(s)
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/[​-‍﻿]/g, "")   // zero-width junk, now decoded
    .trim();
}

const money = (v: any): number | null => {
  if (v == null) return null;
  const s = String(v).trim().toLowerCase();
  if (!s || s === "none" || s === "n/a") return null;
  const n = Number(s.replace(/[$,]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const parseDate = (v: any): Date | null => {
  if (!v) return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return new Date(`${m[3]}-${m[1]}-${m[2]}T00:00:00Z`);
  const d = new Date(s.replace(/\s+(EST|EDT|CST|CDT|MST|MDT|PST|PDT)$/i, " UTC"));
  return isNaN(d.getTime()) ? null : d;
};

type Elig = { status: "ELIGIBLE" | "NEEDS_REVIEW" | "INELIGIBLE"; reason: string };

/**
 * Absence of evidence is never eligibility. An opportunity with no published
 * applicant types, or only "Others (see text)", is NEEDS_REVIEW — never a green
 * light. Reporting a guess as a verdict is the one failure mode that would make
 * this worse than useless to an agent acting on it.
 */
function checkEligibility(orgType: string, applicantTypes: any[]): Elig {
  const mine = ORG_TO_CODE[orgType];
  if (!mine) return { status: "NEEDS_REVIEW", reason: `Unrecognized organization type "${orgType}".` };
  const codes = (applicantTypes || []).map((t) => String(t?.id ?? t).padStart(2, "0"));
  if (!codes.length) return { status: "NEEDS_REVIEW", reason: "No applicant-type codes published; eligibility cannot be confirmed from the data. Read the announcement." };
  if (codes.includes(mine)) return { status: "ELIGIBLE", reason: `Explicitly lists "${APPLICANT_TYPES[mine]}" (code ${mine}) as eligible.` };
  if (codes.includes("99")) return { status: "ELIGIBLE", reason: "Marked Unrestricted (code 99) — open to any entity type." };
  if (codes.includes("25")) return { status: "NEEDS_REVIEW", reason: `Your type is not listed, but "Others (see text)" (code 25) is. Eligibility depends on prose in the announcement.` };
  return { status: "INELIGIBLE", reason: `Your type (${APPLICANT_TYPES[mine]}) is not among eligible applicants. Eligible: ${codes.map((c) => APPLICANT_TYPES[c] || c).join("; ")}.` };
}

async function fetchOpp(id: string) {
  const j = await gpost(FETCH, { opportunityId: String(id) });
  const d = j?.data || {}, s = d.synopsis || {};
  return {
    id: String(id), number: decodeEntities(d.opportunityNumber), title: decodeEntities(d.opportunityTitle),
    agency: decodeEntities(s.agencyName), description: decodeEntities(s.synopsisDesc),
    applicantTypes: s.applicantTypes || [], eligibilityNotes: s.applicantEligibilityDesc ?? null,
    awardCeiling: money(s.awardCeiling), awardFloor: money(s.awardFloor),
    costSharingRequired: s.costSharing === true,
    closeDate: parseDate(s.responseDate), contactEmail: s.agencyContactEmail ?? null,
    cfdaNumbers: (d.cfdas || []).map((c: any) => c?.cfdaNumber).filter(Boolean) as string[],
    url: `https://www.grants.gov/search-results-detail/${id}`,
  };
}

const cfdaCache = new Map<string, any>();
async function priorAwards(cfda: string) {
  if (!cfda) return null;
  if (cfdaCache.has(cfda)) return cfdaCache.get(cfda);
  const end = new Date(), start = new Date(end.getFullYear() - 3, end.getMonth(), end.getDate());
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  try {
    const r = await fetch(USASPENDING, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filters: { award_type_codes: ["02", "03", "04", "05"], program_numbers: [cfda],
          time_period: [{ start_date: fmt(start), end_date: fmt(end) }] },
        fields: ["Recipient Name", "Award Amount"], limit: 25, sort: "Award Amount", order: "desc", page: 1,
      }),
    });
    if (!r.ok) throw new Error(`USAspending HTTP ${r.status}`);
    const rows = (await r.json())?.results || [];
    if (!rows.length) { cfdaCache.set(cfda, null); return null; }
    const amts = rows.map((x: any) => Number(x["Award Amount"])).filter(Number.isFinite).sort((a: number, b: number) => a - b);
    const mid = Math.floor(amts.length / 2);
    const out = {
      cfda, sampleSize: rows.length,
      medianAward: amts.length % 2 ? amts[mid] : Math.round((amts[mid - 1] + amts[mid]) / 2),
      largestAward: amts[amts.length - 1],
      topRecipients: [...new Set(rows.map((x: any) => x["Recipient Name"]).filter(Boolean))].slice(0, 5),
    };
    cfdaCache.set(cfda, out);
    return out;
  } catch { cfdaCache.set(cfda, null); return null; }
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null as any; } }
  }));
  return out;
}

async function findGrants(orgType: string, keyword: string, limit: number, includeForecasted: boolean) {
  const code = ORG_TO_CODE[orgType];
  const statuses = includeForecasted ? "posted|forecasted" : "posted";
  const search = async (elig: string) => {
    const j = await gpost(SEARCH, { rows: 60, keyword: keyword || "", oppStatuses: statuses, eligibilities: elig });
    return (j?.data?.oppHits || []) as any[];
  };
  const primary = await search(code);
  const seen = new Set(primary.map((h) => String(h.id)));
  const unrestricted = (await search("99")).filter((h) => !seen.has(String(h.id)));
  const hits = primary.concat(unrestricted).slice(0, Math.max(limit * 3, 30));

  const statusById = new Map(hits.map((h) => [String(h.id), h.oppStatus]));
  const details = (await mapLimit(hits, 10, (h) => fetchOpp(h.id))).filter(Boolean);

  const now = Date.now();
  const scored = details.map((o: any) => {
    const elig = checkEligibility(orgType, o.applicantTypes);
    const status = statusById.get(o.id);
    const days = o.closeDate ? Math.floor((o.closeDate.getTime() - now) / 86400000) : null;
    return { o, elig, status, days };
  }).filter((x) => x.elig.status !== "INELIGIBLE" && (x.days == null || x.days >= 0));

  // Rank: confirmed eligibility first, then a deadline that is actually
  // actionable. Sorting purely by soonest put grants closing TODAY at the top —
  // technically "most urgent", useless in practice, since nobody assembles a
  // federal application in under a week. Those still appear, flagged, but below
  // anything you could realistically still win.
  const MIN_DAYS = 7;
  const actionable = (d: number | null) => (d == null ? 1 : d >= MIN_DAYS ? 0 : 2);
  scored.sort((a, b) => {
    const ae = a.elig.status === "ELIGIBLE" ? 0 : 1, be = b.elig.status === "ELIGIBLE" ? 0 : 1;
    if (ae !== be) return ae - be;
    const aa = actionable(a.days), ba = actionable(b.days);
    if (aa !== ba) return aa - ba;
    return (a.days ?? 1e9) - (b.days ?? 1e9);
  });

  const top = scored.slice(0, limit);
  const enriched = await mapLimit(top, 8, async (x) => ({
    ...x, prior: x.o.cfdaNumbers[0] ? await priorAwards(x.o.cfdaNumbers[0]) : null,
  }));

  return {
    organizationType: orgType,
    filedUnderCode: `${code} — ${APPLICANT_TYPES[code]}`,
    scanned: details.length,
    returned: enriched.length,
    opportunities: enriched.map((x: any) => ({
      title: x.o.title, opportunityNumber: x.o.number, agency: x.o.agency,
      eligibility: x.elig.status, eligibilityReason: x.elig.reason,
      status: x.status === "forecasted" ? "forecasted (not open yet)" : "posted",
      closeDate: x.o.closeDate ? x.o.closeDate.toISOString().slice(0, 10) : null,
      daysUntilDeadline: x.days,
      deadlineWarning: x.days != null && x.days < 7
        ? `Closes in ${x.days} day(s) — almost certainly too soon to assemble a competitive federal application.`
        : undefined,
      awardFloor: x.o.awardFloor, awardCeiling: x.o.awardCeiling,
      costSharingRequired: x.o.costSharingRequired,
      cfda: x.o.cfdaNumbers[0] ?? null,
      priorAwards: x.prior ? {
        medianAward: x.prior.medianAward, largestAward: x.prior.largestAward,
        sampleSize: x.prior.sampleSize, recentRecipients: x.prior.topRecipients,
        note: "Reported federal awards under this CFDA program in the last 3 years. If the median is far above your ask, you are competing with much larger institutions.",
      } : null,
      contactEmail: x.o.contactEmail, url: x.o.url,
    })),
    note: "Filtered by the applicant-type code the agency itself published. NEEDS_REVIEW means eligibility is decided by prose in the announcement and could not be settled from structured data — read it before investing time.",
  };
}

const ok = (d: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(d) }] });

function buildGrantsServer(): McpServer {
  const server = new McpServer({ name: "federal-grants", version: "1.0.0" });

  server.tool(
    "find_federal_grants",
    "Find open U.S. federal grant opportunities an organization is ACTUALLY eligible to apply for. Filters by the machine-readable applicant-type code Grants.gov publishes on every opportunity, so ineligible opportunities are excluded rather than ranked low. Returns deadlines, award ceilings, cost-sharing requirements, and what prior winners of the same program actually received. Free, no key, live federal data.",
    {
      organizationType: z.enum(ORG_KEYS).describe("The federal applicant category the organization files under, e.g. nonprofit_501c3, small_business, tribal_government, school_district."),
      keyword: z.string().optional().describe("Mission or topic, e.g. 'housing', 'mental health', 'workforce'. Broad single terms return more."),
      limit: z.number().int().min(1).max(25).optional().describe("Max opportunities to return (default 10)."),
      includeForecasted: z.boolean().optional().describe("Include opportunities announced but not yet open — useful for preparing early."),
    },
    async ({ organizationType, keyword, limit, includeForecasted }) => {
      try {
        return ok(await findGrants(organizationType, keyword || "", limit || 10, includeForecasted === true));
      } catch (e: any) { return ok({ error: `Federal API unavailable: ${e.message}` }); }
    },
  );

  server.tool(
    "check_grant_eligibility",
    "Given a Grants.gov opportunity ID and an organization type, return a definitive eligibility verdict with the reason. ELIGIBLE / INELIGIBLE / NEEDS_REVIEW. Never guesses: an opportunity that publishes no applicant types, or only 'Others (see text)', returns NEEDS_REVIEW rather than a false green light.",
    {
      opportunityId: z.string().describe("Numeric Grants.gov opportunity id, e.g. '357305'."),
      organizationType: z.enum(ORG_KEYS).describe("The federal applicant category to test against."),
    },
    async ({ opportunityId, organizationType }) => {
      try {
        const o = await fetchOpp(opportunityId);
        const e = checkEligibility(organizationType, o.applicantTypes);
        return ok({
          title: o.title, opportunityNumber: o.number, agency: o.agency,
          eligibility: e.status, reason: e.reason,
          eligibleApplicantTypes: (o.applicantTypes || []).map((t: any) => `${t.id} — ${APPLICANT_TYPES[String(t.id).padStart(2, "0")] || t.description}`),
          closeDate: o.closeDate ? o.closeDate.toISOString().slice(0, 10) : null,
          awardCeiling: o.awardCeiling, costSharingRequired: o.costSharingRequired,
          agencyEligibilityNotes: o.eligibilityNotes ? String(o.eligibilityNotes).slice(0, 800) : null,
          url: o.url,
        });
      } catch (e: any) { return ok({ error: `Could not fetch opportunity ${opportunityId}: ${e.message}` }); }
    },
  );

  server.tool(
    "grant_program_history",
    "What a federal grant program has actually awarded before, by CFDA/assistance-listing number: median award, largest award, and recent recipients from USAspending.gov. Use it to sanity-check whether a request is realistic — a $150k ask against a program with a $40M median means competing with major institutions.",
    { cfda: z.string().describe("CFDA / assistance listing number, e.g. '93.243'.") },
    async ({ cfda }) => {
      const p = await priorAwards(cfda);
      return ok(p ? { ...p, note: "Reported federal awards in the last 3 years." }
                  : { cfda, sampleSize: 0, note: "No reported awards found for this program in the last 3 years." });
    },
  );

  return server;
}

/** Stateless: a fresh server + transport per request, matching /mcp. */
export async function handleGrantsMcp(req: Request, res: Response) {
  try {
    const server = buildGrantsServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { transport.close(); server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err: any) {
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: String(err?.message || err) }, id: null });
    }
  }
}

export function grantsMcpMethodNotAllowed(_req: Request, res: Response) {
  res.status(405).json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed. Use POST for MCP." }, id: null });
}
