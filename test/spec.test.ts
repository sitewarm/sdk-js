import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { operationTable } from "../src/generated/operations.js";

// Guards against a stale src/generated/operations.ts after the vendored spec changes.
describe("vendored OpenAPI spec", () => {
  const spec = parse(readFileSync(new URL("../openapi/openapi.yaml", import.meta.url), "utf8")) as {
    openapi: string;
    paths: Record<string, Record<string, { operationId?: string }>>;
  };

  it("is OpenAPI 3.1", () => {
    expect(spec.openapi).toMatch(/^3\.1\./);
  });

  it("matches the generated operation table exactly", () => {
    const fromSpec: Record<string, string> = {};
    for (const [path, item] of Object.entries(spec.paths)) {
      for (const method of ["get", "put", "post", "patch", "delete"]) {
        const id = item[method]?.operationId;
        if (id) fromSpec[id] = `${method.toUpperCase()} ${path}`;
      }
    }
    const fromTable = Object.fromEntries(Object.entries(operationTable).map(([id, o]) => [id, `${o.method} ${o.path}`]));
    expect(fromTable).toEqual(fromSpec);
  });

  it("marks createWarmRun as requiring an Idempotency-Key", () => {
    expect(operationTable.createWarmRun.idempotency).toBe("required");
  });
});
