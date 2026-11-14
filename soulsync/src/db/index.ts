import "server-only";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";

const databaseUrl = process.env.DATABASE_URL;

// `next build` imports route modules to collect configuration but never runs
// queries, so a missing DATABASE_URL is only fatal at runtime.
if (!databaseUrl && process.env.NEXT_PHASE !== "phase-production-build") {
  throw new Error("DATABASE_URL is missing");
}

// pg connects lazily on the first query, so no connection is made at import.
const pool = new Pool({
  connectionString: databaseUrl,
});

export const db = drizzle({ client: pool });
