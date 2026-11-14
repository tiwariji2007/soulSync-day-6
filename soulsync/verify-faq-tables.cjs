/* eslint @typescript-eslint/no-require-imports: off */
require("dotenv").config({ path: ".env.local" });
const { Pool } = require("pg");

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const result = await pool.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_name IN ('faq_documents', 'faq_usage_logs')
      ORDER BY table_name
    `);

    console.log("FAQ tables:", result.rows);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);

