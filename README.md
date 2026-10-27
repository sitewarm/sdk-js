# @sitewarm/sdk

TypeScript client for the sitewarm API. Types are generated from the OpenAPI 3.1 spec in [`openapi/openapi.yaml`](openapi/openapi.yaml); the runtime is a thin `fetch` client with **zero runtime dependencies**. Node 20+ (or any runtime with `fetch`).

**Status: pre-release (0.1.0, not published to npm).** The API and this client can still change. The spec describes the whole planned surface; the service may not offer every operation yet.

```ts
import { SiteWarm } from "@sitewarm/sdk";

const sw = new SiteWarm({ apiKey: process.env.SITEWARM_API_KEY!, baseUrl: "https://<api host>/v1" });

const site = await sw.sites.create({ hostname: "example.com" });
const sitemap = await sw.sitemaps.create(site.id, { url: "https://example.com/sitemap.xml" });
const started = await sw.warmRuns.create(site.id, { source: { type: "sitemap", sitemap_id: sitemap.id } });
const run = await sw.warmRuns.wait(started.id);
for await (const r of sw.warmRuns.listAllResults(run.id, { final_state: "miss" })) console.log(r.url, r.final_state);
```

A site must be verified before a run is accepted; verification happens outside this API.

## Surface

- Resource helpers: `sites`, `sitemaps`, `warmRuns` (`create`, `get`, `cancel`, `results`, `listAllResults`, `wait`), `cacheStatusReports`.
- Every operation of the spec is reachable and typed through `sw.call("<operationId>", { path, query, body })`, for example `sw.call("listSchedules", { path: { siteId } })`. `callRaw` also returns the status and headers. The operation table is generated, and a test fails if it drifts from the spec.
- Pagination: `sw.paginate(op, args)` yields items, `sw.pages(op, args)` yields pages; the `listAll*` helpers use them. Cursors are opaque and only ever passed back.
- Webhook callbacks (the `webhooks:` section of the spec) are server-to-customer and not covered.

## Behavior

- **Auth**: `Authorization: Bearer <key>`. The key lives in a private field; it is not in `JSON.stringify(client)`, `util.inspect`, `console.log`, error messages or logs (the SDK never logs). `apiKey` must be printable ASCII without whitespace. `baseUrl` must be https (http only for localhost) and have no credentials. Every request uses `redirect: "manual"`, so a 3xx is thrown as an API error and the key never goes to another origin. A custom `fetch` must honor `redirect: "manual"` (an SDK cannot undo a header a foreign fetch already sent); if it reports `response.redirected` the call is rejected.
- **No default `baseUrl`**: pass the API host you were given.
- **More retry rules**: a `409` `conflict` on a keyed POST is retried (the first attempt may still be running); `idempotency-key-reused` never. Certificate verification failures, unknown hosts and malformed requests (invalid header or URL) are not retried; other network errors are.
- **Retries**: up to `maxRetries` (3; a negative value keeps the default) on `429`, `5xx` (not `501`) and network errors, with exponential backoff and jitter capped at `maxRetryDelayMs` (30 s). `Retry-After` (seconds or HTTP-date) is honored with a floor of the retry base delay and up to +25% jitter; if it exceeds the cap the error is thrown instead of sleeping. `429` is always retried; `5xx`, network errors and a response body that breaks off only when repeating is safe (`GET`, `HEAD`, `PUT`, `OPTIONS`, or a POST with an `Idempotency-Key`; never `DELETE`/`PATCH`). `timeoutMs <= 0` keeps the default (30 s).
- **Idempotency**: every POST that accepts `Idempotency-Key` sends one (a random UUID unless you pass `idempotencyKey`), generated once per call and reused by all its retries, so a retried `warmRuns.create` never starts two runs.
- **Limits**: response bodies over 32 MiB throw `SiteWarmResponseTooLargeError` (not retried); `pages`/`paginate` throw on a repeated cursor or after 10,000 pages instead of stopping silently; a `limit` query value outside 1..100 throws before the request (0 or unset = server default).
- **Errors**: `SiteWarmApiError` (`status`, `problem` as RFC 9457, `code` as the problem type slug, `retryAfterSeconds`, `rateLimit`) with subclasses for 401, 403, 404, 409, 400/422, 429 and 5xx; `SiteWarmConnectionError` and `SiteWarmTimeoutError` for transport; `SiteWarmWaitTimeoutError` from `warmRuns.wait`; `SiteWarmDecodeError` (`status`) for a 2xx body that is not JSON (the body is never included). The `User-Agent` is `sitewarm-js/<version> (+https://github.com/sitewarm/sdk-js)`; an empty `userAgent` keeps it.
- **`warmRuns.wait`** polls `GET /warm-runs/{runId}` using its `Retry-After` and returns on `completed`, `canceled` or `failed`; `outcome` is only set on `completed`. On timeout it throws without canceling the run.

## Development

```
pnpm install --frozen-lockfile
pnpm run generate   # regenerate src/generated from openapi/openapi.yaml
pnpm run typecheck && pnpm test && pnpm run build
```

To update the spec, replace `openapi/openapi.yaml` and run `pnpm run generate`; CI fails if `src/generated` is out of date. `package.json` keeps `"private": true` until a release is decided, so `npm publish` cannot happen by accident.

## License

Apache-2.0, see [LICENSE](LICENSE).
