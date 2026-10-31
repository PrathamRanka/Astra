import type { RedisClient } from "@astra/redis/client";
import {
  queuePendingKey,
  queueProcessingKey,
  queueJobKey,
  queueIdemKey,
  queueDeadLetterKey,
} from "@astra/redis/keys";
import { executeLuaScript } from "@astra/redis/scripts";
import { generateId } from "@astra/core/ids";
import { ValidationError } from "@astra/core/errors";
import type {
  EnqueueOptions,
  EnqueueResult,
  ClaimOptions,
  ClaimResult,
  JobMetadata,
  NackOptions,
  ReapOptions,
  ReapResult,
} from "./types.js";

export * from "./types.js";

const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_LEASE_TTL_MS = 30_000;
const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_BATCH_SIZE = 50;
const MAX_RETRY_DELAY_MS = 3_600_000; // 1 hour cap on retry backoff
const IDEM_KEY_PLACEHOLDER = ""; // empty string when no idempotency key

/**
 * Enqueues a job onto a named queue for a project.
 *
 * - Supports optional delay before a job becomes eligible.
 * - Supports idempotency: a second call with the same idempotencyKey returns
 *   the existing job and created=false.
 * - Delivery guarantee is AT-LEAST-ONCE; workers must be idempotent.
 */
export async function enqueue(
  redis: RedisClient,
  projectId: string,
  queueName: string,
  payload: string,
  options?: EnqueueOptions,
): Promise<EnqueueResult> {
  if (!projectId) throw new ValidationError("Missing projectId for enqueue");
  if (!queueName) throw new ValidationError("Missing queueName for enqueue");
  if (payload === undefined || payload === null) {
    throw new ValidationError("Missing payload for enqueue");
  }

  const jobId = generateId("job");
  const nowMs = Date.now();
  const runAtMs = nowMs + (options?.delayMs ?? 0);
  const maxAttempts = options?.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const idempotencyKey = options?.idempotencyKey;

  const pendingKey = queuePendingKey(projectId, queueName);
  const jobKey = queueJobKey(projectId, jobId);
  const idemKey = idempotencyKey
    ? queueIdemKey(projectId, idempotencyKey)
    : IDEM_KEY_PLACEHOLDER;

  const [created, resultJobId] = await executeLuaScript<[number, string]>(
    redis,
    "queue_enqueue",
    [pendingKey, jobKey, idemKey],
    [jobId, payload, runAtMs, maxAttempts, nowMs, idempotencyKey ? 1 : 0],
  );

  return {
    jobId: resultJobId,
    created: created === 1,
  };
}

/**
 * Claims the next eligible job from a named queue.
 *
 * - Only returns jobs whose runAt timestamp is in the past (ready jobs).
 * - The job is moved to the processing set with a lease expiry.
 * - If the lease expires without an ack/nack, `reap` will recover the job.
 */
export async function claim(
  redis: RedisClient,
  projectId: string,
  queueName: string,
  options?: ClaimOptions,
): Promise<ClaimResult> {
  if (!projectId) throw new ValidationError("Missing projectId for claim");
  if (!queueName) throw new ValidationError("Missing queueName for claim");

  const leaseTtlMs = options?.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const nowMs = Date.now();
  const leaseExpiryMs = nowMs + leaseTtlMs;
  const ownerToken = generateId("owner");

  const pendingKey = queuePendingKey(projectId, queueName);
  const processingKey = queueProcessingKey(projectId, queueName);

  const result = await executeLuaScript<[string, string] | null>(
    redis,
    "queue_claim",
    [pendingKey, processingKey],
    [nowMs, leaseExpiryMs, ownerToken],
  );

  if (!result) {
    return { claimed: false };
  }

  const [jobId] = result;
  const jobKey = queueJobKey(projectId, jobId);

  // Store ownerToken in the job hash so ack/nack can verify ownership.
  // Increment attempts to track this delivery.
  // These writes happen right after the atomic claim, so the worker holds the lease.
  await redis.hset(jobKey, {
    ownerToken,
    status: "processing",
  });
  await redis.hincrby(jobKey, "attempts", 1);

  // Read full job metadata for the caller.
  const raw = await redis.hgetall(jobKey);

  if (!raw || !raw["payload"]) {
    // Job hash missing — race condition or already acked; treat as not claimed.
    return { claimed: false };
  }

  const job: JobMetadata = {
    jobId,
    payload: raw["payload"],
    attempts: parseInt(raw["attempts"] ?? "1", 10),
    maxAttempts: parseInt(raw["maxAttempts"] ?? String(DEFAULT_MAX_ATTEMPTS), 10),
    createdAt: parseInt(raw["createdAt"] ?? "0", 10),
  };

  return { claimed: true, job, ownerToken };
}

/**
 * Acknowledges successful job processing.
 *
 * Removes the job from the processing set and deletes its data hash.
 * Only the claim owner (matching ownerToken) can ack.
 */
export async function ack(
  redis: RedisClient,
  projectId: string,
  queueName: string,
  jobId: string,
  ownerToken: string,
): Promise<{ acked: boolean }> {
  if (!projectId) throw new ValidationError("Missing projectId for ack");
  if (!queueName) throw new ValidationError("Missing queueName for ack");
  if (!jobId) throw new ValidationError("Missing jobId for ack");
  if (!ownerToken) throw new ValidationError("Missing ownerToken for ack");

  const processingKey = queueProcessingKey(projectId, queueName);
  const jobKey = queueJobKey(projectId, jobId);

  const result = await executeLuaScript<number>(
    redis,
    "queue_ack",
    [processingKey, jobKey],
    [jobId, ownerToken],
  );

  return { acked: result === 1 };
}

/**
 * Negative-acknowledges a job after a processing failure.
 *
 * - If attempts < maxAttempts: requeues with exponential backoff delay.
 * - If attempts >= maxAttempts: moves to the dead-letter queue.
 * - Only the claim owner can nack.
 *
 * Backoff formula: baseDelayMs * 2^(attempts - 1), capped at 1 hour.
 */
export async function nack(
  redis: RedisClient,
  projectId: string,
  queueName: string,
  jobId: string,
  ownerToken: string,
  options?: NackOptions,
): Promise<{ result: "requeued" | "dead" | "not_found" }> {
  if (!projectId) throw new ValidationError("Missing projectId for nack");
  if (!queueName) throw new ValidationError("Missing queueName for nack");
  if (!jobId) throw new ValidationError("Missing jobId for nack");
  if (!ownerToken) throw new ValidationError("Missing ownerToken for nack");

  const baseDelayMs = options?.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const nowMs = Date.now();

  const jobKey = queueJobKey(projectId, jobId);
  const raw = await redis.hmget(jobKey, "attempts", "maxAttempts");
  const attempts = parseInt(raw[0] ?? "1", 10);
  const maxAttempts = parseInt(raw[1] ?? String(DEFAULT_MAX_ATTEMPTS), 10);

  // Exponential backoff: delay = base * 2^(attempts - 1), capped at 1 hour
  const backoffMs = Math.min(baseDelayMs * Math.pow(2, attempts - 1), MAX_RETRY_DELAY_MS);
  const retryAtMs = nowMs + backoffMs;
  const newAttempts = attempts; // nack does not increment; claim already did

  const processingKey = queueProcessingKey(projectId, queueName);
  const pendingKey = queuePendingKey(projectId, queueName);
  const dlqKey = queueDeadLetterKey(projectId, queueName);

  const outcome = await executeLuaScript<number>(
    redis,
    "queue_nack",
    [processingKey, pendingKey, dlqKey, jobKey],
    [jobId, ownerToken, retryAtMs, newAttempts, maxAttempts, nowMs],
  );

  if (outcome === 1) return { result: "requeued" };
  if (outcome === 2) return { result: "dead" };
  return { result: "not_found" };
}

/**
 * Reaps jobs whose processing lease has expired.
 *
 * Should be called periodically by a maintenance task or the worker loop.
 * Requeues jobs that still have remaining attempts and dead-letters exhausted jobs.
 *
 * Note: All queue keys share the same {projectId} cluster hash tag, so Lua can
 * safely iterate dynamic job keys within a single script.
 */
export async function reap(
  redis: RedisClient,
  projectId: string,
  queueName: string,
  options?: ReapOptions,
): Promise<ReapResult> {
  if (!projectId) throw new ValidationError("Missing projectId for reap");
  if (!queueName) throw new ValidationError("Missing queueName for reap");

  const batchSize = options?.batchSize ?? DEFAULT_BATCH_SIZE;
  const nowMs = Date.now();

  const processingKey = queueProcessingKey(projectId, queueName);
  const pendingKey = queuePendingKey(projectId, queueName);
  const dlqKey = queueDeadLetterKey(projectId, queueName);

  // The Lua script needs to construct job keys using the project-scoped prefix.
  // We pass queue:{projectId}:job as KEYS[4] — Lua appends :jobId per job.
  // This preserves Redis Cluster hash tag consistency since all keys share {projectId}.
  const jobKeyPrefix = `queue:{${projectId}}:job`;

  const [requeued, deadLettered] = await executeLuaScript<[number, number]>(
    redis,
    "queue_reap",
    [processingKey, pendingKey, dlqKey, jobKeyPrefix],
    [nowMs, batchSize],
  );

  return { requeued, deadLettered };
}

