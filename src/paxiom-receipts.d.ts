declare module "@paxiom/receipts" {
  export interface ReceiptIssuerInfo {
    name: string;
    keyId: string;
    uri?: string;
  }

  export interface ResolvePaymentArgs {
    req: import("node:http").IncomingMessage & {
      path?: string;
      originalUrl?: string;
      method?: string;
    };
    res: import("node:http").ServerResponse;
    txHash: string | null;
  }

  export interface CreateReceiptMiddlewareOptions {
    privateKey?: string;
    privateKeyPem?: string;
    issuer: ReceiptIssuerInfo;
    serviceName?: string;
    baseUrl?: string;
    paymentDefaults?: Record<string, unknown>;
    resolvePayment?: (ctx: ResolvePaymentArgs) => Record<string, unknown>;
    onReceipt?: (receipt: Record<string, unknown>) => void | Promise<void>;
  }

  export interface VerifyReceiptResult {
    valid: boolean;
    trustState: string;
    checks: Record<string, string>;
    receiptHash: string | null;
    summary: string;
  }

  export interface GeneratedReceiptKeyPair {
    keyId: string;
    algorithm: "ed25519";
    publicKey: string;
    privateKeyPem: string;
  }

  export function createReceiptMiddleware(
    options: CreateReceiptMiddlewareOptions,
  ): (
    req: import("node:http").IncomingMessage,
    res: import("node:http").ServerResponse,
    next?: (err?: unknown) => void,
  ) => void;

  export function publicKeyFromPrivateKey(privateKey: string): string;

  export function generateReceiptKeyPair(options?: { keyId?: string }): GeneratedReceiptKeyPair;

  export function decodeReceiptHeader(headerValue: string): Record<string, any>;

  export function verifyReceipt(
    receipt: unknown,
    options?: { output?: unknown; trustedPaxiomPublicKeys?: string[] },
  ): VerifyReceiptResult;
}
