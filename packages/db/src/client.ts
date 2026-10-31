import pg from "pg";

const { Pool } = pg;

export interface DbPoolOptions {
  max?: number;
  idleTimeoutMillis?: number;
  connectionTimeoutMillis?: number;
}

/**
 * Creates a PostgreSQL connection pool configured for Astra.
 * Configures sensible defaults: max 20 connections, 30s idle timeout, 5s connection timeout.
 */
export function createDbPool(connectionString: string, options?: DbPoolOptions): pg.Pool {
  const pool = new Pool({
    connectionString,
    max: options?.max ?? 20,
    idleTimeoutMillis: options?.idleTimeoutMillis ?? 30_000,
    connectionTimeoutMillis: options?.connectionTimeoutMillis ?? 5_000,
  });

  // Attach pool error listener to handle idle client errors without crashing unhandled
  pool.on("error", (err) => {
    console.error("Unexpected error on idle PostgreSQL client:", err);
  });

  return pool;
}

/**
 * Verifies the database connection by executing `SELECT 1`.
 */
export async function verifyDbConnection(pool: pg.Pool): Promise<void> {
  const client = await pool.connect();
  try {
    const result = await client.query("SELECT 1 AS alive");
    if (!result.rows || result.rows.length === 0 || result.rows[0].alive !== 1) {
      throw new Error("PostgreSQL connection verification query returned unexpected result");
    }
  } finally {
    client.release();
  }
}

/**
 * Closes the PostgreSQL connection pool gracefully.
 */
export async function closeDbPool(pool: pg.Pool): Promise<void> {
  await pool.end();
}

