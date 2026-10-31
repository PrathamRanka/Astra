/**
 * Distributed Lock Tests
 *
 * Unit tests use a mock Redis object that simulates Lua script responses.
 * Integration tests use a real Redis connection and skip cleanly if unavailable.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { acquireLock, releaseLock, renewLock } from "./index.js";
import { ValidationError } from "@astra/core/errors";

// ---------------------------------------------------------------------------
// Mock Redis helpers
// ---------------------------------------------------------------------------

interface EvalCall {
  keys: string[];
  args: (string | number)[];
}

/**
 * Creates a mock Redis client whose eval() function returns pre-configured responses.
 * Each call pops the next response from the queue.
 */
function makeMockRedis(responses: unknown[]): {
  redis: { eval: (...args: unknown[]) => Promise<unknown> };
  calls: EvalCall[];
} {
  const calls: EvalCall[] = [];
  const queue = [...responses];

  const redis = {
    eval: async (_script: string, keyCount: number, ...rest: unknown[]) => {
      const keys = rest.slice(0, keyCount) as string[];
      const args = rest.slice(keyCount) as (string | number)[];
      calls.push({ keys, args });
      if (queue.length === 0) throw new Error("Mock Redis: unexpected eval call");
      return queue.shift();
    },
  };

  return { redis: redis as unknown as { eval: (...args: unknown[]) => Promise<unknown> }, calls };
}

// ---------------------------------------------------------------------------
// Unit tests
// ---------------------------------------------------------------------------

describe("acquireLock – unit", () => {
  it("returns acquired=true with fencing token on success", async () => {
    const { redis } = makeMockRedis([[1, 42]]);
    const result = await acquireLock(redis as never, "proj1", "my-lock");

    assert.equal(result.acquired, true);
    assert.equal(result.fencingToken, 42);
    assert.ok(result.ownerToken.length > 0, "ownerToken should be non-empty");
    assert.ok(result.ttlMs > 0, "ttlMs should be positive");
  });

  it("returns acquired=false when lock is already held", async () => {
    const { redis } = makeMockRedis([[0, 0]]);
    const result = await acquireLock(redis as never, "proj1", "my-lock");

    assert.equal(result.acquired, false);
    assert.equal(result.fencingToken, 0);
    assert.equal(result.ownerToken, "");
  });

  it("throws ValidationError for empty projectId", async () => {
    await assert.rejects(
      () => acquireLock({} as never, "", "my-lock"),
      ValidationError,
    );
  });

  it("throws ValidationError for empty lockName", async () => {
    await assert.rejects(
      () => acquireLock({} as never, "proj1", ""),
      ValidationError,
    );
  });

  it("throws ValidationError for zero ttlMs", async () => {
    await assert.rejects(
      () => acquireLock({} as never, "proj1", "my-lock", { ttlMs: 0 }),
      ValidationError,
    );
  });

  it("accepts custom ownerToken", async () => {
    const { redis, calls } = makeMockRedis([[1, 5]]);
    await acquireLock(redis as never, "proj1", "my-lock", { ownerToken: "custom-token" });
    // First arg after keyCount in eval is the ownerToken
    assert.ok(calls[0]?.args[0] === "custom-token", "should pass custom ownerToken to Lua");
  });
});

describe("releaseLock – unit", () => {
  it("returns released=true when Lua returns 1", async () => {
    const { redis } = makeMockRedis([1]);
    const result = await releaseLock(redis as never, "proj1", "my-lock", "some-token");
    assert.equal(result.released, true);
  });

  it("returns released=false when Lua returns 0 (wrong owner)", async () => {
    const { redis } = makeMockRedis([0]);
    const result = await releaseLock(redis as never, "proj1", "my-lock", "wrong-token");
    assert.equal(result.released, false);
  });

  it("throws ValidationError for empty ownerToken", async () => {
    await assert.rejects(
      () => releaseLock({} as never, "proj1", "my-lock", ""),
      ValidationError,
    );
  });
});

describe("renewLock – unit", () => {
  it("returns renewed=true when Lua returns 1", async () => {
    const { redis } = makeMockRedis([1]);
    const result = await renewLock(redis as never, "proj1", "my-lock", "my-token");
    assert.equal(result.renewed, true);
  });

  it("returns renewed=false when Lua returns 0 (lock expired or wrong owner)", async () => {
    const { redis } = makeMockRedis([0]);
    const result = await renewLock(redis as never, "proj1", "my-lock", "my-token");
    assert.equal(result.renewed, false);
  });

  it("throws ValidationError for zero ttlMs", async () => {
    await assert.rejects(
      () => renewLock({} as never, "proj1", "my-lock", "token", 0),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration tests (require a running Redis, skip otherwise)
// ---------------------------------------------------------------------------

describe("Lock – integration", () => {
  let redis: import("@astra/redis/client").RedisClient | null = null;
  let isRedisAvailable = false;

  before(async () => {
    try {
      const { createRedisClient, connectRedis } = await import("@astra/redis/client");
      const client = createRedisClient("redis://127.0.0.1:6379", {
        connectTimeout: 500,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      client.on("error", () => {});
      await connectRedis(client);
      redis = client;
      isRedisAvailable = true;
    } catch {
      isRedisAvailable = false;
    }
  });

  it("expired lock can be re-acquired with higher fencing token", async (t) => {
    if (!isRedisAvailable || !redis) {
      t.skip("Redis unavailable");
      return;
    }

    const name = `lock-test-${Date.now()}`;

    const first = await acquireLock(redis, "integ-proj", name, { ttlMs: 100 });
    assert.equal(first.acquired, true);

    // Wait for lease to expire
    await new Promise((r) => setTimeout(r, 200));

    const second = await acquireLock(redis, "integ-proj", name, { ttlMs: 1000 });
    assert.equal(second.acquired, true);
    assert.ok(
      second.fencingToken > first.fencingToken,
      "fencing token should be higher on second acquisition",
    );

    await releaseLock(redis, "integ-proj", name, second.ownerToken);
  });
});
