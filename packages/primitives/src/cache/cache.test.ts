/**
 * Cache Tests
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { get, set, del, getOrLoad } from "./index.js";
import { ValidationError } from "@astra/core/errors";

// ---------------------------------------------------------------------------
// Mock Redis
// ---------------------------------------------------------------------------

function makeMockRedis(store: Record<string, string> = {}) {
  const evalCalls: unknown[][] = [];

  const redis = {
    get: async (key: string) => store[key] ?? null,
    set: async (key: string, value: string, _px: string, _ttl: number) => {
      store[key] = value;
      return "OK";
    },
    del: async (key: string) => {
      const existed = key in store;
      delete store[key];
      return existed ? 1 : 0;
    },
    eval: async (script: string, keyCount: number, ...rest: unknown[]) => {
      evalCalls.push([script, keyCount, ...rest]);
      // Simulate cache_get_or_lock: check store first, then try to set lock
      const keys = rest.slice(0, keyCount) as string[];
      const argv = rest.slice(keyCount) as unknown[];
      const valueKey = keys[0]!;
      const lockKey = keys[1]!;
      const lockToken = argv[0] as string;
      const lockTtl = argv[1] as number;

      const existing = store[valueKey];
      if (existing !== undefined) {
        return [1, existing];
      }
      // Simulate atomic SET NX
      if (!store[lockKey]) {
        store[lockKey] = lockToken;
        setTimeout(() => delete store[lockKey], lockTtl); // auto-expire mock lock
        return [0, "LOCKED"];
      }
      return [0, "WAIT"];
    },
  };

  return { redis: redis as never, store, evalCalls };
}

// ---------------------------------------------------------------------------
// get – unit
// ---------------------------------------------------------------------------

describe("cache.get – unit", () => {
  it("returns hit=false for missing key", async () => {
    const { redis } = makeMockRedis();
    const result = await get(redis, "proj1", "user:1");
    assert.equal(result.hit, false);
  });

  it("returns hit=true with parsed value for existing key", async () => {
    const { redis } = makeMockRedis({
      "cache:{proj1}:entry:user:1": JSON.stringify({ name: "Alice" }),
    });
    const result = await get<{ name: string }>(redis, "proj1", "user:1");
    assert.equal(result.hit, true);
    assert.equal(result.value?.name, "Alice");
  });

  it("throws ValidationError for empty projectId", async () => {
    await assert.rejects(
      () => get({} as never, "", "key"),
      ValidationError,
    );
  });

  it("throws ValidationError for empty key", async () => {
    await assert.rejects(
      () => get({} as never, "proj1", ""),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// set – unit
// ---------------------------------------------------------------------------

describe("cache.set – unit", () => {
  it("stores value in mock store", async () => {
    const { redis, store } = makeMockRedis();
    await set(redis, "proj1", "user:1", { name: "Bob" }, { ttlMs: 60_000 });
    assert.ok("cache:{proj1}:entry:user:1" in store, "key should exist in store");
    const raw = store["cache:{proj1}:entry:user:1"];
    assert.equal(JSON.parse(raw ?? "null")?.name, "Bob");
  });

  it("throws ValidationError for zero ttlMs", async () => {
    await assert.rejects(
      () => set({} as never, "proj1", "key", {}, { ttlMs: 0 }),
      ValidationError,
    );
  });
});

// ---------------------------------------------------------------------------
// del – unit
// ---------------------------------------------------------------------------

describe("cache.del – unit", () => {
  it("removes the key from the store", async () => {
    const { redis, store } = makeMockRedis({
      "cache:{proj1}:entry:user:1": '"some-value"',
    });
    await del(redis, "proj1", "user:1");
    assert.ok(!("cache:{proj1}:entry:user:1" in store));
  });
});

// ---------------------------------------------------------------------------
// getOrLoad – unit
// ---------------------------------------------------------------------------

describe("cache.getOrLoad – unit", () => {
  it("calls loader when cache is empty and stores result", async () => {
    const { redis, store } = makeMockRedis();
    let loaderCalls = 0;

    const value = await getOrLoad<{ name: string }>(redis, "proj1", "user:1", {
      ttlMs: 60_000,
      loader: async () => {
        loaderCalls++;
        return { name: "Charlie" };
      },
    });

    assert.equal(value.name, "Charlie");
    assert.equal(loaderCalls, 1);
    // Value should now be in store
    assert.ok("cache:{proj1}:entry:user:1" in store);
  });

  it("returns cached value without calling loader", async () => {
    const { redis } = makeMockRedis({
      "cache:{proj1}:entry:user:1": JSON.stringify({ name: "Dana" }),
    });
    let loaderCalls = 0;

    const value = await getOrLoad<{ name: string }>(redis, "proj1", "user:1", {
      ttlMs: 60_000,
      loader: async () => {
        loaderCalls++;
        return { name: "Dana" };
      },
    });

    assert.equal(value.name, "Dana");
    assert.equal(loaderCalls, 0, "loader should not be called on cache hit");
  });

  it("throws ValidationError for zero ttlMs", async () => {
    await assert.rejects(
      () => getOrLoad({} as never, "proj1", "key", { ttlMs: 0, loader: async () => ({}) }),
      ValidationError,
    );
  });
});

