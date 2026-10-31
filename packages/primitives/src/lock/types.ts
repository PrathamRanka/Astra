/**
 * Types for Astra Distributed Locks
 */

export interface LockAcquireOptions {
  /**
   * Lease time-to-live in milliseconds. Defaults to 10,000 ms (10 seconds).
   */
  ttlMs?: number;

  /**
   * Optional custom ownership token. If not provided, a secure UUID is generated.
   */
  ownerToken?: string;
}

export interface LockAcquireResult {
  /**
   * Whether the lock lease was successfully acquired.
   */
  acquired: boolean;

  /**
   * Ownership token needed to renew or release the lock.
   */
  ownerToken: string;

  /**
   * Monotonically increasing fencing token (integer).
   *
   * IMPORTANT DISTRIBUTED SYSTEMS LIMITATION:
   * A fencing token protects external state only if the external storage/service
   * checks and rejects writes with stale (lower) fencing tokens. Redis lock ownership
   * alone cannot prevent a paused or network-partitioned client from executing a delayed
   * write after its TTL has expired.
   */
  fencingToken: number;

  /**
   * Lease duration in milliseconds.
   */
  ttlMs: number;
}

export interface LockRenewResult {
  renewed: boolean;
}

export interface LockReleaseResult {
  released: boolean;
}

