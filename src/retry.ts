/** Parses `Retry-After`: delta-seconds or an HTTP-date. Returns seconds (>= 0) or undefined. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | undefined {
  if (value == null) return undefined;
  const v = value.trim();
  if (v === "") return undefined;
  if (/^\d+$/.test(v)) return Number(v);
  const at = Date.parse(v);
  if (Number.isNaN(at)) return undefined;
  return Math.max(0, Math.ceil((at - now) / 1000));
}

/** Exponential backoff with "equal jitter": half fixed, half random. Result in ms. */
export function backoffDelayMs(attempt: number, baseMs: number, maxMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(ceiling / 2 + random() * (ceiling / 2));
}

/** Abortable sleep. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
