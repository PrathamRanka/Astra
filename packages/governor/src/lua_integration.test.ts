import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRedisClient, connectRedis, closeRedis, type RedisClient } from "@astra/redis/client";
import { governorRateKey, governorDailyQuotaKey, governorQueueBacklogKey } from "@astra/redis/keys";
import { admitRequest } from "./admit.js";
import type { TenantContext } from "@astra/core/types";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

describe("Governor Lua Integration Tests", () => {
  let redis: RedisClient | null = null;
  let isRedisAvailable = false;

  before(async () => {
    try {
      const client = createRedisClient(REDIS_URL, {
        connectTimeout: 500,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null, // disable retry
      });
      client.on("error", () => {}); // silence unhandled error when server absent
      await connectRedis(client);
      redis = client;
      isRedisAvailable = true;
    } catch {
      isRedisAvailable = false;
      if (redis) {
        await closeRedis(redis).catch(() => {});
        redis = null;
      }
    }
  });

  after(async () => {
    if (redis) {
      await closeRedis(redis).catch(() => {});
    }
  });

  it("performs token bucket rate limiting atomically against Redis", async (t) => {
    if (!isRedisAvailable || !redis) {
      t.skip("Redis instance is not reachable at " + REDIS_URL);
      return;
    }

    const tenant: TenantContext = {
      orgId: "org_test",
      projectId: "proj_it_rate",
      planId: "free",
      keyId: "key_it",
      limits: {
        weight: 1,
        rps: 2, // 2 tokens capacity
        maxConcurrency: 2,
        maxBacklog: 10,
        memBytes: 1024,
        opsPerDay: 100,
      },
    };

    // Clean any prior state
    const rateKey = governorRateKey(tenant.projectId, "test_op");
    await redis.del(rateKey);

    // 1st request (cost 1) -> admitted, remaining 1
    const r1 = await admitRequest(redis, tenant, { operation: "test_op", cost: 1 });
    assert.deepEqual(r1, { ok: true });

    // 2nd request (cost 1) -> admitted, remaining 0
    const r2 = await admitRequest(redis, tenant, { operation: "test_op", cost: 1 });
    assert.deepEqual(r2, { ok: true });

    // 3rd request (cost 1) -> denied by RATE
    const r3 = await admitRequest(redis, tenant, { operation: "test_op", cost: 1 });
    assert.equal(r3.ok, false);
    if (!r3.ok) {
      assert.equal(r3.reason, "RATE");
      assert.ok(r3.retryAfterMs > 0);
    }
  });

  it("enforces daily quota limit atomically against Redis", async (t) => {
    if (!isRedisAvailable || !redis) {
      t.skip("Redis instance is not reachable at " + REDIS_URL);
      return;
    }

    const tenant: TenantContext = {
      orgId: "org_test",
      projectId: "proj_it_quota",
      planId: "free",
      keyId: "key_it",
      limits: {
        weight: 1,
        rps: 100,
        maxConcurrency: 2,
        maxBacklog: 10,
        memBytes: 1024,
        opsPerDay: 2, // only 2 ops per day
      },
    };

    const todayStr = new Date().toISOString().slice(0, 10);
    const quotaKey = governorDailyQuotaKey(tenant.projectId, todayStr);
    await redis.del(quotaKey);

    // 1st op
    const r1 = await admitRequest(redis, tenant, { operation: "op1", cost: 1 });
    assert.deepEqual(r1, { ok: true });

    // 2nd op
    const r2 = await admitRequest(redis, tenant, { operation: "op1", cost: 1 });
    assert.deepEqual(r2, { ok: true });

    // 3rd op -> denied by QUOTA
    const r3 = await admitRequest(redis, tenant, { operation: "op1", cost: 1 });
    assert.equal(r3.ok, false);
    if (!r3.ok) {
      assert.equal(r3.reason, "QUOTA");
      assert.ok(r3.retryAfterMs > 0);
    }

    // Verify quota counter was not incremented past 2
    const currentOps = await redis.get(quotaKey);
    assert.equal(currentOps, "2");
  });

  it("enforces queue backlog limit atomically against Redis", async (t) => {
    if (!isRedisAvailable || !redis) {
      t.skip("Redis instance is not reachable at " + REDIS_URL);
      return;
    }

    const tenant: TenantContext = {
      orgId: "org_test",
      projectId: "proj_it_backlog",
      planId: "free",
      keyId: "key_it",
      limits: {
        weight: 1,
        rps: 100,
        maxConcurrency: 2,
        maxBacklog: 2, // max 2 items in queue
        memBytes: 1024,
        opsPerDay: 100,
      },
    };

    const backlogKey = governorQueueBacklogKey(tenant.projectId, "jobs");
    await redis.del(backlogKey);

    // Add 2 items to the zset (simulating existing pending jobs)
    await redis.zadd(backlogKey, 100, "job1", 200, "job2");

    // Queue operation that would exceed backlog limit of 2
    const r = await admitRequest(redis, tenant, {
      operation: "queue_enqueue",
      queueName: "jobs",
      cost: 1,
    });

    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, "BACKLOG");
    }
  });
});
