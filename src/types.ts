import type { components, operations } from "./generated/schema.js";
import type { operationTable } from "./generated/operations.js";

export type { components, operations };

/** Every operationId of the spec (webhook callbacks are server-to-customer and not included). */
export type OperationId = keyof typeof operationTable & keyof operations;

type Params<K extends OperationId> = operations[K]["parameters"];

type PathOf<K extends OperationId> = Params<K> extends { path: infer P } ? P : never;
type QueryOf<K extends OperationId> = NonNullable<Params<K>["query"]>;
type RequestBodyOf<K extends OperationId> = NonNullable<operations[K]["requestBody"]>;

type PathArg<K extends OperationId> = [PathOf<K>] extends [never] ? { path?: undefined } : { path: PathOf<K> };
type QueryArg<K extends OperationId> = [QueryOf<K>] extends [never] ? { query?: undefined } : { query?: QueryOf<K> };
type BodyArg<K extends OperationId> = [RequestBodyOf<K>] extends [never]
  ? { body?: undefined }
  : RequestBodyOf<K> extends { content: { "application/json": infer B } }
    ? undefined extends operations[K]["requestBody"]
      ? { body?: B }
      : { body: B }
    : { body?: undefined };

export interface CommonCallOptions {
  signal?: AbortSignal;
  /**
   * `Idempotency-Key` for POST operations. When omitted the SDK generates a random UUID once per call
   * and reuses it for every retry of that call.
   */
  idempotencyKey?: string;
}

export type CallArgs<K extends OperationId> = PathArg<K> & QueryArg<K> & BodyArg<K> & CommonCallOptions;

type SuccessOf<K extends OperationId> = {
  [S in keyof operations[K]["responses"] & (200 | 201 | 202)]: operations[K]["responses"][S];
}[keyof operations[K]["responses"] & (200 | 201 | 202)];

/** The decoded JSON body of the 2xx response (void for 204). */
export type ResponseData<K extends OperationId> = [SuccessOf<K>] extends [never]
  ? void
  : SuccessOf<K> extends { content: { "application/json": infer D } }
    ? D
    : void;

/** Operations whose response is `{ data: T[]; page: PageInfo }`. */
export type ListOperationId = {
  [K in OperationId]: ResponseData<K> extends { data: unknown[]; page: components["schemas"]["PageInfo"] } ? K : never;
}[OperationId];

export type ItemOf<K extends ListOperationId> = ResponseData<K> extends { data: (infer I)[] } ? I : never;

export interface ApiResponse<T> {
  data: T;
  status: number;
  /** Response headers (`Retry-After`, `RateLimit-*`, `Location`, `Idempotent-Replayed`, ...). */
  headers: Headers;
}

export type Site = components["schemas"]["Site"];
export type Sitemap = components["schemas"]["Sitemap"];
export type WarmRun = components["schemas"]["WarmRun"];
export type WarmRunCreate = components["schemas"]["WarmRunCreate"];
export type RunOptions = components["schemas"]["RunOptions"];
export type Outcome = components["schemas"]["Outcome"];
export type Result = components["schemas"]["Result"];
export type CacheState = components["schemas"]["CacheState"];
export type FailOnToken = components["schemas"]["FailOnToken"];
export type CacheStatusReport = components["schemas"]["CacheStatusReport"];
export type CacheStatusReportSummary = components["schemas"]["CacheStatusReportSummary"];
export type PageInfo = components["schemas"]["PageInfo"];
