import type { components } from "./generated/schema.js";

/** RFC 9457 problem details as returned by the API (`application/problem+json`). */
export type Problem = components["schemas"]["Problem"];
/** Documented problem type slugs. New values may appear; clients must tolerate them. */
export type ProblemType = components["schemas"]["ProblemType"];

export interface RateLimitInfo {
  limit?: number;
  remaining?: number;
  /** Seconds until the current window resets. */
  reset?: number;
}

/** Base class of every error thrown by this SDK. Never contains the API key. */
export class SiteWarmError extends Error {
  override name = "SiteWarmError";
}

/** The request never produced an HTTP response (DNS, TLS, reset, ...). */
export class SiteWarmConnectionError extends SiteWarmError {
  override name = "SiteWarmConnectionError";
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** The per-request timeout (`timeoutMs`) elapsed. */
export class SiteWarmTimeoutError extends SiteWarmConnectionError {
  override name = "SiteWarmTimeoutError";
}

/** The API answered with a non-2xx status. */
export class SiteWarmApiError extends SiteWarmError {
  override name = "SiteWarmApiError";
  readonly status: number;
  readonly problem: Problem;
  /** Problem type slug (for example `site-not-verified`), when the server sent one. */
  readonly code: ProblemType | (string & {}) | undefined;
  /** Parsed `Retry-After`, in seconds. */
  readonly retryAfterSeconds: number | undefined;
  readonly rateLimit: RateLimitInfo;

  constructor(init: {
    status: number;
    problem: Problem;
    retryAfterSeconds?: number;
    rateLimit?: RateLimitInfo;
  }) {
    const { problem, status } = init;
    super(`sitewarm API error ${status}${problem.title ? `: ${problem.title}` : ""}${problem.detail ? ` (${problem.detail})` : ""}`);
    this.status = status;
    this.problem = problem;
    this.code = problemCode(problem);
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.rateLimit = init.rateLimit ?? {};
  }
}

export class SiteWarmAuthenticationError extends SiteWarmApiError {
  override name = "SiteWarmAuthenticationError";
}
export class SiteWarmPermissionError extends SiteWarmApiError {
  override name = "SiteWarmPermissionError";
}
export class SiteWarmNotFoundError extends SiteWarmApiError {
  override name = "SiteWarmNotFoundError";
}
export class SiteWarmConflictError extends SiteWarmApiError {
  override name = "SiteWarmConflictError";
}
/** 400 and 422: inspect `problem.errors` for field-level details. */
export class SiteWarmValidationError extends SiteWarmApiError {
  override name = "SiteWarmValidationError";
}
export class SiteWarmRateLimitError extends SiteWarmApiError {
  override name = "SiteWarmRateLimitError";
}
export class SiteWarmServerError extends SiteWarmApiError {
  override name = "SiteWarmServerError";
}

/** `warmRuns.wait()` gave up before the run reached `completed`, `canceled` or `failed`. The run keeps going server side. */
export class SiteWarmWaitTimeoutError extends SiteWarmError {
  override name = "SiteWarmWaitTimeoutError";
  readonly runId: string;
  readonly lastStatus: string;
  constructor(runId: string, lastStatus: string, timeoutMs: number) {
    super(`warm run ${runId} did not finish within ${timeoutMs} ms (last status: ${lastStatus})`);
    this.runId = runId;
    this.lastStatus = lastStatus;
  }
}

function problemCode(problem: Problem): string | undefined {
  if (typeof problem.code === "string") return problem.code;
  if (typeof problem.type === "string") {
    const slug = problem.type.split("/").filter(Boolean).pop();
    if (slug && /^[a-z0-9-]+$/.test(slug)) return slug;
  }
  return undefined;
}

export function apiErrorFor(init: ConstructorParameters<typeof SiteWarmApiError>[0]): SiteWarmApiError {
  const { status } = init;
  if (status === 401) return new SiteWarmAuthenticationError(init);
  if (status === 403) return new SiteWarmPermissionError(init);
  if (status === 404) return new SiteWarmNotFoundError(init);
  if (status === 409) return new SiteWarmConflictError(init);
  if (status === 400 || status === 422) return new SiteWarmValidationError(init);
  if (status === 429) return new SiteWarmRateLimitError(init);
  if (status >= 500) return new SiteWarmServerError(init);
  return new SiteWarmApiError(init);
}
