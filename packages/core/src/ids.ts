import { randomUUID } from "node:crypto";

/**
 * Generates a unique identifier.
 * Uses cryptographically secure randomUUID().
 * If a prefix is provided, returns `<prefix>_<cleanUUID>`.
 * Otherwise returns standard RFC 4122 UUID v4.
 *
 * Example:
 * generateId() -> "550e8400-e29b-41d4-a716-446655440000"
 * generateId("proj") -> "proj_550e8400e29b41d4a716446655440000"
 */
export function generateId(prefix?: string): string {
  const uuid = randomUUID();
  if (!prefix) {
    return uuid;
  }
  const clean = uuid.replace(/-/g, "");
  return `${prefix}_${clean}`;
}

