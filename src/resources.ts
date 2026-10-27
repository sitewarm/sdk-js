import { SiteWarmWaitTimeoutError } from "./errors.js";
import { sleep, parseRetryAfter } from "./retry.js";
import type { SiteWarm } from "./client.js";
import type { CacheStatusReport, CommonCallOptions, Result, WarmRun, WarmRunCreate, components, operations } from "./types.js";

type Q<K extends keyof operations> = NonNullable<operations[K]["parameters"]["query"]>;
type Opts = CommonCallOptions;

export interface WaitOptions {
  /** Give up after this many ms and throw {@link SiteWarmWaitTimeoutError}. Default 900000 (15 min). */
  timeoutMs?: number;
  /** Poll delay when the server sends no `Retry-After`. Default 5000. */
  pollIntervalMs?: number;
  /** Floor for the poll delay, also applied to `Retry-After: 0`. Default 1000. */
  minPollIntervalMs?: number;
  /** Ceiling for the poll delay. Default 60000. */
  maxPollIntervalMs?: number;
  /** Called after every poll with the latest run. */
  onPoll?: (run: WarmRun) => void;
  signal?: AbortSignal;
}

/** A run in one of these statuses will not change any more; `wait()` stops polling. */
const isTerminal = (status: WarmRun["status"]): boolean =>
  status === "completed" || status === "canceled" || status === "failed";

/** Hand-written conveniences over `SiteWarm.call()`. Every other operation is reachable through `call()`. */
export function createResources(c: SiteWarm) {
  return {
    sites: {
      list: (query?: Q<"listSites">, o?: Opts) => c.call("listSites", { query, ...o }),
      listAll: (query?: Q<"listSites">, o?: Opts) => c.paginate("listSites", { query, ...o }),
      get: (siteId: string, o?: Opts) => c.call("getSite", { path: { siteId }, ...o }),
      create: (body: components["schemas"]["SiteCreate"], o?: Opts) => c.call("createSite", { body, ...o }),
      update: (siteId: string, body: components["schemas"]["SiteUpdate"], o?: Opts) =>
        c.call("updateSite", { path: { siteId }, body, ...o }),
      delete: (siteId: string, o?: Opts) => c.call("deleteSite", { path: { siteId }, ...o }),
    },
    sitemaps: {
      list: (siteId: string, query?: Q<"listSitemaps">, o?: Opts) => c.call("listSitemaps", { path: { siteId }, query, ...o }),
      listAll: (siteId: string, query?: Q<"listSitemaps">, o?: Opts) => c.paginate("listSitemaps", { path: { siteId }, query, ...o }),
      get: (siteId: string, sitemapId: string, o?: Opts) => c.call("getSitemap", { path: { siteId, sitemapId }, ...o }),
      create: (siteId: string, body: components["schemas"]["SitemapCreate"], o?: Opts) =>
        c.call("createSitemap", { path: { siteId }, body, ...o }),
      delete: (siteId: string, sitemapId: string, o?: Opts) => c.call("deleteSitemap", { path: { siteId, sitemapId }, ...o }),
    },
    warmRuns: {
      /** Starts a run (`202`). Sends `Idempotency-Key` (generated if you do not pass `idempotencyKey`). */
      create: (siteId: string, body: WarmRunCreate, o?: Opts) => c.call("createWarmRun", { path: { siteId }, body, ...o }),
      get: (runId: string, o?: Opts) => c.call("getWarmRun", { path: { runId }, ...o }),
      cancel: (runId: string, o?: Opts) => c.call("cancelWarmRun", { path: { runId }, ...o }),
      listForSite: (siteId: string, query?: Q<"listWarmRuns">, o?: Opts) => c.call("listWarmRuns", { path: { siteId }, query, ...o }),
      listAllForSite: (siteId: string, query?: Q<"listWarmRuns">, o?: Opts) => c.paginate("listWarmRuns", { path: { siteId }, query, ...o }),
      results: (runId: string, query?: Q<"listWarmRunResults">, o?: Opts) =>
        c.call("listWarmRunResults", { path: { runId }, query, ...o }),
      listAllResults: (runId: string, query?: Q<"listWarmRunResults">, o?: Opts): AsyncGenerator<Result, void, undefined> =>
        c.paginate("listWarmRunResults", { path: { runId }, query, ...o }),
      /**
       * Polls the run until `status` is `completed`, `canceled` or `failed`, honoring the `Retry-After` of each
       * poll. `outcome` is only set on `completed` runs. Throws {@link SiteWarmWaitTimeoutError} on timeout
       * (the run is NOT canceled).
       */
      wait: async (runId: string, w: WaitOptions = {}): Promise<WarmRun> => {
        const timeoutMs = w.timeoutMs ?? 900_000;
        const dflt = w.pollIntervalMs ?? 5_000;
        const min = w.minPollIntervalMs ?? 1_000;
        const max = w.maxPollIntervalMs ?? 60_000;
        const deadline = Date.now() + timeoutMs;
        for (;;) {
          const { data: run, headers } = await c.callRaw("getWarmRun", { path: { runId }, signal: w.signal });
          w.onPoll?.(run);
          if (isTerminal(run.status)) return run;
          const remaining = deadline - Date.now();
          if (remaining <= 0) throw new SiteWarmWaitTimeoutError(runId, run.status, timeoutMs);
          const hinted = parseRetryAfter(headers.get("Retry-After"));
          const delay = Math.min(max, Math.max(min, hinted !== undefined ? hinted * 1000 : dflt));
          if (delay >= remaining) {
            await sleep(remaining, w.signal);
            const final = await c.call("getWarmRun", { path: { runId }, signal: w.signal });
            w.onPoll?.(final);
            if (isTerminal(final.status)) return final;
            throw new SiteWarmWaitTimeoutError(runId, final.status, timeoutMs);
          }
          await sleep(delay, w.signal);
        }
      },
    },
    cacheStatusReports: {
      listForSite: (siteId: string, query?: Q<"listCacheStatusReports">, o?: Opts) =>
        c.call("listCacheStatusReports", { path: { siteId }, query, ...o }),
      get: (reportId: string, o?: Opts): Promise<CacheStatusReport> => c.call("getCacheStatusReport", { path: { reportId }, ...o }),
    },
  };
}

export type Resources = ReturnType<typeof createResources>;
