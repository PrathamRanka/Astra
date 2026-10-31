/**
 * Redis Key Generation for Astra
 *
 * Pattern: <prefix>:{<projectId>}:<resource>[:<identifier>]
 * Project IDs are wrapped in curly braces {...} to serve as Redis Cluster hash tags,
 * ensuring all keys for a tenant map to the exact same hash slot.
 */

export interface BuildKeyOptions {
  prefix: string;
  projectId: string;
  resource: string;
  identifier?: string;
}

/**
 * Validates key component strings to ensure keys are well-formed.
 */
function validatePart(name: string, value: string): void {
  if (!value || typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Invalid Redis key part for '${name}': value must be a non-empty string`);
  }
  if (value.includes(":") || value.includes("{") || value.includes("}")) {
    throw new Error(
      `Invalid Redis key part for '${name}': '${value}' must not contain colons or braces`,
    );
  }
}

/**
 * Builds a formatted Redis key with cluster hash tagging on projectId.
 * Result: `<prefix>:{<projectId>}:<resource>` or `<prefix>:{<projectId>}:<resource>:<identifier>`
 */
export function buildKey(options: BuildKeyOptions): string {
  const { prefix, projectId, resource, identifier } = options;

  validatePart("prefix", prefix);
  validatePart("projectId", projectId);
  validatePart("resource", resource);

  if (identifier !== undefined) {
    validatePart("identifier", identifier);
    return `${prefix}:{${projectId}}:${resource}:${identifier}`;
  }

  return `${prefix}:{${projectId}}:${resource}`;
}

/**
 * Cache key: `cache:{<projectId>}:entry:<key>`
 */
export function cacheKey(projectId: string, key: string): string {
  return buildKey({
    prefix: "cache",
    projectId,
    resource: "entry",
    identifier: key,
  });
}

/**
 * Queue pending (ready) key: `queue:{<projectId>}:pending:<queueName>`
 */
export function queuePendingKey(projectId: string, queueName: string): string {
  return buildKey({
    prefix: "queue",
    projectId,
    resource: "pending",
    identifier: queueName,
  });
}

/**
 * Queue processing (in-flight) key: `queue:{<projectId>}:processing:<queueName>`
 */
export function queueProcessingKey(projectId: string, queueName: string): string {
  return buildKey({
    prefix: "queue",
    projectId,
    resource: "processing",
    identifier: queueName,
  });
}

/**
 * Queue completed key: `queue:{<projectId>}:completed:<queueName>`
 */
export function queueCompletedKey(projectId: string, queueName: string): string {
  return buildKey({
    prefix: "queue",
    projectId,
    resource: "completed",
    identifier: queueName,
  });
}

/**
 * Queue dead-letter (dlq) key: `queue:{<projectId>}:dead-letter:<queueName>`
 */
export function queueDeadLetterKey(projectId: string, queueName: string): string {
  return buildKey({
    prefix: "queue",
    projectId,
    resource: "dead-letter",
    identifier: queueName,
  });
}

/**
 * Distributed lock key: `lock:{<projectId>}:resource:<lockName>`
 */
export function lockKey(projectId: string, lockName: string): string {
  return buildKey({
    prefix: "lock",
    projectId,
    resource: "resource",
    identifier: lockName,
  });
}

/**
 * Rate limit key: `ratelimit:{<projectId>}:bucket:<name>`
 */
export function rateLimitKey(projectId: string, name: string): string {
  return buildKey({
    prefix: "ratelimit",
    projectId,
    resource: "bucket",
    identifier: name,
  });
}

/**
 * Tenant governor key: `governor:{<projectId>}:state` or `governor:{<projectId>}:state:<metric>`
 */
export function tenantGovernorKey(projectId: string, metric?: string): string {
  return buildKey({
    prefix: "governor",
    projectId,
    resource: "state",
    identifier: metric,
  });
}

