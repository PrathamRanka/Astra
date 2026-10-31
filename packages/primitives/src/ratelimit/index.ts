import type { RedisClient } from "@astra/redis/client";
import { rateLimitKey } from "@astra/redis/keys";
import { executeLuaScript } from "@astra/redis/scripts";
import { ValidationError } from "@astra/core/errors";
import type { RateLimitOptions, RateLimitResult } from "./types.js";

export * from "./types.js";

/**
 * Attempts to consume tokens from a named token bucket.
 *
 * The bucket is lazily created on first use (starts full at capacity).
 * Tokens refill continuously at refillRatePerSec.
 * Bucket state persists in Redis with a 1-hour TTL from last use.
 *
 * This is a standalone developer primitive. It operates independently of the
 * Tenant Governor's admission control; call the Governor separately to enforce
 * plan-level limits before calling this.
 */
export async function takeToken(
  redis: RedisClient,
  projectId: string,
  limiterName: string,
  options: RateLimitOptions,
): Promise<RateLimitResult> {
  if (!projectId) throw new ValidationError("Missing projectId for takeToken");
  if (!limiterName) throw new ValidationError("Missing limiterName for takeToken");
  if (options.capacity <= 0) throw new ValidationError("capacity must be a positive number");
  if (options.refillRatePerSec <= 0) throw new ValidationError("refillRatePerSec must be a positive number");

  const cost = options.cost ?? 1;
  if (cost <= 0) throw new ValidationError("cost must be a positive number");

  const bKey = rateLimitKey(projectId, limiterName);

  const [allowed, remaining, retryAfterMs] = await executeLuaScript<[number, number, number]>(
    redis,
    "rate_limit_take",
    [bKey],
    [options.capacity, options.refillRatePerSec, cost],
  );

  return {
    allowed: allowed === 1,
    remaining,
    retryAfterMs,
  };
}

