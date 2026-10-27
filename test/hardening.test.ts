import { describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { SiteWarm, SiteWarmConnectionError, SiteWarmError, SiteWarmResponseTooLargeError, SiteWarmServerError } from "../src/index.js";
import { operationTable } from "../src/generated/operations.js";

const KEY = "swk_test_abc123";
const BASE = "https://api.example.test/v1";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const make = (f: FetchMock, extra: Record<string, unknown> = {}) =>
  new SiteWarm({ apiKey: KEY, baseUrl: BASE, fetch: f, retryBaseDelayMs: 0, ...extra });
const page = (data: unknown[], next: string | null) => json({ data, page: { has_more: next !== null, next_cursor: next } });

/** A 200 whose body breaks off after a few bytes. */
const brokenBody = () =>
  new Response(
    new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode('{"id"'));
        c.error(new TypeError("terminated"));
      },
    }),
    { status: 200 },
  );

function withOp(id: string, method: string, idempotency: string, fn: () => Promise<void>) {
  const table = operationTable as unknown as Record<string, unknown>;
  table[id] = { method, path: "/fake", idempotency };
  return fn().finally(() => {
    delete table[id];
  });
}

describe("options", () => {
  it("timeoutMs <= 0 keeps the default and a negative maxRetries keeps the default", async () => {
    const signals: AbortSignal[] = [];
    const f: FetchMock = vi.fn(async (_u, init) => {
      signals.push(init!.signal as AbortSignal);
      return json({ id: "s1" });
    });
    for (const timeoutMs of [0, -5, Number.NaN]) {
      await make(f, { timeoutMs }).sites.get("s1");
      await new Promise((r) => setTimeout(r, 5));
      expect(signals.at(-1)!.aborted).toBe(false);
    }
    const f2: FetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
    await expect(make(f2, { maxRetries: -1 }).sites.get("s1")).rejects.toBeInstanceOf(SiteWarmServerError);
    expect(f2).toHaveBeenCalledTimes(4); // default 3 retries
  });
});

describe("response body", () => {
  it("a body that breaks off is retried like a network error", async () => {
    let n = 0;
    const f: FetchMock = vi.fn(async () => (++n === 1 ? brokenBody() : json({ id: "s1" })));
    expect(await make(f).sites.get("s1")).toEqual({ id: "s1" });
    expect(n).toBe(2);
  });

  it("a broken body after a non-keyed POST is not retried", async () => {
    await withOp("fakePost", "POST", "none", async () => {
      const f: FetchMock = vi.fn(async () => brokenBody());
      const sw = make(f);
      await expect((sw as any).call("fakePost")).rejects.toBeInstanceOf(SiteWarmConnectionError);
      expect(f).toHaveBeenCalledTimes(1);
    });
  });

  it("a broken body after a 429 is retried for any method", async () => {
    await withOp("fakeDel", "DELETE", "none", async () => {
      let n = 0;
      const f: FetchMock = vi.fn(async () => {
        if (++n === 1) {
          return new Response(
            new ReadableStream({
              start(c) {
                c.error(new TypeError("terminated"));
              },
            }),
            { status: 429 },
          );
        }
        return json({});
      });
      await (make(f) as any).call("fakeDel");
      expect(n).toBe(2);
    });
  });

  it("a body over 32 MiB throws a typed error and is not retried", async () => {
    const chunk = new Uint8Array(1 << 20);
    const f: FetchMock = vi.fn(async () => {
      let i = 0;
      return new Response(
        new ReadableStream({
          pull(c) {
            if (i++ < 40) c.enqueue(chunk);
            else c.close();
          },
        }),
        { status: 200 },
      );
    });
    await expect(make(f).sites.get("s1")).rejects.toBeInstanceOf(SiteWarmResponseTooLargeError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("retry policy by method", () => {
  it.each([
    ["GET", 3],
    ["HEAD", 3],
    ["PUT", 3],
    ["OPTIONS", 3],
    ["DELETE", 1],
    ["PATCH", 1],
  ])("%s on 503 is called %i time(s)", async (method, want) => {
    await withOp("fakeOp", method, "none", async () => {
      const f: FetchMock = vi.fn(async () => new Response("{}", { status: 503 }));
      await expect((make(f, { maxRetries: 2 }) as any).call("fakeOp")).rejects.toBeInstanceOf(SiteWarmServerError);
      expect(f).toHaveBeenCalledTimes(want);
    });
  });

  it("429 is retried for DELETE", async () => {
    await withOp("fakeOp", "DELETE", "none", async () => {
      let n = 0;
      const f: FetchMock = vi.fn(async () => (++n < 3 ? new Response("{}", { status: 429, headers: { "Retry-After": "0" } }) : json({})));
      await (make(f) as any).call("fakeOp");
      expect(n).toBe(3);
    });
  });
});

describe("pagination", () => {
  it("errors on a cursor that repeats, even when it is not the previous one", async () => {
    const f: FetchMock = vi.fn(async (u) => page([1], String(u).includes("cursor=b") ? "a" : "b"));
    await expect(async () => {
      for await (const _ of make(f).sites.listAll()) void _;
    }).rejects.toThrow(/did not advance/);
  });

  it("errors, not silently stops, at the page cap", async () => {
    let n = 0;
    const f: FetchMock = vi.fn(async () => page([], `c${++n}`));
    await expect(async () => {
      for await (const _ of make(f).pages("listSites", {}, { maxPages: 5 })) void _;
    }).rejects.toThrow(/stopped after 5 pages/);
    expect(n).toBe(5);
  });

  it("validates limit to 1..100 before sending (0/unset = server default)", async () => {
    const f: FetchMock = vi.fn(async () => page([], null));
    const sw = make(f);
    for (const limit of [-1, 101, 1.5, "5" as unknown as number]) {
      await expect(sw.sites.list({ limit })).rejects.toBeInstanceOf(SiteWarmError);
    }
    expect(f).not.toHaveBeenCalled();
    for (const limit of [1, 100, 0, undefined]) await sw.sites.list({ limit });
    expect(f.mock.calls.map((c) => String(c[0]))).toEqual([`${BASE}/sites?limit=1`, `${BASE}/sites?limit=100`, `${BASE}/sites`, `${BASE}/sites`]);
  });
});

describe("key redaction and redirects", () => {
  it("key is in no default dump", () => {
    const sw = new SiteWarm({ apiKey: KEY, baseUrl: BASE, fetch: vi.fn() });
    const dumps = [
      JSON.stringify(sw),
      inspect(sw, { showHidden: true, depth: 5 }),
      inspect(sw.sites, { showHidden: true, depth: 5 }),
      String(sw),
      JSON.stringify(Object.getOwnPropertyNames(sw)),
      JSON.stringify(structuredCloneSafe(sw)),
    ];
    for (const d of dumps) expect(d).not.toContain(KEY);
  });

  it("requests redirect: manual and a 3xx is an error, not followed", async () => {
    const f: FetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://other.test/x" } }));
    await expect(make(f, { maxRetries: 0 }).sites.get("s1")).rejects.toMatchObject({ status: 302 });
    expect(f.mock.calls[0]![1]!.redirect).toBe("manual");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("a supplied fetch that followed a redirect anyway is rejected", async () => {
    const f: FetchMock = vi.fn(async () => {
      const r = json({ id: "s1" });
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    });
    await expect(make(f).sites.get("s1")).rejects.toThrow(/followed a redirect/);
  });
});

function structuredCloneSafe(v: object): unknown {
  try {
    return structuredClone(v);
  } catch {
    return null;
  }
}
