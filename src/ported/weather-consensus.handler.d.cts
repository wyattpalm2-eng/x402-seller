// Type shim for the vendored crew handler (CJS). The handler is pure logic:
// (params) => result object (charge), null (uncharged 404), or throws (uncharged 502).
declare function handler(params: Record<string, string>): Promise<any>;
export = handler;
