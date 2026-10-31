import { Redis, type RedisOptions } from "ioredis";

export interface RedisClientOptions {
  connectTimeout?: number;
  maxRetriesPerRequest?: number;
  retryStrategy?: (times: number) => number | void | null;
}

/**
 * Creates an ioredis client configured for Astra.
 * Uses lazyConnect so the application controls when connection occurs.
 */
export function createRedisClient(url: string, options?: RedisClientOptions): Redis {
  const config: RedisOptions = {
    lazyConnect: true,
    connectTimeout: options?.connectTimeout ?? 10_000,
    maxRetriesPerRequest: options?.maxRetriesPerRequest ?? 3,
    retryStrategy:
      options?.retryStrategy ??
      ((times: number) => {
        // Backoff with max 2 seconds delay
        return Math.min(times * 200, 2_000);
      }),
  };

  return new Redis(url, config);
}

/**
 * Connects to Redis and verifies connection with PING.
 */
export async function connectRedis(client: Redis): Promise<void> {
  if (client.status === "wait") {
    await client.connect();
  }
  const pong = await client.ping();
  if (pong !== "PONG") {
    throw new Error(`Redis ping failed with response: ${pong}`);
  }
}

/**
 * Closes the Redis connection gracefully.
 */
export async function closeRedis(client: Redis): Promise<void> {
  if (client.status === "ready" || client.status === "connecting" || client.status === "connect") {
    await client.quit();
  } else {
    client.disconnect();
  }
}
