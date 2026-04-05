import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Look for test files in all packages
    include: [
      "common/__tests__/**/*.test.ts",
      "server/__tests__/**/*.test.ts",
      "client/__tests__/**/*.test.ts",
      "__tests__/**/*.test.ts",
    ],
  },
});
