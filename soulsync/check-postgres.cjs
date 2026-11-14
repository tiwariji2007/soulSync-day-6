/* eslint @typescript-eslint/no-require-imports: off */
const dotenv = require("dotenv");
const { Pool } = require("pg");

dotenv.config({ path: ".env.local" });

async function main() {
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
  });

  try {
    const result = await pool.query("SELECT version()");
    console.log(result.rows[0].version);
  } catch (error) {
    console.error(error.message);
  } finally {
    await pool.end();
  }
}

main();

