import {
  Registry,
  collectDefaultMetrics,
  Counter,
  Histogram,
  Gauge,
  type RegistryContentType,
} from "prom-client";

/**
 * Shared Prometheus Registry
 */
export const register = new Registry();

// Collect standard Node.js process and runtime metrics (memory, event loop, CPU, GC)
collectDefaultMetrics({ register, prefix: "astra_" });

/**
 * Helper to get or register a Counter without duplicate registration error
 */
function getOrCreateCounter<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [],
): Counter<T> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Counter<T>;
  }
  return new Counter({
    name,
    help,
    labelNames: labelNames as unknown as string[],
    registers: [register],
  });
}

/**
 * Helper to get or register a Histogram without duplicate registration error
 */
function getOrCreateHistogram<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [],
  buckets: number[] = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
): Histogram<T> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Histogram<T>;
  }
  return new Histogram({
    name,
    help,
    labelNames: labelNames as unknown as string[],
    buckets,
    registers: [register],
  });
}

/**
 * Helper to get or register a Gauge without duplicate registration error
 */
function getOrCreateGauge<T extends string>(
  name: string,
  help: string,
  labelNames: readonly T[] = [],
): Gauge<T> {
  const existing = register.getSingleMetric(name);
  if (existing) {
    return existing as Gauge<T>;
  }
  return new Gauge({
    name,
    help,
    labelNames: labelNames as unknown as string[],
    registers: [register],
  });
}

// 1. HTTP request count
export const httpRequestsTotal = getOrCreateCounter(
  "astra_http_requests_total",
  "Total number of HTTP requests processed",
  ["method", "route", "status"] as const,
);

// 2. HTTP request duration
export const httpRequestDurationSeconds = getOrCreateHistogram(
  "astra_http_request_duration_seconds",
  "HTTP request duration in seconds",
  ["method", "route", "status"] as const,
  [0.005, 0.01, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
);

// 3. Active HTTP requests
export const activeHttpRequests = getOrCreateGauge(
  "astra_http_active_requests",
  "Number of in-flight active HTTP requests",
  ["method"] as const,
);

// 4. Redis operation count and duration
export const redisOperationsTotal = getOrCreateCounter(
  "astra_redis_operations_total",
  "Total number of Redis operations or script executions",
  ["op", "status"] as const,
);

export const redisOperationDurationSeconds = getOrCreateHistogram(
  "astra_redis_operation_duration_seconds",
  "Duration of Redis operations in seconds",
  ["op", "status"] as const,
  [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
);

// 5. Queue jobs processed
export const queueJobsProcessedTotal = getOrCreateCounter(
  "astra_queue_jobs_processed_total",
  "Total number of queue jobs processed",
  ["queue", "status"] as const,
);

// 6. Queue job failures
export const queueJobFailuresTotal = getOrCreateCounter(
  "astra_queue_job_failures_total",
  "Total number of queue job execution failures",
  ["queue", "reason"] as const,
);

// 7. Governor admission decisions
export const governorDecisionsTotal = getOrCreateCounter(
  "astra_governor_decisions_total",
  "Total number of Tenant Governor admission checks",
  ["decision", "reason"] as const,
);

// 8. Cache outcomes
export const cacheHitsTotal = getOrCreateCounter(
  "astra_cache_hits_total",
  "Total number of cache lookups with their outcome",
  ["result"] as const,
  // label "result": "hit" | "miss"
);

// 9. Distributed lock acquisition outcomes
export const lockAcquisitionsTotal = getOrCreateCounter(
  "astra_lock_acquisitions_total",
  "Total number of distributed lock acquisition attempts",
  ["result"] as const,
  // label "result": "acquired" | "failed"
);

// 10. Rate limit decisions
export const rateLimitDecisionsTotal = getOrCreateCounter(
  "astra_ratelimit_decisions_total",
  "Total number of rate limiter token-take decisions",
  ["result"] as const,
  // label "result": "allowed" | "denied"
);

/**
 * Returns current metrics formatted in Prometheus text exposition format
 */
export async function getMetrics(): Promise<string> {
  return register.metrics();
}

/**
 * Returns the Prometheus Content-Type header
 */
export function getMetricsContentType(): RegistryContentType {
  return register.contentType;
}

