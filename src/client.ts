import { operationTable } from "./generated/operations.js";
import {
  SiteWarmConnectionError,
  SiteWarmError,
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
    this.#maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.#retryBaseDelayMs = options.retryBaseDelayMs ?? 500;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? 30_000;
    this.#timeoutMs = options.timeoutMs ?? 30_000;
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
    const url = this.#baseUrl + expandPath(op.path, a.path) + queryString(a.query);

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

    // 429 means the request was not processed. 5xx and network errors may have been, so they are only
    // retried when repeating the request is safe: not a POST, or a POST carrying an Idempotency-Key.
    const safeToRetryAmbiguous = op.method !== "POST" || sendsKey;

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

      if (response.ok) return { data: await parseBody(response), status: response.status, headers: response.headers };

      const retryAfter = parseRetryAfter(response.headers.get("Retry-After"));
      const retryable = response.status === 429 || (response.status >= 500 && response.status !== 501 && safeToRetryAmbiguous);
      if (retryable && !last) {
        // A server-provided wait longer than we are willing to sleep is surfaced instead of ignored.
        const waitMs = retryAfter !== undefined ? retryAfter * 1000 : backoffDelayMs(attempt, this.#retryBaseDelayMs, this.#maxRetryDelayMs);
        if (waitMs <= this.#maxRetryDelayMs) {
          await discard(response);
          await sleep(waitMs, a.signal);
          continue;
        }
      }
      throw apiErrorFor({
        status: response.status,
        problem: await parseProblem(response),
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
    const maxPages = options.maxPages ?? 10_000;
    let cursor = (args as { query?: { cursor?: string } }).query?.cursor;
    for (let n = 0; n < maxPages; n++) {
      const query = { ...(args as { query?: object }).query, ...(cursor ? { cursor } : {}) };
      const page = (await this.call(operationId, { ...args, query } as CallArgs<K>)) as {
        page: { has_more: boolean; next_cursor: string | null };
      };
      yield page as ResponseData<K>;
      const next = page.page.next_cursor;
      if (!page.page.has_more || !next) return;
      if (next === cursor) throw new SiteWarmError("pagination cursor did not advance");
      cursor = next;
    }
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

async function parseBody<T>(response: Response): Promise<T> {
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  if (text === "") return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new SiteWarmError(`invalid JSON in ${response.status} response`);
  }
}

async function parseProblem(response: Response): Promise<Problem> {
  const fallback: Problem = { type: "about:blank", title: response.statusText || `HTTP ${response.status}`, status: response.status };
  try {
    const text = await response.text();
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
