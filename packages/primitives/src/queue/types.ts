/**
 * Types for Astra Queue
 *
 * Data structures in Redis:
 *   - Pending/ready/delayed jobs: Sorted Set at queue:{projectId}:pending:<queueName>
 *       Score = eligible runAt timestamp in ms (ready jobs have score <= now)
 *       Member = jobId
 *   - Processing (in-flight) jobs: Sorted Set at queue:{projectId}:processing:<queueName>
 *       Score = lease expiry timestamp in ms
 *       Member = jobId
 *   - Job data hash: queue:{projectId}:job:<jobId>
 *       Fields: payload, attempts, maxAttempts, createdAt, updatedAt, status
 *   - Idempotency: queue:{projectId}:idem:<idempotencyKey>  (string, jobId, TTL 24h)
 *   - Dead-letter: queue:{projectId}:dead-letter:<queueName>  (list, prepended)
 *
 * Delivery guarantee: AT-LEAST-ONCE.
 *   A job may be executed more than once. Workers must be idempotent.
 */

export interface EnqueueOptions {
  /** Delay before the job becomes eligible (ms from now). Defaults to 0. */
  delayMs?: number;

  /** Maximum number of delivery attempts. Defaults to 3. */
  maxAttempts?: number;

  /**
   * Optional idempotency key. If a job already exists for this key,
   * the existing jobId is returned and no duplicate is created.
   * Valid for 24 hours.
   */
  idempotencyKey?: string;
}

export interface EnqueueResult {
  jobId: string;
  /** true if a new job was created; false if idempotency key matched existing job */
  created: boolean;
}

export interface ClaimOptions {
  /** Lease duration in ms before job is considered abandoned. Defaults to 30,000 ms. */
  leaseTtlMs?: number;
}

export interface JobMetadata {
  jobId: string;
  payload: string;
  attempts: number;
  maxAttempts: number;
  createdAt: number;
}

export interface ClaimResult {
  claimed: boolean;
  job?: JobMetadata;
  /** Ownership token required for ack/nack */
  ownerToken?: string;
}

export interface NackOptions {
  /** Base retry delay in ms. Actual delay increases with exponential backoff. Defaults to 1000. */
  baseDelayMs?: number;
}

export interface ReapOptions {
  /** Maximum number of expired jobs to recover per reap call. Defaults to 50. */
  batchSize?: number;
}

export interface ReapResult {
  requeued: number;
  deadLettered: number;
}

