import type { RedisClient } from "@astra/redis/client";
import type { AdmitResult, PlanLimits, TenantContext } from "@astra/core/types";
import { ValidationError } from "@astra/core/errors";
import {
  governorRateKey,
  governorDailyQuotaKey,
  governorQueueBacklogKey,
} from "@astra/redis/keys";
import { executeLuaScript } from "@astra/redis/scripts";
import { governorDecisionsTotal } from "@astra/telemetry/metrics";

export interface AdmitOptions {
  /**
   * The operation or route name (e.g. "cache_get", "queue_enqueue", "lock_acquire").
   * Defaults to "default".
   */
  operation?: string;

  /**
   * Token and quota cost of the request. Defaults to 1.
   */
  cost?: number;

  /**
   * Target queue name if this operation enqueues a job into a queue.
   * When specified, backlog depth is evaluated against `plan.maxBacklog`.
   */
  queueName?: string;

  /**
   * Optional override for plan limits. Defaults to `tenant.limits`.
   */
  limits?: PlanLimits;
}

/**
 * Atomic Tenant Governor admission control.
 *
 * Executes `governor_admit.lua` in Redis:
 * 1. Checks and deducts from the per-operation token bucket (rate limiting).
 * 2. Checks and increments the daily operations quota counter.
 * 3. Evaluates queue backlog depth if a queue operation is requested.
 *
 * All checks are atomic. If any check fails, no tokens or quotas are consumed.
 */
export async function admitRequest(
  redis: RedisClient,
  tenant: TenantContext,
  options?: AdmitOptions,
): Promise<AdmitResult> {
  if (!tenant || !tenant.projectId) {
    throw new ValidationError("Missing tenant context or projectId for admission check");
  }

  const limits = options?.limits ?? tenant.limits;
  if (!limits) {
    throw new ValidationError("Missing plan limits in tenant context for admission check");
  }

  const operation = options?.operation ?? "default";
  const cost = options?.cost ?? 1;

  if (cost <= 0) {
    throw new ValidationError("Request cost must be a positive integer");
  }

  // Derive date string in UTC (YYYY-MM-DD) for daily quota key
  const now = new Date();
  const dateStr = now.toISOString().slice(0, 10);

  // Generate Redis keys with strict {projectId} cluster hash tags
  const rateKey = governorRateKey(tenant.projectId, operation);
  const quotaKey = governorDailyQuotaKey(tenant.projectId, dateStr);
  const backlogKey = options?.queueName
    ? governorQueueBacklogKey(tenant.projectId, options.queueName)
    : "";

  const keys = [rateKey, quotaKey, backlogKey];
  const args = [
    limits.rps, // capacity
    limits.rps, // refill rate
    cost,
    limits.opsPerDay,
    limits.maxBacklog,
    options?.queueName ? 1 : 0,
  ];

  // Execute the atomic Lua script in Redis
  const rawResult = await executeLuaScript<[number, number]>(
    redis,
    "governor_admit",
    keys,
    args,
  );

  if (!Array.isArray(rawResult) || rawResult.length < 2) {
    throw new Error(`Unexpected response from governor_admit Lua script: ${JSON.stringify(rawResult)}`);
  }

  const [statusCode, retryAfterMs] = rawResult;

  switch (statusCode) {
    case 0: {
      // Admitted
      governorDecisionsTotal.inc({ decision: "admit", reason: "none" });
      return { ok: true };
    }
    case 1: {
      // Denied by rate limit
      governorDecisionsTotal.inc({ decision: "deny", reason: "RATE" });
      return { ok: false, reason: "RATE", retryAfterMs };
    }
    case 2: {
      // Denied by daily quota
      governorDecisionsTotal.inc({ decision: "deny", reason: "QUOTA" });
      return { ok: false, reason: "QUOTA", retryAfterMs };
    }
    case 3: {
      // Denied by queue backlog
      governorDecisionsTotal.inc({ decision: "deny", reason: "BACKLOG" });
      return { ok: false, reason: "BACKLOG", retryAfterMs };
    }
    default:
      throw new Error(`Unknown status code ${statusCode} from governor_admit Lua script`);
  }
}
