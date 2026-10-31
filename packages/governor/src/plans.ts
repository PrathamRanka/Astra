import { z } from "zod";
import type { PlanLimits, PlanTier } from "@astra/core/types";

/**
 * Zod schema for validating PlanLimits.
 * Enforces positive numeric constraints for limits loaded from DB JSONB or configuration.
 */
export const planLimitsSchema = z.object({
  weight: z.number().int().positive(),
  rps: z.number().int().positive(),
  maxConcurrency: z.number().int().positive(),
  maxBacklog: z.number().int().positive(),
  memBytes: z.number().int().positive(),
  opsPerDay: z.number().int().positive(),
});

/**
 * Standard Plan Tier definitions and limits.
 *
 * Tier definitions according to docs/architecture.md and docs/prd.md:
 * - Free: weight 1, rps 10, maxConcurrency 2, maxBacklog 100, memBytes 10MB, opsPerDay 10_000
 * - Pro: weight 4, rps 100, maxConcurrency 10, maxBacklog 1_000, memBytes 100MB, opsPerDay 500_000
 * - Scale: weight 10, rps 500, maxConcurrency 50, maxBacklog 10_000, memBytes 500MB, opsPerDay 5_000_000
 *
 * Note on Concurrency and Memory:
 * `maxConcurrency` and `memBytes` are configured here as part of PlanLimits, but their
 * enforcement is tied to worker queue claiming (Phase 6) and cache storage quotas (Phase 7).
 * They are not evaluated during atomic HTTP request admission.
 */
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  free: {
    weight: 1,
    rps: 10,
    maxConcurrency: 2,
    maxBacklog: 100,
    memBytes: 10 * 1024 * 1024, // 10MB
    opsPerDay: 10_000,
  },
  pro: {
    weight: 4,
    rps: 100,
    maxConcurrency: 10,
    maxBacklog: 1_000,
    memBytes: 100 * 1024 * 1024, // 100MB
    opsPerDay: 500_000,
  },
  scale: {
    weight: 10,
    rps: 500,
    maxConcurrency: 50,
    maxBacklog: 10_000,
    memBytes: 500 * 1024 * 1024, // 500MB
    opsPerDay: 5_000_000,
  },
  custom: {
    weight: 1,
    rps: 50,
    maxConcurrency: 5,
    maxBacklog: 500,
    memBytes: 50 * 1024 * 1024,
    opsPerDay: 100_000,
  },
};

/**
 * Retrieves default plan limits for a given tier name.
 * Throws an error if the tier is unknown.
 */
export function getPlanLimits(tier: string): PlanLimits {
  const normalized = tier.toLowerCase() as PlanTier;
  const limits = PLAN_LIMITS[normalized];
  if (!limits) {
    throw new Error(`Unknown plan tier: '${tier}'. Valid tiers: ${Object.keys(PLAN_LIMITS).join(", ")}`);
  }
  return limits;
}

/**
 * Validates untrusted plan limit input (e.g. parsed from database JSONB).
 */
export function validatePlanLimits(data: unknown): PlanLimits {
  return planLimitsSchema.parse(data);
}

