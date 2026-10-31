/**
 * Rate Limiter Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { takeToken } from "./index.js";
import { ValidationError } from "@astra/core/errors";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

interface BucketState {
  tokens: number;
  last_refill_ms: number;
}

/**
 * Simulates the token bucket logic in Lua, running in Node.js for unit tests.
 * Not a replacement for the real Lua script — only exercises the TypeScript layer.
 */
function makeMockRedis(buckets: Record<string, BucketState> = {}) {
  const evalCalls: unknown[][] = [];

  const redis = {
    eval: async (script: string, keyCount: number, ...rest: unknown[]) => {
      evalCalls.push([script, keyCount, ...rest]);
      const keys = rest.slice(0, keyCount) as string[];
      const argv = rest.slice(keyCount) as (string | number)[];

      const bucketKey = keys[0]!;
      const capacity = Number(argv[0]);
      const refillRatePerSec = Number(argv[1]);
      const cost = Number(argv[2]);

      const nowMs = Date.now();

      const bucket = buckets[bucketKey] ?? { tokens: capacity, last_refill_ms: nowMs };
      const elapsedSec = Math.max(0, nowMs - bucket.last_refill_ms) / 1000;
      const refilled = Math.min(capacity, bucket.tokens + elapsedSec * refillRatePerSec);

      if (refilled >= cost) {
        const remaining = refilled - cost;
        buckets[bucketKey] = { tokens: remaining, last_refill_ms: nowMs };
        return [1, Math.floor(remaining), 0];
      }

      const deficit = cost - refilled;
      const retryAfterMs = Math.ceil((deficit / refillRatePerSec) * 1000);
      buckets[bucketKey] = { tokens: refilled, last_refill_ms: nowMs };
      return [0, Math.floor(refilled), retryAfterMs];
    },
  };

  return { redis: redis as never, evalCalls, buckets };
}

// ---------------------------------------------------------------------------
// takeToken – unit
// ---------------------------------------------------------------------------

describe("takeToken – unit", () => {
  it("allows request when bucket is full", async () => {
    const { redis } = makeMockRedis();
    const result = await takeToken(redis, "proj1", "api", {
      capacity: 10,
      refillRatePerSec: 5,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 9);
    assert.equal(result.retryAfterMs, 0);
  });

  it("denies request when bucket is empty", async () => {
    const nowMs = Date.now();
    const { redis } = makeMockRedis({
      "ratelimit:{proj1}:bucket:api": { tokens: 0, last_refill_ms: nowMs },
    });

    const result = await takeToken(redis, "proj1", "api", {
      capacity: 10,
      refillRatePerSec: 1, // 1 token/sec means retryAfterMs ≈ 1000
    });

    assert.equal(result.allowed, false);
    assert.ok(result.retryAfterMs > 0, "retryAfterMs should be > 0 when denied");
  });

  it("deducts cost from available tokens", async () => {
    const nowMs = Date.now();
    const { redis } = makeMockRedis({
      "ratelimit:{proj1}:bucket:api": { tokens: 5, last_refill_ms: nowMs },
    });

    const result = await takeToken(redis, "proj1", "api", {
      capacity: 10,
      refillRatePerSec: 5,
      cost: 3,
    });

    assert.equal(result.allowed, true);
    assert.equal(result.remaining, 2);
  });

  it("throws ValidationError for empty projectId", async () => {
    await assert.rejects(
      () => takeToken({} as never, "", "api", { capacity: 10, refillRatePerSec: 5 }),
      ValidationError,
    );
  });

  it("throws ValidationError for zero capacity", async () => {
    await assert.rejects(
      () => takeToken({} as never, "proj1", "api", { capacity: 0, refillRatePerSec: 5 }),
      ValidationError,
    );
  });

  it("throws ValidationError for zero refillRatePerSec", async () => {
    await assert.rejects(
      () => takeToken({} as never, "proj1", "api", { capacity: 10, refillRatePerSec: 0 }),
      ValidationError,
    );
  });

  it("throws ValidationError for zero cost", async () => {
    await assert.rejects(
      () => takeToken({} as never, "proj1", "api", { capacity: 10, refillRatePerSec: 5, cost: 0 }),
      ValidationError,
    );
  });

  it("sequential requests deplete the bucket", async () => {
    const { redis } = makeMockRedis();
    const opts = { capacity: 3, refillRatePerSec: 0.1 }; // very slow refill

    const r1 = await takeToken(redis, "proj1", "seq-test", opts);
    const r2 = await takeToken(redis, "proj1", "seq-test", opts);
    const r3 = await takeToken(redis, "proj1", "seq-test", opts);
    const r4 = await takeToken(redis, "proj1", "seq-test", opts);

    assert.equal(r1.allowed, true);
    assert.equal(r2.allowed, true);
    assert.equal(r3.allowed, true);
    assert.equal(r4.allowed, false); // bucket exhausted
  });
});

