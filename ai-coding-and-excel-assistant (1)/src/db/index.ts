import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, type PoolConfig } from "pg";

/**
 * Database access that is safe for hosted deployments:
 * - Nothing connects (or throws) at import time, so `next build` works without DATABASE_URL.
 * - SSL is enabled automatically for remote databases (Neon, Supabase, Render, Railway, RDS…).
 * - The tables are created on first use, so a fresh database needs no manual migration step.
 */

const globalForDb = globalThis as typeof globalThis & {
  __appPgPool?: Pool;
  __appDb?: NodePgDatabase;
  __appSchemaReady?: Promise<void>;
};

function isLocalHost(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "db" || host === "postgres";
  } catch {
    return false;
  }
}

function buildConfig(): PoolConfig {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    throw new Error(
      "DATABASE_URL is not set. Add it to your hosting provider's environment variables (e.g. postgresql://user:password@host:5432/dbname).",
    );
  }

  const sslSetting = (process.env.DATABASE_SSL ?? "").toLowerCase();
  let ssl: PoolConfig["ssl"];
  if (sslSetting === "false" || sslSetting === "0" || sslSetting === "disable") {
    ssl = undefined;
  } else if (sslSetting === "true" || sslSetting === "1" || sslSetting === "require") {
    ssl = { rejectUnauthorized: false };
  } else if (/sslmode=(require|prefer|verify)/i.test(connectionString) || !isLocalHost(connectionString)) {
    ssl = { rejectUnauthorized: false };
  }

  return { connectionString, ssl, max: 5 };
}

export function getPool(): Pool {
  if (!globalForDb.__appPgPool) {
    globalForDb.__appPgPool = new Pool(buildConfig());
  }
  return globalForDb.__appPgPool;
}

/** Drizzle client. Created lazily on first access. */
export const db: NodePgDatabase = new Proxy({} as NodePgDatabase, {
  get(_target, prop, receiver) {
    if (!globalForDb.__appDb) globalForDb.__appDb = drizzle(getPool());
    const value = Reflect.get(globalForDb.__appDb, prop, receiver);
    return typeof value === "function" ? value.bind(globalForDb.__appDb) : value;
  },
});

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS "projects" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(120) NOT NULL,
  "prompt" text DEFAULT '' NOT NULL,
  "html" text DEFAULT '' NOT NULL,
  "css" text DEFAULT '' NOT NULL,
  "js" text DEFAULT '' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE IF NOT EXISTS "sheets" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" varchar(120) NOT NULL,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "row_count" integer DEFAULT 100 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
`;

/**
 * Makes sure the tables exist. Runs once per server process and is cheap afterwards.
 * Call this at the start of any request handler that touches the database.
 */
export function ensureSchema(): Promise<void> {
  if (!globalForDb.__appSchemaReady) {
    globalForDb.__appSchemaReady = getPool()
      .query(SCHEMA_SQL)
      .then(() => undefined)
      .catch((err: unknown) => {
        // Allow a retry on the next request instead of caching the failure forever.
        globalForDb.__appSchemaReady = undefined;
        throw err;
      });
  }
  return globalForDb.__appSchemaReady;
}
