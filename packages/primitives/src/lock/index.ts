import type { RedisClient } from "@astra/redis/client";
import { lockKey, lockFenceKey } from "@astra/redis/keys";
import { executeLuaScript } from "@astra/redis/scripts";
import { generateId } from "@astra/core/ids";
import { ValidationError } from "@astra/core/errors";
import type {
  LockAcquireOptions,
  LockAcquireResult,
  LockRenewResult,
  LockReleaseResult,
} from "./types.js";

export * from "./types.js";

const DEFAULT_LOCK_TTL_MS = 10_000;

/**
 * Acquires a distributed lock lease for a project-scoped resource.
 *
 * Atomically sets the lock with TTL and increments the monotonic fencing token.
 * Returns acquired=false if another client holds the lease.
 */
export async function acquireLock(
  redis: RedisClient,
  projectId: string,
  lockName: string,
  options?: LockAcquireOptions,
): Promise<LockAcquireResult> {
  if (!projectId) throw new ValidationError("Missing projectId for acquireLock");
  if (!lockName) throw new ValidationError("Missing lockName for acquireLock");

  const ttlMs = options?.ttlMs ?? DEFAULT_LOCK_TTL_MS;
  if (ttlMs <= 0) throw new ValidationError("ttlMs must be a positive integer");

  const ownerToken = options?.ownerToken ?? generateId("owner");

  const lKey = lockKey(projectId, lockName);
  const fKey = lockFenceKey(projectId, lockName);

  const [status, fencingToken] = await executeLuaScript<[number, number]>(
    redis,
    "lock_acquire",
    [lKey, fKey],
    [ownerToken, ttlMs],
  );

  const acquired = status === 1;

  return {
    acquired,
    ownerToken: acquired ? ownerToken : "",
    fencingToken: acquired ? fencingToken : 0,
    ttlMs,
  };
}

/**
 * Safely releases a distributed lock lease.
 *
 * Compares the ownerToken atomically before deleting.
 * Returns released=false if the lease expired or belongs to another owner.
 */
export async function releaseLock(
  redis: RedisClient,
  projectId: string,
  lockName: string,
  ownerToken: string,
): Promise<LockReleaseResult> {
  if (!projectId) throw new ValidationError("Missing projectId for releaseLock");
  if (!lockName) throw new ValidationError("Missing lockName for releaseLock");
  if (!ownerToken) throw new ValidationError("Missing ownerToken for releaseLock");

  const lKey = lockKey(projectId, lockName);

  const result = await executeLuaScript<number>(
    redis,
    "lock_release",
    [lKey],
    [ownerToken],
  );

  return { released: result === 1 };
}

/**
 * Renews the TTL of an active lock lease.
 *
 * Verifies that the caller is still the current owner before extending the TTL.
 */
export async function renewLock(
  redis: RedisClient,
  projectId: string,
  lockName: string,
  ownerToken: string,
  ttlMs = DEFAULT_LOCK_TTL_MS,
): Promise<LockRenewResult> {
  if (!projectId) throw new ValidationError("Missing projectId for renewLock");
  if (!lockName) throw new ValidationError("Missing lockName for renewLock");
  if (!ownerToken) throw new ValidationError("Missing ownerToken for renewLock");
  if (ttlMs <= 0) throw new ValidationError("ttlMs must be a positive integer");

  const lKey = lockKey(projectId, lockName);

  const result = await executeLuaScript<number>(
    redis,
    "lock_renew",
    [lKey],
    [ownerToken, ttlMs],
  );

  return { renewed: result === 1 };
}

