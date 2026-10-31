/**
 * Shared core types for Astra
 */

export type Environment = "development" | "production" | "test";

export type LogLevel = "fatal" | "error" | "warn" | "info" | "debug" | "trace";

/**
 * Plan tiers supported in Astra
 */
export type PlanTier = "free" | "pro" | "scale" | "custom";

/**
 * Resource limits configured on a plan
 */
export interface PlanLimits {
  weight: number;
  rps: number;
  maxConcurrency: number;
  maxBacklog: number;
  memBytes: number;
  opsPerDay: number;
}

/**
 * Common tenant context attached after authentication
 */
export interface TenantContext {
  orgId: string;
  projectId: string;
  planId: string;
  keyId: string;
  limits: PlanLimits;
}

/**
 * Standard request context carried across HTTP handlers and operations
 */
export interface RequestContext {
  requestId: string;
  tenant?: TenantContext;
}

/**
 * Admission decision returned by the Governor
 */
export type AdmitResult =
  | { ok: true }
  | { ok: false; reason: "RATE" | "QUOTA" | "BACKLOG"; retryAfterMs: number };

