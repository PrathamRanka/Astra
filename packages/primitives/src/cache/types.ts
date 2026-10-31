/**
 * Types for Astra Cache
 *
 * The cache primitive provides a project-scoped key/value store backed by Redis.
 *
 * Keys in Redis:
 *   - Value:        cache:{projectId}:entry:<key>   (Redis string, with TTL)
 *   - Refresh lock: cache:{projectId}:lock:<key>    (Redis string, short TTL)
 *
 * Stampede protection:
 *   When getOrLoad is called and the value is missing, only the first caller
 *   runs the loader. Others wait briefly for the result. If the loader fails,
 *   the lock is released so another caller can retry.
 */

export interface CacheSetOptions {
  /** How long the cached value lives in Redis, in milliseconds. */
  ttlMs: number;
}

export interface CacheGetResult<T> {
  /** Whether the key existed in the cache. */
  hit: boolean;
  /** The deserialized value (only set when hit=true). */
  value?: T;
}

export interface CacheGetOrLoadOptions<T> {
  /** How long the cached value lives in Redis, in milliseconds. */
  ttlMs: number;

  /**
   * Async function that computes the value when it is not cached.
   * The result is serialized to JSON and stored in Redis.
   */
  loader: () => Promise<T>;

  /**
   * How long the refresh lock is held by the loading caller, in milliseconds.
   * Defaults to 5,000 ms. If the loader takes longer than this, other callers
   * may start a competing load.
   */
  leaseTtlMs?: number;

  /**
   * Maximum time other callers will wait for the value to appear, in milliseconds.
   * After this period, waiting callers call the loader directly as a fallback.
   * Defaults to 3,000 ms.
   */
  waitTimeoutMs?: number;
}

