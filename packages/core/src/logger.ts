import pino from "pino";
import type { LogLevel } from "./types.js";

const DEFAULT_LOG_LEVEL: LogLevel =
  (process.env.LOG_LEVEL as LogLevel | undefined) ??
  (process.env.NODE_ENV === "test" ? "error" : "info");

/**
 * Common redaction paths to prevent leaking credentials or sensitive tokens in logs.
 */
const REDACT_PATHS = [
  "password",
  "secret",
  "token",
  "apiKey",
  "key",
  "authorization",
  "headers.authorization",
  "headers['authorization']",
  "connectionString",
  "databaseUrl",
  "redisUrl",
];

export interface CreateLoggerOptions {
  name?: string;
  level?: LogLevel;
  bindings?: Record<string, unknown>;
}

/**
 * Creates a structured Pino logger configured for Astra.
 * Outputs JSON format with automatic timestamping and redaction of sensitive paths.
 */
export function createLogger(options?: CreateLoggerOptions): pino.Logger {
  const level = options?.level ?? DEFAULT_LOG_LEVEL;

  const baseLogger = pino({
    name: options?.name ?? "astra",
    level,
    redact: {
      paths: REDACT_PATHS,
      censor: "[REDACTED]",
    },
    formatters: {
      level: (label) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
  });

  return options?.bindings ? baseLogger.child(options.bindings) : baseLogger;
}

/**
 * Shared root logger instance
 */
export const logger = createLogger();

export type Logger = pino.Logger;

