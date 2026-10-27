import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import {
  SiteWarm,
  SiteWarmApiError,
  SiteWarmConnectionError,
  SiteWarmDecodeError,
  SiteWarmError,
  SiteWarmRateLimitError,
  VERSION,
} from "../src/index.js";

const KEY = "swk_test_abc123";
const BASE = "https://api.example.test/v1";

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" }, ...init });
const problem = (status: number, slug: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: `https://x.test/problems/${slug}`, title: slug, status }), {
    status,
    headers: { "Content-Type": "application/problem+json", ...headers },
  });
const make = (f: FetchMock, extra: Record<string, unknown> = {}) =>
  new SiteWarm({ apiKey: KEY, baseUrl: BASE, fetch: f, retryBaseDelayMs: 0, ...extra });

afterEach(() => vi.restoreAllMocks());

describe("409 conflict", () => {
  it.each([
    ["conflict", 3],
    ["idempotency-key-reused", 1],
  ])("on a keyed POST (%s) makes %i call(s)", async (slug, calls) => {
    const f: FetchMock = vi.fn(async () => problem(409, slug));
    const err = await make(f, { maxRetries: 2 }).sites.create({ hostname: "example.com" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteWarmApiError);
    expect((err as SiteWarmApiError).code).toBe(slug);
    expect(f).toHaveBeenCalledTimes(calls);
  });

  it("is not retried on an operation without a key", async () => {
    const f: FetchMock = vi.fn(async () => problem(409, "conflict"));
    await expect(make(f, { maxRetries: 2 }).sites.delete("s1")).rejects.toBeInstanceOf(SiteWarmApiError);
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe("network error classes", () => {
  const withCause = (code: string) => Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error("x"), { code }) });
  it.each([
    ["self-signed certificate", () => withCause("DEPTH_ZERO_SELF_SIGNED_CERT"), 1],
    ["expired certificate", () => withCause("CERT_HAS_EXPIRED"), 1],
    ["hostname mismatch", () => withCause("ERR_TLS_CERT_ALTNAME_INVALID"), 1],
    ["unknown host", () => withCause("ENOTFOUND"), 1],
    ["invalid header", () => new TypeError("Headers.append: \"a\nb\" is an invalid header value."), 1],
    ["connection reset", () => withCause("ECONNRESET"), 3],
    ["temporary DNS failure", () => withCause("EAI_AGAIN"), 3],
    ["plain fetch failure", () => new TypeError("fetch failed"), 3],
  ])("%s", async (_name, make_err, calls) => {
    const f: FetchMock = vi.fn(async () => {
      throw make_err();
    });
    await expect(make(f, { maxRetries: 2 }).sites.get("s1")).rejects.toBeInstanceOf(SiteWarmConnectionError);
    expect(f).toHaveBeenCalledTimes(calls);
  });
});

describe("Retry-After floor and jitter", () => {
  const sleeps = () => {
    const out: number[] = [];
    vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
      out.push(ms ?? 0);
      fn();
      return 0 as unknown as NodeJS.Timeout;
    }) as typeof setTimeout);
    return out;
  };

  it("Retry-After 0 still waits the retry base, with at most +25% jitter", async () => {
    vi.spyOn(Math, "random").mockReturnValue(1);
    const out = sleeps();
    const f: FetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(problem(429, "rate-limited", { "Retry-After": "0" })).mockResolvedValueOnce(json({ id: "s1" }));
    await make(f, { retryBaseDelayMs: 200, maxRetryDelayMs: 5000 }).sites.get("s1");
    expect(out).toContain(250);
    expect(out.every((ms) => ms === 0 || (ms >= 200 && ms <= 250))).toBe(true);
  });

  it("a past HTTP date is floored too", async () => {
    vi.spyOn(Math, "random").mockReturnValue(0);
    const out = sleeps();
    const f: FetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(problem(429, "rate-limited", { "Retry-After": "Mon, 01 Jan 2001 00:00:00 GMT" }))
      .mockResolvedValueOnce(json({ id: "s1" }));
    await make(f, { retryBaseDelayMs: 200, maxRetryDelayMs: 5000 }).sites.get("s1");
    expect(out).toContain(200);
  });

  it("a Retry-After above the cap is surfaced, not slept", async () => {
    const out = sleeps();
    const f: FetchMock = vi.fn(async () => problem(429, "rate-limited", { "Retry-After": "60" }));
    await expect(make(f, { maxRetryDelayMs: 5000 }).sites.get("s1")).rejects.toBeInstanceOf(SiteWarmRateLimitError);
    expect(f).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });
});

describe("decode error", () => {
  it("a non-JSON 2xx body raises SiteWarmDecodeError with the status and without the body", async () => {
    const f: FetchMock = vi.fn(async () => new Response("<html>secret-proxy-page</html>", { status: 200 }));
    const err = await make(f).sites.get("s1").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SiteWarmDecodeError);
    expect(err).toBeInstanceOf(SiteWarmError);
    expect((err as SiteWarmDecodeError).status).toBe(200);
    expect(JSON.stringify(err) + String((err as Error).message) + String((err as Error).cause)).not.toContain("secret-proxy-page");
  });
});

describe("User-Agent and base path", () => {
  const ua = async (userAgent?: string) => {
    const f: FetchMock = vi.fn(async () => json({ id: "s1" }));
    await make(f, userAgent === undefined ? {} : { userAgent }).sites.get("s1");
    return (f.mock.calls[0]![1]!.headers as Record<string, string>)["User-Agent"];
  };

  it("carries version and URL, an empty custom value keeps the default", async () => {
    const def = `sitewarm-js/${VERSION} (+https://github.com/sitewarm/sdk-js)`;
    expect(await ua()).toBe(def);
    expect(await ua("")).toBe(def);
    expect(await ua("mine/1")).toBe("mine/1");
  });

  it("VERSION matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(VERSION).toBe(pkg.version);
  });

  it("keeps percent-encoding in the base path", async () => {
    const f: FetchMock = vi.fn(async () => json({ id: "s1" }));
    await new SiteWarm({ apiKey: KEY, baseUrl: "https://x.test/a%2Fb/v1", fetch: f }).sites.get("s1");
    expect(f.mock.calls[0]![0]).toBe("https://x.test/a%2Fb/v1/sites/s1");
  });
});
