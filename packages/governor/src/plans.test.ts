import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PLAN_LIMITS,
  getPlanLimits,
  validatePlanLimits,
  planLimitsSchema,
} from "./plans.js";

describe("Governor Plans Configuration", () => {
  it("provides limits for all documented plan tiers", () => {
    assert.deepEqual(getPlanLimits("free"), PLAN_LIMITS.free);
    assert.deepEqual(getPlanLimits("pro"), PLAN_LIMITS.pro);
    assert.deepEqual(getPlanLimits("scale"), PLAN_LIMITS.scale);
  });

  it("handles tier names case-insensitively", () => {
    assert.deepEqual(getPlanLimits("FREE"), PLAN_LIMITS.free);
    assert.deepEqual(getPlanLimits("Pro"), PLAN_LIMITS.pro);
    assert.deepEqual(getPlanLimits("SCALE"), PLAN_LIMITS.scale);
  });

  it("throws an error for unknown plan tiers", () => {
    assert.throws(() => getPlanLimits("enterprise"), {
      message: /Unknown plan tier: 'enterprise'/,
    });
    assert.throws(() => getPlanLimits("unknown_plan"), {
      message: /Unknown plan tier: 'unknown_plan'/,
    });
  });

  it("validates valid plan limits with schema", () => {
    const valid = {
      weight: 1,
      rps: 10,
      maxConcurrency: 2,
      maxBacklog: 100,
      memBytes: 10485760,
      opsPerDay: 10000,
    };
    const parsed = validatePlanLimits(valid);
    assert.deepEqual(parsed, valid);
  });

  it("rejects non-positive and invalid plan limit values", () => {
    // Zero or negative RPS
    assert.throws(() => planLimitsSchema.parse({
      weight: 1,
      rps: 0,
      maxConcurrency: 2,
      maxBacklog: 100,
      memBytes: 1000,
      opsPerDay: 1000,
    }));

    // Missing field
    assert.throws(() => planLimitsSchema.parse({
      weight: 1,
      rps: 10,
    }));

    // Non-integer
    assert.throws(() => planLimitsSchema.parse({
      weight: 1.5,
      rps: 10,
      maxConcurrency: 2,
      maxBacklog: 100,
      memBytes: 1000,
      opsPerDay: 1000,
    }));
  });
});

