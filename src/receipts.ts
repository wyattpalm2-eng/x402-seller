/**
 * Opt-in cryptographic delivery receipts (`X-Paxiom-Receipt`, paxiom.receipt.v0).
 *
 * `settlements.jsonl` in stats.ts records for OUR books whether a delivered call actually settled.
 * This is the mirror image for the BUYER'S books: when `PAXIOM_PRIVATE_KEY_PEM` is set, every 2xx
 * JSON delivery on a paid route (and on `/demo/*` so evaluators can test verification before
 * spending) carries an Ed25519-signed `X-Paxiom-Receipt` header binding:
 *   - canonical SHA-256 of the delivered JSON body (`delivery.outputHash`)
 *   - request method + URL + body digest (`request.requestHash`)
 *   - quoted network/price + the settled `PAYMENT-RESPONSE` tx hash (`payment.settlement`)
 *
 * Mounted BEFORE `paymentMiddleware(routes, resourceServer)`. `@x402/express` buffers downstream
 * `res.end`, runs facilitator `processSettlement`, sets `PAYMENT-RESPONSE` on `res`, and only then
 * flushes to the outer `res.end` — so the receipt signs BOTH the exact bytes delivered and the
 * real on-chain settlement tx hash in one pass, and skips 402/4xx/5xx responses automatically.
 *
 * Completely inert (`null`) when `PAXIOM_PRIVATE_KEY_PEM` is unset.
 */
import type { Request, Response, NextFunction } from "express";
import { createReceiptMiddleware, publicKeyFromPrivateKey } from "@paxiom/receipts";
import { priceToUsd } from "./stats.js";

export interface RoutePriceEntry {
  routePath: string;
  priceDisplay: string;
  amountAtomic: string;
}

export interface SellerReceiptSetup {
  keyId: string;
  publicKey: string;
  keyDocument: {
    issuer: string;
    receiptVersion: "paxiom.receipt.v0";
    keys: Array<{
      keyId: string;
      algorithm: "ed25519";
      publicKey: string;
    }>;
  };
  middleware: (req: Request, res: Response, next: NextFunction) => void;
}

const normPath = (s: string) => s.toLowerCase().replace(/\/+$/, "") || "/";

export function priceToAtomicUsdc(price: string): string {
  const usd = priceToUsd(price);
  if (usd <= 0) return "0";
  return String(Math.round(usd * 1_000_000));
}

function matchRoutePrice(reqPath: string, entries: RoutePriceEntry[]): RoutePriceEntry | null {
  const p = normPath(reqPath);
  for (const entry of entries) {
    const r = normPath(entry.routePath);
    if (!entry.routePath.includes("/:")) {
      if (p === r) return entry;
      continue;
    }
    const base = normPath(entry.routePath.split("/:")[0]);
    if (p === base || p.startsWith(base + "/")) return entry;
  }
  return null;
}

function appendExposeHeader(res: Response, headerName: string): void {
  const existing = res.getHeader("access-control-expose-headers");
  const current = existing == null ? "" : Array.isArray(existing) ? existing.join(", ") : String(existing);
  const parts = current
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.some((p) => p.toLowerCase() === headerName.toLowerCase())) {
    parts.push(headerName);
    res.setHeader("Access-Control-Expose-Headers", parts.join(", "));
  }
}

export function createSellerReceiptSetup(opts: {
  privateKeyPem?: string;
  keyId?: string;
  issuerName?: string;
  publicBaseUrl?: string;
  network: string;
  routes: Record<string, { accepts?: Array<{ price?: string }> }>;
}): SellerReceiptSetup | null {
  const rawPem = opts.privateKeyPem?.replace(/\\n/g, "\n").trim();
  if (!rawPem) return null;

  const keyId = opts.keyId?.trim() || "x402-seller-ed25519-1";
  const issuerName = opts.issuerName?.trim() || "x402-seller";
  const publicBaseUrl = opts.publicBaseUrl?.trim().replace(/\/+$/, "") || "";
  const publicKey = publicKeyFromPrivateKey(rawPem);

  const routeEntries: RoutePriceEntry[] = Object.entries(opts.routes).map(([key, cfg]) => {
    const routePath = key.includes(" ") ? key.split(" ")[1] : key;
    const priceDisplay = String(cfg?.accepts?.[0]?.price || "$0");
    return {
      routePath,
      priceDisplay,
      amountAtomic: priceToAtomicUsdc(priceDisplay),
    };
  });

  const inner = createReceiptMiddleware({
    privateKeyPem: rawPem,
    issuer: {
      name: issuerName,
      keyId,
      ...(publicBaseUrl ? { uri: publicBaseUrl } : {}),
    },
    serviceName: issuerName,
    baseUrl: publicBaseUrl,
    paymentDefaults: {
      scheme: "exact",
      network: opts.network,
      asset: "USDC",
    },
    resolvePayment: ({ req, res }) => {
      appendExposeHeader(res as unknown as Response, "X-Paxiom-Receipt");
      const reqPath = (req as Request).path || String(req.url || "/").split("?")[0];
      if (normPath(reqPath).startsWith("/demo/")) {
        return {
          amountAtomic: "0",
          amountDisplay: "$0",
        };
      }
      const matched = matchRoutePrice(reqPath, routeEntries);
      return matched
        ? {
            amountAtomic: matched.amountAtomic,
            amountDisplay: matched.priceDisplay,
          }
        : {};
    },
  });

  const middleware = (req: Request, res: Response, next: NextFunction): void => {
    if (req.method !== "GET") return next();
    const p = normPath(req.path);
    const isDemo = p === "/demo/vet" || p === "/demo/weather" || p === "/demo/weather/consensus";
    if (!isDemo && !matchRoutePrice(req.path, routeEntries)) return next();
    inner(req, res, next);
  };

  return {
    keyId,
    publicKey,
    keyDocument: {
      issuer: issuerName,
      receiptVersion: "paxiom.receipt.v0",
      keys: [
        {
          keyId,
          algorithm: "ed25519",
          publicKey,
        },
      ],
    },
    middleware,
  };
}
