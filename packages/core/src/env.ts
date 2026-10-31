import { z } from "zod";

/**
 * Validates process.env against the provided Zod schema.
 * Formats errors without exposing sensitive values.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.output<T> {
  const result = schema.safeParse(env);

  if (!result.success) {
    const errorMessages: string[] = [];

    for (const issue of result.error.issues) {
      const fieldPath = issue.path.length > 0 ? issue.path.join(".") : "root";
      errorMessages.push(`  - [${fieldPath}]: ${issue.message}`);
    }

    const message = `Environment validation failed:\n${errorMessages.join("\n")}`;
    console.error(message);
    throw new Error(message);
  }

  return result.data;
}
