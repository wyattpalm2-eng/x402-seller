// Type shim for the vendored SSRF-guarded fetch helper (CJS).
declare const web: {
  web(url: string, method?: string, body?: string): Promise<{ status: number; contentType: string; body: string }>;
  assertSafeUrl(raw: string): Promise<URL>;
  isPrivateIp(ip: string): boolean;
};
export = web;
