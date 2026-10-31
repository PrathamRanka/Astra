import type { RedisClient } from "@astra/redis/client";
import { cacheKey, cacheLockKey } from "@astra/redis/keys";
import { executeLuaScript } from "@astra/redis/scripts";
import { generateId } from "@astra/core/ids";
import { ValidationError } from "@astra/core/errors";
import type { CacheSetOptions, CacheGetResult, CacheGetOrLoadOptions } from "./types.js";

export * from "./types.js";

const DEFAULT_LEASE_TTL_MS = 5_000;
const DEFAULT_WAIT_TIMEOUT_MS = 3_000;
// How long to wait between polling attempts when another caller holds the lock.
const POLL_INTERVAL_MS = 100;

/**
 * Reads a value from the project-scoped cache.
 *
 * Returns { hit: false } when the key does not exist or has expired.
 * The value is deserialized from JSON.
 */
export async function get<T>(
  redis: RedisClient,
  projectId: string,
  key: string,
): Promise<CacheGetResult<T>> {
  if (!projectId) throw new ValidationError("Missing projectId for cache.get");
  if (!key) throw new ValidationError("Missing key for cache.get");

  const vKey = cacheKey(projectId, key);
  const raw = await redis.get(vKey);

  if (raw === null) {
    return { hit: false };
  }

  return { hit: true, value: JSON.parse(raw) as T };
}

/**
 * Stores a value in the project-scoped cache with a TTL.
 *
 * The value is serialized to JSON. Overwrites any existing value.
 */
export async function set<T>(
  redis: RedisClient,
  projectId: string,
  key: string,
  value: T,
  options: CacheSetOptions,
): Promise<void> {
  if (!projectId) throw new ValidationError("Missing projectId for cache.set");
  if (!key) throw new ValidationError("Missing key for cache.set");
  if (options.ttlMs <= 0) throw new ValidationError("ttlMs must be a positive integer");

  const vKey = cacheKey(projectId, key);
  await redis.set(vKey, JSON.stringify(value), "PX", options.ttlMs);
}

/**
 * Deletes a key from the project-scoped cache.
 */
export async function del(
  redis: RedisClient,
  projectId: string,
  key: string,
): Promise<void> {
  if (!projectId) throw new ValidationError("Missing projectId for cache.del");
  if (!key) throw new ValidationError("Missing key for cache.del");

  const vKey = cacheKey(projectId, key);
  await redis.del(vKey);
}

/**
 * Returns a cached value or loads and caches it if missing.
 *
 * Stampede protection: only the first concurrent caller runs the loader.
 * Other concurrent callers wait up to waitTimeoutMs for the value to appear.
 * If the wait times out, they call the loader directly as a fallback.
 *
 * This is sometimes called "probabilistic early expiration" avoidance or
 * "single-flight cache fill".
 */
export async function getOrLoad<T>(
  redis: RedisClient,
  projectId: string,
  key: string,
  options: CacheGetOrLoadOptions<T>,
): Promise<T> {
  if (!projectId) throw new ValidationError("Missing projectId for cache.getOrLoad");
  if (!key) throw new ValidationError("Missing key for cache.getOrLoad");
  if (options.ttlMs <= 0) throw new ValidationError("ttlMs must be a positive integer");

  const leaseTtlMs = options.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const waitTimeoutMs = options.waitTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;

  const vKey = cacheKey(projectId, key);
  const lKey = cacheLockKey(projectId, key);
  const lockToken = generateId("cl");

  // Check the cache and try to acquire the refresh lock in one atomic step.
  const [status, payload] = await executeLuaScript<[number, string]>(
    redis,
    "cache_get_or_lock",
    [vKey, lKey],
    [lockToken, leaseTtlMs],
  );

  if (status === 1) {
    // Cache hit.
    return JSON.parse(payload) as T;
  }

  if (payload === "LOCKED") {
    // This caller won the lock. Run the loader, store the result, release the lock.
    return runLoaderAndStore(redis, vKey, lKey, lockToken, options);
  }

  // payload === "WAIT": poll until value appears or timeout, then fall back to direct load.
  return pollOrFallback(redis, projectId, key, options, waitTimeoutMs);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Runs the user-supplied loader, stores the result in Redis, then releases the lock.
 * On loader failure, deletes the lock so other callers are not starved.
 */
async function runLoaderAndStore<T>(
  redis: RedisClient,
  vKey: string,
  lKey: string,
  lockToken: string,
  options: CacheGetOrLoadOptions<T>,
): Promise<T> {
  let value: T;
  try {
    value = await options.loader();
  } catch (err) {
    // Release lock so another caller can attempt the load.
    // Compare-and-delete so we only delete our own lock.
    await compareAndDeleteLock(redis, lKey, lockToken);
    throw err;
  }

  // Store value with TTL.
  await redis.set(vKey, JSON.stringify(value), "PX", options.ttlMs);
  // Release the refresh lock.
  await compareAndDeleteLock(redis, lKey, lockToken);

  return value;
}

/**
 * Polls the cache until the value appears or waitTimeoutMs elapses.
 * Falls back to calling the loader directly if the poll times out.
 */
async function pollOrFallback<T>(
  redis: RedisClient,
  projectId: string,
  key: string,
  options: CacheGetOrLoadOptions<T>,
  waitTimeoutMs: number,
): Promise<T> {
  const vKey = cacheKey(projectId, key);
  const deadline = Date.now() + waitTimeoutMs;

  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const raw = await redis.get(vKey);
    if (raw !== null) {
      return JSON.parse(raw) as T;
    }
  }

  // Timed out waiting — fall back to running the loader directly (no lock held).
  return options.loader();
}

/**
 * Deletes a lock key only if it still contains our token.
 * Uses a small inline Lua script to make the check-and-delete atomic.
 */
async function compareAndDeleteLock(
  redis: RedisClient,
  lKey: string,
  lockToken: string,
): Promise<void> {
  const script = `
    if redis.call('GET', KEYS[1]) == ARGV[1] then
      redis.call('DEL', KEYS[1])
      return 1
    end
    return 0
  `;
  await redis.eval(script, 1, lKey, lockToken);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

