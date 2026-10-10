import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

import {
  ENDPOINTS,
  PRICE_SUCCESS_SCHEMA,
  buildOpenApi,
  paidSuccessDocument,
} from "../src/discovery.ts";
import { cryptoPrice } from "../src/data.ts";

const REQUIRED = PRICE_SUCCESS_SCHEMA.required;

function guaranteedPaths(schema: { required?: string[]; properties?: Record<string, unknown> }) {
  return [...(schema.required ?? [])].sort();
}

describe("GET /price success contract", () => {
  const price = ENDPOINTS.find((endpoint) => endpoint.path === "/price");

  it("owns a typed required success schema on the endpoint spec", () => {
    assert.ok(price);
    assert.deepEqual(price.output_schema, PRICE_SUCCESS_SCHEMA);
    assert.deepEqual(guaranteedPaths(PRICE_SUCCESS_SCHEMA), ["as_of", "price_usd", "source", "symbol"]);
    for (const field of REQUIRED) {
      assert.equal(typeof PRICE_SUCCESS_SCHEMA.properties[field], "object");
    }
  });

  it("keeps the published example consistent with required fields and deliver()", () => {
    assert.ok(price);
    for (const field of REQUIRED) {
      assert.notEqual(price.output_example[field], undefined, `example missing ${field}`);
    }
    assert.equal(price.output_example.source, "x402-seller");
    assert.equal(typeof price.output_example.price_usd, "number");
    assert.match(String(price.output_example.as_of), /^\d{4}-\d{2}-\d{2}T/);
  });

  it("emits the schema from OpenAPI instead of a bare object", () => {
    const spec = buildOpenApi("https://x402-seller-m8nx.onrender.com");
    const body = spec.paths["/price"].get.responses["200"].content["application/json"];
    assert.deepEqual(body.schema.required, REQUIRED);
    assert.equal(body.schema.properties.symbol.type, "string");
    assert.equal(body.schema.properties.price_usd.type, "number");
    assert.equal(body.example.source, "x402-seller");
    assert.deepEqual(body, paidSuccessDocument(price!));
  });

  it("projects the same conservative contract into Bazaar", () => {
    assert.ok(price);
    const extension = declareDiscoveryExtension({ output: paidSuccessDocument(price) });
    const bazaar = extension.bazaar as any;
    assert.deepEqual(bazaar.info.output.example, price.output_example);
    assert.deepEqual(bazaar.schema.properties.output.properties.example.required, REQUIRED);
    assert.equal("base" in bazaar.schema.properties.output.properties.example.properties, false);
    assert.equal("currency" in bazaar.schema.properties.output.properties.example.properties, false);
  });

  it("does not invent a schema for endpoints that still lack one", () => {
    const spec = buildOpenApi("https://x402-seller-m8nx.onrender.com");
    const stock = spec.paths["/stock"].get.responses["200"].content["application/json"];
    assert.deepEqual(stock.schema, { type: "object" });
  });

  it("keeps malformed optional upstream metadata outside the typed contract", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response(JSON.stringify({
      data: { amount: "123.45", base: null, currency: { code: "USD" } },
    }), { status: 200, headers: { "content-type": "application/json" } });
    try {
      const handlerBody = await cryptoPrice("ZZQK");
      const paidBody = { ...handlerBody, source: "x402-seller" };
      assert.equal(paidBody.base, null);
      assert.deepEqual(paidBody.currency, { code: "USD" });
      assert.equal("base" in PRICE_SUCCESS_SCHEMA.properties, false);
      assert.equal("currency" in PRICE_SUCCESS_SCHEMA.properties, false);
      for (const field of REQUIRED) {
        assert.notEqual(paidBody[field], undefined);
        assert.notEqual(paidBody[field], null);
      }
      assert.equal(typeof paidBody.price_usd, "number");
      assert.equal(paidBody.source, "x402-seller");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
