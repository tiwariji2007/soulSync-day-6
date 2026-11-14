/* eslint @typescript-eslint/no-require-imports: off */
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: ".env.local" });

if (!process.env.DATABASE_URL) {
  dotenv.config({ path: ".env" });
}

async function check() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const result = await pool.query(`
      SELECT
        name,
        default_version,
        installed_version
      FROM pg_available_extensions
      WHERE name = 'vector'
    `);

    console.log("pgvector availability:", result.rows);

    const installed = await pool.query(`
      SELECT extname, extversion
      FROM pg_extension
      WHERE extname = 'vector'
    `);

    console.log("Installed pgvector:", installed.rows);
  } catch (error) {
    console.error("Database check failed:", error.message);
  } finally {
    await pool.end();
  }
}

check();

