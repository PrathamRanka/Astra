import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { RedisClient } from "@astra/redis/client";
import type { TenantContext } from "@astra/core/types";
import { ValidationError } from "@astra/core/errors";
import { admitRequest } from "./admit.js";
import { PLAN_LIMITS } from "./plans.js";

function createMockRedis(evalHandler: (keys: string[], args: (string | number)[]) => Promise<unknown>): RedisClient {
  return {
    eval: async (_script: string, keyCount: number, ...allArgs: (string | number)[]) => {
      const keys = allArgs.slice(0, keyCount).map(String);
      const args = allArgs.slice(keyCount);
      return evalHandler(keys, args);
    },
  } as unknown as RedisClient;
}

const mockTenant: TenantContext = {
  orgId: "org_1",
  projectId: "proj_123",
  planId: "free",
  keyId: "key_abc",
  limits: PLAN_LIMITS.free,
};

describe("Governor Admission Control Unit Tests", () => {
  it("rejects input with missing tenant or projectId", async () => {
    const redis = createMockRedis(async () => [0, 0]);
    await assert.rejects(
      async () => admitRequest(redis, null as unknown as TenantContext),
      (err: Error) => err instanceof ValidationError && /Missing tenant context/.test(err.message),
    );

    await assert.rejects(
      async () => admitRequest(redis, { ...mockTenant, projectId: "" }),
      (err: Error) => err instanceof ValidationError && /Missing tenant context/.test(err.message),
    );
  });

  it("rejects non-positive request cost", async () => {
    const redis = createMockRedis(async () => [0, 0]);
    await assert.rejects(
      async () => admitRequest(redis, mockTenant, { cost: 0 }),
      (err: Error) => err instanceof ValidationError && /positive integer/.test(err.message),
    );
    await assert.rejects(
      async () => admitRequest(redis, mockTenant, { cost: -5 }),
      (err: Error) => err instanceof ValidationError && /positive integer/.test(err.message),
    );
  });

  it("admits request when Lua script returns status 0", async () => {
    let capturedKeys: string[] = [];
    let capturedArgs: (string | number)[] = [];

    const redis = createMockRedis(async (keys, args) => {
      capturedKeys = keys;
      capturedArgs = args;
      return [0, 0];
    });

    const res = await admitRequest(redis, mockTenant, { operation: "cache_get", cost: 1 });
    assert.deepEqual(res, { ok: true });

    // Validate Redis Cluster hash tag compatibility on keys
    assert.equal(capturedKeys.length, 3);
    assert.ok(capturedKeys[0].includes(":{proj_123}:"));
    assert.ok(capturedKeys[1].includes(":{proj_123}:"));
    assert.equal(capturedKeys[2], ""); // non-queue operation

    // Validate ARGV passed to script
    assert.equal(capturedArgs[0], PLAN_LIMITS.free.rps);
    assert.equal(capturedArgs[1], PLAN_LIMITS.free.rps);
    assert.equal(capturedArgs[2], 1); // cost
    assert.equal(capturedArgs[3], PLAN_LIMITS.free.opsPerDay);
    assert.equal(capturedArgs[4], PLAN_LIMITS.free.maxBacklog);
    assert.equal(capturedArgs[5], 0); // is_queue_op = 0
  });

  it("returns RATE denial when Lua returns status 1", async () => {
    const redis = createMockRedis(async () => [1, 250]);
    const res = await admitRequest(redis, mockTenant, { operation: "cache_get" });
    assert.deepEqual(res, { ok: false, reason: "RATE", retryAfterMs: 250 });
  });

  it("returns QUOTA denial when Lua returns status 2", async () => {
    const redis = createMockRedis(async () => [2, 3600000]);
    const res = await admitRequest(redis, mockTenant, { operation: "cache_get" });
    assert.deepEqual(res, { ok: false, reason: "QUOTA", retryAfterMs: 3600000 });
  });

  it("returns BACKLOG denial when Lua returns status 3 for queue operation", async () => {
    let capturedKeys: string[] = [];
    let capturedArgs: (string | number)[] = [];

    const redis = createMockRedis(async (keys, args) => {
      capturedKeys = keys;
      capturedArgs = args;
      return [3, 500];
    });

    const res = await admitRequest(redis, mockTenant, {
      operation: "queue_enqueue",
      queueName: "mailers",
    });

    assert.deepEqual(res, { ok: false, reason: "BACKLOG", retryAfterMs: 500 });
    assert.ok(capturedKeys[2].includes("queue:{proj_123}:pending:mailers"));
    assert.equal(capturedArgs[5], 1); // is_queue_op = 1
  });

  it("propagates Redis execution failures", async () => {
    const redis = createMockRedis(async () => {
      throw new Error("Redis connection lost");
    });

    await assert.rejects(
      async () => admitRequest(redis, mockTenant),
      { message: "Redis connection lost" },
    );
  });

  it("throws clear error on malformed Lua responses", async () => {
    const redis = createMockRedis(async () => "invalid_response");
    await assert.rejects(
      async () => admitRequest(redis, mockTenant),
      { message: /Unexpected response from governor_admit/ },
    );
  });
});
