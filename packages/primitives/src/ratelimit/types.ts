/**
 * Types for the Astra standalone rate limiter.
 *
 * Uses a token bucket algorithm backed by Redis server time.
 * This is the developer-facing API primitive; the Tenant Governor
 * uses the same algorithm internally for admission control.
 *
 * Key: ratelimit:{projectId}:bucket:<name>
 */

export interface RateLimitOptions {
  /**
   * Maximum number of tokens in the bucket.
   * Determines burst capacity.
   */
  capacity: number;

  /**
   * Rate at which tokens are replenished (tokens per second).
   * A value of 10 means 10 tokens refill every second.
   */
  refillRatePerSec: number;

  /**
   * Number of tokens to consume per call.
   * Defaults to 1. Use a higher cost to model expensive operations.
   */
  cost?: number;
}

export interface RateLimitResult {
  /** Whether the request was allowed. */
  allowed: boolean;

  /** Number of tokens remaining in the bucket after this decision. */
  remaining: number;

  /**
   * Estimated time in milliseconds until enough tokens accumulate
   * to allow another request of the same cost.
   * 0 when allowed=true.
   */
  retryAfterMs: number;
}

