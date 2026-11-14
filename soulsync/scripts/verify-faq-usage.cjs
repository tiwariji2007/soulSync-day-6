/* eslint @typescript-eslint/no-require-imports: off */
require("dotenv").config({ path: ".env.local" });

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

async function main() {
  const result = await pool.query(`
    SELECT
      status,
      COUNT(*)::int AS requests,
      SUM(total_tokens)::int AS total_tokens,
      ROUND(AVG(latency_ms))::int AS average_latency_ms
    FROM faq_usage_logs
    GROUP BY status
    ORDER BY status;
  `);

  console.table(result.rows);

  const documents = await pool.query(
    "SELECT COUNT(*)::int AS total FROM faq_documents"
  );

  console.log("FAQ documents:", documents.rows[0].total);
}

main()
  .catch(console.error)
  .finally(() => pool.end());