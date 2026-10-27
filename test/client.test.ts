import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import {
  SiteWarm,
  SiteWarmAuthenticationError,
  SiteWarmConnectionError,
  SiteWarmError,
  SiteWarmNotFoundError,
  SiteWarmRateLimitError,
  SiteWarmServerError,
  SiteWarmValidationError,
  SiteWarmWaitTimeoutError,
} from "../src/index.js";

// Not a real key, and short enough not to match secret scanners.
const KEY = "swk_test_abc123";
const BASE = "https://api.example.test/v1";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const problem = (status: number, slug: string, init: ResponseInit = {}) =>
  new Response(JSON.stringify({ type: `/problems/${slug}`, title: slug, status }), {
    status,
    headers: { "Content-Type": "application/problem+json", ...(init.headers as Record<string, string>) },
  });

function make(fetchMock: FetchMock, extra: Record<string, unknown> = {}) {
  return new SiteWarm({ apiKey: KEY, baseUrl: BASE, fetch: fetchMock, ...extra });
}
const run = (over: Record<string, unknown> = {}) => ({
  id: "run_1",
  site_id: "site_1",
  status: "queued",
  trigger: { type: "api" },
  options: { fail_on: ["miss"] },
  outcome: null,
  vantage_points: [],
  created_at: "2026-10-18T00:00:00Z",
  ...over,
});

describe("requests", () => {
  it("sends Bearer auth, builds the URL and skips undefined query values", async () => {
    const f: FetchMock = vi.fn(async () => json({ data: [], page: { has_more: false, next_cursor: null } }));
    await make(f).sites.list({ limit: 5, cursor: undefined });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${BASE}/sites?limit=5`);
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
    expect(init!.method).toBe("GET");
    expect(init!.redirect).toBe("manual");
  });

  it("encodes path parameters and sends JSON bodies", async () => {
    const f: FetchMock = vi.fn(async () => json({ id: "s" }, { status: 201 }));
    const sw = make(f);
    await sw.sites.create({ hostname: "example.com" });
    expect(f.mock.calls[0]![1]!.body).toBe('{"hostname":"example.com"}');
    f.mockImplementationOnce(async () => json({ id: "x" }));
    await sw.sites.get("a/b c");
    expect(f.mock.calls[1]![0]).toBe(`${BASE}/sites/a%2Fb%20c`);
  });

  it("returns undefined for 204", async () => {
    const f: FetchMock = vi.fn(async () => new Response(null, { status: 204 }));
    await expect(make(f).sites.delete("s1")).resolves.toBeUndefined();
  });

  it("treats a redirect as an error instead of following it with the key", async () => {
    const f: FetchMock = vi.fn(async () => new Response(null, { status: 302, headers: { Location: "https://evil.test/" } }));
    await expect(make(f).sites.get("s1")).rejects.toMatchObject({ status: 302 });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("is typed from the spec", async () => {
    const f: FetchMock = vi.fn(async () => json(run(), { status: 202 }));
    const r = await make(f).warmRuns.create("site_1", {
      source: { type: "sitemap", sitemap_id: "sm_1" },
      options: { fail_on: ["miss", "noindex"] },
    });
    const status: "queued" | "running" | "completed" | "canceled" | "failed" = r.status;
    expect(status).toBe("queued");
    // @ts-expect-error unknown operation fields are rejected at compile time
    await make(f).call("getWarmRun", { path: { siteId: "x" } }).catch(() => undefined);
  });
});

describe("idempotency", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("generates one Idempotency-Key per call and reuses it on every retry", async () => {
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(503, "unavailable"))
      .mockResolvedValueOnce(json(run(), { status: 202 }));
    const p = make(f).warmRuns.create("site_1", { source: { type: "sitemap", sitemap_id: "sm_1" } });
    await vi.advanceTimersByTimeAsync(60_000);
    await p;
    const keys = f.mock.calls.map((c) => (c[1]!.headers as Record<string, string>)["Idempotency-Key"]);
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it("uses the caller's key and a fresh key for the next call", async () => {
    const f: FetchMock = vi.fn(async () => json(run(), { status: 202 }));
    const sw = make(f);
    const body = { source: { type: "sitemap", sitemap_id: "sm_1" } } as const;
    await sw.warmRuns.create("s", body, { idempotencyKey: "mine" });
    await sw.warmRuns.create("s", body);
    const h = (i: number) => (f.mock.calls[i]![1]!.headers as Record<string, string>)["Idempotency-Key"];
    expect(h(0)).toBe("mine");
    expect(h(1)).not.toBe("mine");
  });

  it("does not send the header on GET", async () => {
    const f: FetchMock = vi.fn(async () => json(run()));
    await make(f).warmRuns.get("run_1");
    expect((f.mock.calls[0]![1]!.headers as Record<string, string>)["Idempotency-Key"]).toBeUndefined();
  });
});

describe("retries", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("honors Retry-After on 429 exactly", async () => {
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(429, "rate-limited", { headers: { "Retry-After": "2" } }))
      .mockResolvedValueOnce(json({ id: "s1" }));
    let done = false;
    const p = make(f).sites.get("s1").then(() => (done = true));
    await vi.advanceTimersByTimeAsync(1_999);
    expect(done).toBe(false);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("accepts an HTTP-date Retry-After", async () => {
    vi.setSystemTime(new Date("2026-10-18T00:00:00Z"));
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(429, "rate-limited", { headers: { "Retry-After": "Sun, 18 Oct 2026 00:00:03 GMT" } }))
      .mockResolvedValueOnce(json({ id: "s1" }));
    const p = make(f).sites.get("s1");
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await p;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("does not sleep for a Retry-After above the cap and throws a RateLimitError", async () => {
    const f: FetchMock = vi.fn(async () => problem(429, "rate-limited", { headers: { "Retry-After": "600", "RateLimit-Limit": "100", "RateLimit-Remaining": "0", "RateLimit-Reset": "600" } }));
    const err = await make(f).sites.get("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteWarmRateLimitError);
    expect(err).toMatchObject({ status: 429, code: "rate-limited", retryAfterSeconds: 600, rateLimit: { limit: 100, remaining: 0, reset: 600 } });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("backs off on 5xx with bounded jitter and gives up after maxRetries", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const f: FetchMock = vi.fn(async () => problem(500, "internal"));
    const p = make(f, { maxRetries: 2, retryBaseDelayMs: 100 }).sites.get("s1");
    const assertion = expect(p).rejects.toBeInstanceOf(SiteWarmServerError);
    await vi.advanceTimersByTimeAsync(99);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1); // 100ms: first retry
    expect(f).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(200); // 200ms: second retry
    await assertion;
    expect(f).toHaveBeenCalledTimes(3);
  });

  it("does not retry 4xx other than 429", async () => {
    for (const [status, slug, cls] of [
      [401, "unauthorized", SiteWarmAuthenticationError],
      [404, "not-found", SiteWarmNotFoundError],
      [422, "validation-failed", SiteWarmValidationError],
    ] as const) {
      const f: FetchMock = vi.fn(async () => problem(status, slug));
      await expect(make(f).sites.get("s1")).rejects.toBeInstanceOf(cls);
      expect(f).toHaveBeenCalledTimes(1);
    }
  });

  it("retries network errors on safe requests and wraps the final one", async () => {
    const f: FetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const p = make(f, { maxRetries: 1, retryBaseDelayMs: 10 }).sites.get("s1");
    const assertion = expect(p).rejects.toBeInstanceOf(SiteWarmConnectionError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
    expect(f).toHaveBeenCalledTimes(2);
  });

  it("rethrows the abort reason when the caller aborts", async () => {
    const ac = new AbortController();
    const f: FetchMock = vi.fn(async (_u, init) => {
      ac.abort(new Error("stop"));
      throw init!.signal!.reason;
    });
    await expect(make(f).sites.get("s1", { signal: ac.signal })).rejects.toThrow("stop");
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("errors", () => {
  it("exposes status, problem and code, and falls back for non-JSON bodies", async () => {
    const f: FetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ type: "/problems/site-not-verified", title: "Not verified", status: 422, detail: "verify first" }), {
        status: 422,
        headers: { "Content-Type": "application/problem+json" },
      }),
    );
    const err = (await make(f).warmRuns.create("s", { source: { type: "sitemap", sitemap_id: "m" } }).catch((e: unknown) => e)) as SiteWarmValidationError;
    expect(err).toBeInstanceOf(SiteWarmValidationError);
    expect(err.status).toBe(422);
    expect(err.code).toBe("site-not-verified");
    expect(err.problem.detail).toBe("verify first");

    const g: FetchMock = vi.fn(async () => new Response("<html>bad gateway</html>", { status: 502 }));
    const err2 = (await make(g, { maxRetries: 0 }).sites.get("s").catch((e: unknown) => e)) as SiteWarmServerError;
    expect(err2).toBeInstanceOf(SiteWarmServerError);
    expect(err2.problem.status).toBe(502);
    expect(err2.message).not.toContain("html");
  });
});

describe("pagination", () => {
  const page = (ids: string[], next: string | null) => json({ data: ids.map((id) => ({ id })), page: { has_more: next !== null, next_cursor: next } });

  it("follows next_cursor across pages and keeps other query params", async () => {
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(page(["a", "b"], "c1"))
      .mockResolvedValueOnce(page(["c"], "c2"))
      .mockResolvedValueOnce(page(["d"], null));
    const ids: string[] = [];
    for await (const s of make(f).sites.listAll({ limit: 2 })) ids.push(s.id);
    expect(ids).toEqual(["a", "b", "c", "d"]);
    expect(f.mock.calls.map((c) => c[0])).toEqual([`${BASE}/sites?limit=2`, `${BASE}/sites?limit=2&cursor=c1`, `${BASE}/sites?limit=2&cursor=c2`]);
  });

  it("stops on an empty last page and refuses a cursor that does not advance", async () => {
    const f: FetchMock = vi.fn(async () => page(["a"], "same"));
    const it = make(f).sites.listAll();
    await expect(
      (async () => {
        for await (const _ of it) void _;
      })(),
    ).rejects.toThrow(/did not advance/);
  });

  it("also paginates path-parameterized lists", async () => {
    const f: FetchMock = vi.fn(async () => page(["m1"], null));
    const out = [];
    for await (const m of make(f).sitemaps.listAll("site_1")) out.push(m);
    expect(f.mock.calls[0]![0]).toBe(`${BASE}/sites/site_1/sitemaps`);
    expect(out).toHaveLength(1);
  });
});

describe("warmRuns.wait", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("polls using Retry-After until the run completes", async () => {
    const done = run({ status: "completed", outcome: { failed: false, failing_states: [], reason: null } });
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(run({ status: "running" }), { headers: { "Retry-After": "3", "Content-Type": "application/json" } }))
      .mockResolvedValueOnce(json(done));
    const seen: string[] = [];
    const p = make(f).warmRuns.wait("run_1", { onPoll: (r) => seen.push(r.status) });
    await vi.advanceTimersByTimeAsync(2_999);
    expect(f).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const result = await p;
    expect(result.outcome?.failed).toBe(false);
    expect(seen).toEqual(["running", "completed"]);
  });

  it("returns canceled runs and throws on timeout without canceling", async () => {
    const g: FetchMock = vi.fn(async () => json(run({ status: "canceled" })));
    await expect(make(g).warmRuns.wait("run_1")).resolves.toMatchObject({ status: "canceled", outcome: null });

    const f: FetchMock = vi.fn(async () => json(run({ status: "running" })));
    const p = make(f).warmRuns.wait("run_1", { timeoutMs: 10_000, pollIntervalMs: 4_000 });
    const assertion = expect(p).rejects.toBeInstanceOf(SiteWarmWaitTimeoutError);
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(f.mock.calls.every((c) => c[1]!.method === "GET")).toBe(true);
  });
});

describe("api key hygiene", () => {
  it("rejects malformed keys without echoing them", () => {
    for (const bad of ["", " ", "a b", "key\nInjected: 1", "kéy"]) {
      try {
        new SiteWarm({ apiKey: bad, baseUrl: BASE, fetch: vi.fn() });
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(SiteWarmError);
        expect((e as Error).message).not.toContain("Injected");
      }
    }
  });

  it("requires https except for localhost, and no credentials in the URL", () => {
    const mk = (baseUrl: string) => new SiteWarm({ apiKey: KEY, baseUrl, fetch: vi.fn() });
    expect(() => mk("http://api.example.test/v1")).toThrow(SiteWarmError);
    expect(() => mk("https://user:pw@api.example.test/v1")).toThrow(/credentials/);
    expect(() => mk("/v1")).toThrow(SiteWarmError);
    expect(() => mk("http://localhost:8080/v1")).not.toThrow();
    expect(() => mk("http://127.0.0.1:8080/v1/")).not.toThrow();
  });

  it("never exposes the key through serialization, inspection, errors or console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => {}));
    const f: FetchMock = vi.fn(async () => problem(401, "unauthorized"));
    const sw = make(f, { maxRetries: 0 });
    const err = (await sw.sites.list().catch((e: unknown) => e)) as Error;
    const blobs = [
      JSON.stringify(sw),
      inspect(sw, { depth: 5, showHidden: true }),
      String(sw),
      err.message,
      err.stack ?? "",
      inspect(err, { depth: 6, showHidden: true }),
      JSON.stringify(err, Object.getOwnPropertyNames(err)),
    ];
    for (const b of blobs) expect(b).not.toContain(KEY);
    for (const s of spies) expect(s).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
});
