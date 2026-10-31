import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Redis } from "ioredis";

// Directory where lua scripts reside relative to this module
const currentDir = path.dirname(fileURLToPath(import.meta.url));
const luaDir = path.resolve(currentDir, "lua");

// Cache loaded script contents in memory to avoid repeated disk reads
const scriptCache = new Map<string, string>();

// Regex to validate script names (only alphanumeric characters and underscores)
const SCRIPT_NAME_REGEX = /^[a-zA-Z0-9_-]+$/;

/**
 * Loads a Lua script from the package's lua directory.
 * Throws an error if the script name is invalid or file cannot be found.
 */
export function loadLuaScript(scriptName: string): string {
  if (!scriptName || !SCRIPT_NAME_REGEX.test(scriptName)) {
    throw new Error(`Invalid Lua script name: '${scriptName}'. Only alphanumeric, underscores, and dashes allowed.`);
  }

  const cached = scriptCache.get(scriptName);
  if (cached !== undefined) {
    return cached;
  }

  const fileName = scriptName.endsWith(".lua") ? scriptName : `${scriptName}.lua`;
  const filePath = path.join(luaDir, fileName);

  // Prevent path traversal
  if (!filePath.startsWith(luaDir)) {
    throw new Error(`Invalid Lua script path traversal detected: '${scriptName}'`);
  }

  if (!fs.existsSync(filePath)) {
    throw new Error(`Lua script not found: '${fileName}' at '${filePath}'`);
  }

  const content = fs.readFileSync(filePath, "utf-8");
  scriptCache.set(scriptName, content);
  return content;
}

export interface ExecuteScriptOptions {
  client: Redis;
  name: string;
  keys?: string[];
  args?: (string | number)[];
}

/**
 * Executes a Lua script using Redis EVAL.
 * Keys are passed to KEYS and args to ARGV.
 */
export async function executeLuaScript<T = unknown>(
  client: Redis,
  name: string,
  keys: string[] = [],
  args: (string | number)[] = [],
): Promise<T> {
  const script = loadLuaScript(name);
  const result = await client.eval(script, keys.length, ...keys, ...args);
  return result as T;
}

