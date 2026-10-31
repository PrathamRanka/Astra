/**
 * Queue Tests
 *
 * Unit tests mock the Redis eval call to verify the correct Lua scripts and
 * arguments are invoked. Integration tests require a running Redis instance.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { enqueue, claim, ack, nack } from "./index.js";
import { ValidationError } from "@astra/core/errors";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

type MockResponse = unknown;

function makeMockRedis(evalResponses: MockResponse[], hashData: Record<string, Record<string, string>> = {}) {
  const queue = [...evalResponses];
  const calls: { script: string; keys: string[]; args: (string | number)[] }[] = [];
  const hashes: Record<string, Record<string, string>> = { ...hashData };

  const redis = {
    eval: async (script: string, keyCount: number, ...rest: unknown[]) => {
      const keys = rest.slice(0, keyCount) as string[];
      const args = rest.slice(keyCount) as (string | number)[];
      calls.push({ script, keys, args });
      if (queue.length === 0) throw new Error("Mock: unexpected eval");
      return queue.shift();
    },
    hset: async (key: string, fields: Record<string, string>) => {
      hashes[key] = { ...(hashes[key] ?? {}), ...fields };
      return Object.keys(fields).length;
    },
    hincrby: async (key: string, field: string, incr: number) => {
      const prev = parseInt(hashes[key]?.[field] ?? "0", 10);
      const next = prev + incr;
      if (!hashes[key]) hashes[key] = {};
      hashes[key]![field] = String(next);
      return next;
    },
    hgetall: async (key: string) => hashes[key] ?? null,
    hmget: async (key: string, ...fields: string[]) => {
      const h = hashes[key] ?? {};
      return fields.map((f) => h[f] ?? null);
    },
  };

  return { redis: redis as never, calls, hashes };
}

// ---------------------------------------------------------------------------
// enqueue – unit
// ---------------------------------------------------------------------------

describe("enqueue – unit", () => {
  it("creates a new job (no idempotency key)", async () => {
    const { redis } = makeMockRedis([[1, "job_abc123"]]);
    const result = await enqueue(redis, "proj1", "default", JSON.stringify({ task: "send-email" }));

    assert.equal(result.created, true);
    assert.equal(result.jobId, "job_abc123");
  });

  it("returns existing job when idempotency key matches", async () => {
    const { redis } = makeMockRedis([[0, "job_existing"]]);
    const result = await enqueue(
      redis,
      "proj1",
      "default",
      JSON.stringify({ task: "send-email" }),
      { idempotencyKey: "email-123" },
    );

    assert.equal(result.created, false);
    assert.equal(result.jobId, "job_existing");
  });

  it("throws ValidationError for empty projectId", async () => {
    await assert.rejects(
      () => enqueue({} as never, "", "q", "payload"),
      ValidationError,
    );
  });

  it("throws ValidationError for empty queueName", async () => {
    await assert.rejects(
      () => enqueue({} as never, "proj1", "", "payload"),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// claim – unit
// ---------------------------------------------------------------------------

describe("claim – unit", () => {
  it("returns claimed=true with job metadata when a job is available", async () => {
    const jobId = "job_abc123";
    const jobKey = `queue:{proj1}:job:${jobId}`;

    // eval returns [jobId, ownerToken]; subsequent hset/hincrby/hgetall use the hashes map
    const initialHash = {
      [jobKey]: {
        payload: '{"task":"send-email"}',
        attempts: "0",
        maxAttempts: "3",
        createdAt: "1000000",
        status: "pending",
      },
    };
    const { redis } = makeMockRedis([[jobId, "some-owner-token"]], initialHash);

    const result = await claim(redis, "proj1", "default");

    assert.equal(result.claimed, true);
    assert.ok(result.job !== undefined);
    assert.equal(result.job?.jobId, jobId);
    assert.equal(result.job?.payload, '{"task":"send-email"}');
  });

  it("returns claimed=false when queue is empty", async () => {
    const { redis } = makeMockRedis([null]);
    const result = await claim(redis, "proj1", "default");
    assert.equal(result.claimed, false);
  });

  it("throws ValidationError for empty projectId", async () => {
    await assert.rejects(
      () => claim({} as never, "", "q"),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// ack – unit
// ---------------------------------------------------------------------------

describe("ack – unit", () => {
  it("returns acked=true when Lua returns 1", async () => {
    const { redis } = makeMockRedis([1]);
    const result = await ack(redis, "proj1", "default", "job_abc", "owner_tok");
    assert.equal(result.acked, true);
  });

  it("returns acked=false when Lua returns 0 (wrong owner)", async () => {
    const { redis } = makeMockRedis([0]);
    const result = await ack(redis, "proj1", "default", "job_abc", "wrong_tok");
    assert.equal(result.acked, false);
  });

  it("throws ValidationError for missing jobId", async () => {
    await assert.rejects(
      () => ack({} as never, "proj1", "default", "", "tok"),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// nack – unit
// ---------------------------------------------------------------------------

describe("nack – unit", () => {
  it("returns result=requeued when Lua returns 1", async () => {
    const jobKey = `queue:{proj1}:job:job_abc`;
    const { redis } = makeMockRedis(
      [1], // nack Lua result
      { [jobKey]: { attempts: "1", maxAttempts: "3" } },
    );
    const result = await nack(redis, "proj1", "default", "job_abc", "owner_tok");
    assert.equal(result.result, "requeued");
  });

  it("returns result=dead when Lua returns 2", async () => {
    const jobKey = `queue:{proj1}:job:job_abc`;
    const { redis } = makeMockRedis(
      [2],
      { [jobKey]: { attempts: "3", maxAttempts: "3" } },
    );
    const result = await nack(redis, "proj1", "default", "job_abc", "owner_tok");
    assert.equal(result.result, "dead");
  });

  it("returns result=not_found when Lua returns 0", async () => {
    const jobKey = `queue:{proj1}:job:job_abc`;
    const { redis } = makeMockRedis(
      [0],
      { [jobKey]: { attempts: "1", maxAttempts: "3" } },
    );
    const result = await nack(redis, "proj1", "default", "job_abc", "wrong_tok");
    assert.equal(result.result, "not_found");
  });

  it("throws ValidationError for missing ownerToken", async () => {
    await assert.rejects(
      () => nack({} as never, "proj1", "default", "job_abc", ""),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// Integration (real Redis, skip if unavailable)
// ---------------------------------------------------------------------------

describe("Queue – integration", () => {
  let redis: import("@astra/redis/client").RedisClient | null = null;

  before(async (t) => {
    try {
      const { connectRedis } = await import("@astra/redis/client");
      redis = await connectRedis({ host: "127.0.0.1", port: 6379, retryStrategy: () => null });
      redis.on("error", () => {});
    } catch {
      await t.test.skip("Redis unavailable – skipping integration tests");
    }
  });

  it("full enqueue → claim → ack cycle", { skip: !redis }, async (t) => {
    if (!redis) return t.skip("Redis not connected");

    const projectId = `integ-${Date.now()}`;
    const queueName = "test-queue";
    const payload = JSON.stringify({ msg: "hello" });

    const enqResult = await enqueue(redis, projectId, queueName, payload);
    assert.equal(enqResult.created, true);

    const claimResult = await claim(redis, projectId, queueName);
    assert.equal(claimResult.claimed, true);
    assert.equal(claimResult.job?.payload, payload);

    const ackResult = await ack(
      redis,
      projectId,
      queueName,
      claimResult.job!.jobId,
      claimResult.ownerToken!,
    );
    assert.equal(ackResult.acked, true);

    // Queue should now be empty
    const nextClaim = await claim(redis, projectId, queueName);
    assert.equal(nextClaim.claimed, false);

    redis.disconnect();
  });
});

