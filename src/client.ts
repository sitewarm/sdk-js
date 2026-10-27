import { operationTable } from "./generated/operations.js";
import {
  SiteWarmConnectionError,
  SiteWarmError,
  SiteWarmResponseTooLargeError,
  SiteWarmTimeoutError,
  apiErrorFor,
  type Problem,
  type RateLimitInfo,
} from "./errors.js";
import { backoffDelayMs, parseRetryAfter, sleep } from "./retry.js";
import { createResources, type Resources } from "./resources.js";
import type {
  ApiResponse,
  CallArgs,
  ItemOf,
  ListOperationId,
  OperationId,
  ResponseData,
} from "./types.js";

export interface SiteWarmOptions {
  /** Scoped sitewarm API key, sent as `Authorization: Bearer <key>`. Never logged or serialized. */
  apiKey: string;
  /**
   * Base URL of the API including the version prefix, for example `https://<host>/v1`.
   * No default: the public host is not decided yet. Must be https (http only for localhost).
   */
  baseUrl: string;
  /** Custom fetch (tests, proxies, edge runtimes). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Retries after the first attempt, for 429, 5xx and network errors. Default 3. */
  maxRetries?: number;
  /** Base of the exponential backoff, in ms. Default 500. */
  retryBaseDelayMs?: number;
  /** Upper bound for one backoff and for an honored `Retry-After`, in ms. Default 30000. */
  maxRetryDelayMs?: number;
  /** Per-attempt timeout in ms. Default 30000. */
  timeoutMs?: number;
  /** Sent as `User-Agent` when set (ignored by browsers). */
  userAgent?: string;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_TIMEOUT_MS = 30_000;
/** Largest response body that is read (32 MiB). */
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_PAGES = 10_000;
const REPEATABLE = new Set(["GET", "HEAD", "PUT", "OPTIONS"]);

/**
 * Typed client for the sitewarm public API.
 *
 * ```ts
 * const sw = new SiteWarm({ apiKey, baseUrl });
 * const run = await sw.warmRuns.create(siteId, { source: { type: "sitemap", sitemap_id } });
 * const done = await sw.warmRuns.wait(run.id);
 * ```
 */
export class SiteWarm {
  readonly sites: Resources["sites"];
  readonly sitemaps: Resources["sitemaps"];
  readonly warmRuns: Resources["warmRuns"];
  readonly cacheStatusReports: Resources["cacheStatusReports"];

  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;
  readonly #maxRetries: number;
  readonly #retryBaseDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #timeoutMs: number;
  readonly #userAgent: string | undefined;

  constructor(options: SiteWarmOptions) {
    // Messages below never echo the key.
    if (typeof options.apiKey !== "string" || !/^[\x21-\x7e]+$/.test(options.apiKey)) {
      throw new SiteWarmError("apiKey must be a non-empty string without whitespace or control characters");
    }
    this.#apiKey = options.apiKey;
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const f = options.fetch ?? globalThis.fetch;
    if (typeof f !== "function") throw new SiteWarmError("no fetch implementation available; pass options.fetch");
    this.#fetch = f;
    // A negative maxRetries or a timeoutMs <= 0 keeps the default.
    this.#maxRetries =
      typeof options.maxRetries === "number" && options.maxRetries >= 0 ? Math.floor(options.maxRetries) : DEFAULT_MAX_RETRIES;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#timeoutMs =
      typeof options.timeoutMs === "number" && options.timeoutMs > 0 ? options.timeoutMs : DEFAULT_TIMEOUT_MS;
    this.#userAgent = options.userAgent;
    const resources = createResources(this);
    this.sites = resources.sites;
    this.sitemaps = resources.sitemaps;
    this.warmRuns = resources.warmRuns;
    this.cacheStatusReports = resources.cacheStatusReports;
  }

  /** Calls one operation by its `operationId` and returns the decoded body. */
  async call<K extends OperationId>(operationId: K, args: CallArgs<K> = {} as CallArgs<K>): Promise<ResponseData<K>> {
    return (await this.callRaw(operationId, args)).data;
  }

  /** Like {@link call} but also returns status and response headers. */
  async callRaw<K extends OperationId>(
    operationId: K,
    args: CallArgs<K> = {} as CallArgs<K>,
  ): Promise<ApiResponse<ResponseData<K>>> {
    const op = operationTable[operationId];
    const a = args as {
      path?: Record<string, string | number>;
      query?: Record<string, unknown>;
      body?: unknown;
      idempotencyKey?: string;
      signal?: AbortSignal;
    };
    const url = this.#baseUrl + expandPath(op.path, a.path) + queryString(checkedQuery(a.query));

    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.#apiKey}`,
      Accept: "application/json, application/problem+json",
    };
    if (this.#userAgent) headers["User-Agent"] = this.#userAgent;
    let body: string | undefined;
    if (a.body !== undefined) {
      body = JSON.stringify(a.body);
      headers["Content-Type"] = "application/json";
    }
    // One key per call, reused by every retry, so a retried POST never starts a second run.
    const sendsKey = op.idempotency !== "none" && op.method === "POST";
    if (sendsKey) headers["Idempotency-Key"] = a.idempotencyKey ?? crypto.randomUUID();

    // 429 means the request was not processed. 5xx, network errors and broken bodies may have been, so they are
    // only retried when repeating is safe: GET, HEAD, PUT, OPTIONS, or a POST carrying an Idempotency-Key.
    // DELETE and PATCH are retried on 429 only.
    const safeToRetryAmbiguous = REPEATABLE.has(op.method) || sendsKey;

    for (let attempt = 0; ; attempt++) {
      const last = attempt >= this.#maxRetries;
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method: op.method,
          headers,
          body,
          redirect: "manual",
          signal: combineSignals(a.signal, this.#timeoutMs),
        });
      } catch (err) {
        if (a.signal?.aborted) throw a.signal.reason ?? err;
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        if (!last && safeToRetryAmbiguous) {
          await sleep(backoffDelayMs(attempt, this.#retryBaseDelayMs, this.#maxRetryDelayMs), a.signal);
          continue;
        }
        throw timedOut
          ? new SiteWarmTimeoutError(`request timed out after ${this.#timeoutMs} ms`, { cause: err })
          : new SiteWarmConnectionError(`request failed: ${err instanceof Error ? err.message : "network error"}`, { cause: err });
      }

      if (response.redirected || response.type === "opaqueredirect") {
        // The supplied fetch ignored redirect: "manual". Authorization may already have left; do not continue.
        await discard(response);
        throw new SiteWarmError("the fetch implementation followed a redirect; it must honor redirect: 'manual'");
      }

      let text: string;
      try {
        text = await readBody(response);
      } catch (err) {
        if (err instanceof SiteWarmResponseTooLargeError) throw err;
        if (a.signal?.aborted) throw a.signal.reason ?? err;
        // A body that breaks off is as ambiguous as a network error, except after a 429.
        if (!last && (safeToRetryAmbiguous || response.status === 429)) {
          await sleep(backoffDelayMs(attempt, this.#retryBaseDelayMs, this.#maxRetryDelayMs), a.signal);
          continue;
        }
        const timedOut = err instanceof Error && err.name === "TimeoutError";
        throw timedOut
          ? new SiteWarmTimeoutError(`request timed out after ${this.#timeoutMs} ms`, { cause: err })
          : new SiteWarmConnectionError(`response body failed: ${err instanceof Error ? err.message : "network error"}`, { cause: err });
      }

      if (response.ok) return { data: parseBody(text, response.status), status: response.status, headers: response.headers };

      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const retryable = response.status === 429 || (response.status >= 500 && response.status !== 501 && safeToRetryAmbiguous);
      if (retryable && !last) {
        // A server-provided wait longer than we are willing to sleep is surfaced instead of ignored.
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : backoffDelayMs(attempt, this.#retryBaseDelayMs, this.#maxRetryDelayMs);
        if (waitMs <= this.#maxRetryDelayMs) {
          await sleep(waitMs, a.signal);
          continue;
        }
      }
      throw apiErrorFor({
        status: response.status,
        problem: parseProblem(text, response),
        retryAfterSeconds: retryAfter,
        rateLimit: readRateLimit(response.headers),
      });
    }
  }

  /** Iterates the pages (`{ data, page }`) of a list operation, following `page.next_cursor`. */
  async *pages<K extends ListOperationId>(
    operationId: K,
    args: CallArgs<K> = {} as CallArgs<K>,
    options: { maxPages?: number } = {},
  ): AsyncGenerator<ResponseData<K>, void, undefined> {
    const maxPages = options.maxPages ?? MAX_PAGES;
    let cursor = (args as { query?: { cursor?: string } }).query?.cursor;
    const seen = new Set<string>(cursor ? [cursor] : []);
    for (let n = 0; n < maxPages; n++) {
      const query = { ...(args as { query?: object }).query, ...(cursor ? { cursor } : {}) };
      const page = (await this.call(operationId, { ...args, query } as CallArgs<K>)) as {
        page: { has_more: boolean; next_cursor: string | null };
      };
      yield page as ResponseData<K>;
      const next = page.page.next_cursor;
      if (!page.page.has_more || !next) return;
      if (seen.has(next)) throw new SiteWarmError("pagination cursor did not advance");
      seen.add(next);
      cursor = next;
    }
    throw new SiteWarmError(`pagination stopped after ${maxPages} pages without reaching the end`);
  }

  /** Iterates every item of a list operation across pages. */
  async *paginate<K extends ListOperationId>(
    operationId: K,
    args: CallArgs<K> = {} as CallArgs<K>,
    options: { maxPages?: number } = {},
  ): AsyncGenerator<ItemOf<K>, void, undefined> {
    for await (const page of this.pages(operationId, args, options)) {
      yield* (page as { data: ItemOf<K>[] }).data;
    }
  }

  toJSON(): object {
    return { baseUrl: this.#baseUrl };
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return `SiteWarm { baseUrl: '${this.#baseUrl}' }`;
  }
}

function normalizeBaseUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new SiteWarmError("baseUrl must be an absolute URL such as https://<host>/v1");
  }
  const loopback = LOOPBACK.has(u.hostname);
  if (u.protocol !== "https:" && !(u.protocol === "http:" && loopback)) {
    throw new SiteWarmError("baseUrl must use https (http is only allowed for localhost)");
  }
  if (u.username || u.password) throw new SiteWarmError("baseUrl must not contain credentials");
  if (u.search || u.hash) throw new SiteWarmError("baseUrl must not contain a query or fragment");
  return u.origin + u.pathname.replace(/\/+$/, "");
}

function expandPath(template: string, values: Record<string, string | number> | undefined): string {
  return template.replace(/\{(\w+)\}/g, (_m, name: string) => {
    const v = values?.[name];
    if (v === undefined || v === "") throw new SiteWarmError(`missing path parameter "${name}"`);
    return encodeURIComponent(String(v));
  });
}

function queryString(query: Record<string, unknown> | undefined): string {
  if (!query) return "";
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null) p.append(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

function combineSignals(user: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return user ? AbortSignal.any([user, timeout]) : timeout;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    /* ignore */
  }
}

/** Reads at most MAX_BODY_BYTES + 1 bytes; a larger body throws SiteWarmResponseTooLargeError (not retried). */
async function readBody(response: Response): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new SiteWarmResponseTooLargeError(MAX_BODY_BYTES);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** `limit` must be an integer in 1..100 (0 or undefined = server default, not sent). */
function checkedQuery(query: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  if (!query || !("limit" in query)) return query;
  const { limit, ...rest } = query;
  if (limit === undefined || limit === null || limit === 0) return rest;
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new SiteWarmError("limit must be an integer between 1 and 100");
  }
  return query;
}

function parseBody<T>(text: string, status: number): T {
  if (status === 204 || text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SiteWarmError(`invalid JSON in ${status} response`);
  }
}

function parseProblem(text: string, response: Response): Problem {
  const fallback: Problem = { type: "about:blank", title: response.statusText || `HTTP ${response.status}`, status: response.status };
  try {
    const json: unknown = JSON.parse(text);
    if (json && typeof json === "object" && !Array.isArray(json)) {
      const p = json as Record<string, unknown>;
      return {
        ...p,
        type: typeof p.type === "string" ? p.type : fallback.type,
        title: typeof p.title === "string" ? p.title : fallback.title,
        status: typeof p.status === "number" ? p.status : response.status,
      } as Problem;
    }
  } catch {
    /* not JSON (proxy error page, empty body): keep the fallback */
  }
  return fallback;
}

function readRateLimit(h: Headers): RateLimitInfo {
  const num = (name: string) => {
    const v = h.get(name);
    return v !== null && /^\d+$/.test(v.trim()) ? Number(v) : undefined;
  };
  const info: RateLimitInfo = {};
  const limit = num("RateLimit-Limit");
  const remaining = num("RateLimit-Remaining");
  const reset = num("RateLimit-Reset");
  if (limit !== undefined) info.limit = limit;
  if (remaining !== undefined) info.remaining = remaining;
  if (reset !== undefined) info.reset = reset;
  return info;
}
