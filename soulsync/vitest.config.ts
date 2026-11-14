import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname),
      // "server-only" throws outside a React Server environment.
      "server-only": path.resolve(__dirname, "tests/stubs/server-only.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: {
      // Never a real database: the pool is created lazily and tests only
      // build SQL with .toSQL(), they never execute queries.
      DATABASE_URL: "postgres://test:test@127.0.0.1:1/vitest_never_connects",
      BETTER_AUTH_SECRET: "test-only-secret-not-used-in-production-000000",
    },
  },
});
