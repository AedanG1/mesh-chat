import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Split tests into three named projects, each with its own environment.
    //
    // WHY DIFFERENT ENVIRONMENTS MATTER:
    //   "node" (default): Node has Buffer, crypto, require(), etc. Tests that
    //     accidentally use Node-only APIs will pass here but break in a browser.
    //   "jsdom": simulates a browser. No Buffer, no require(). Any code that
    //     calls Buffer will throw, just like it would for a real user.
    //
    //   common → jsdom: common is shared with the browser client, so it must
    //     never use Node-only APIs. Running in jsdom is what catches the
    //     "Buffer is not defined" class of bug before it reaches production.
    //   client → jsdom: client code runs in the browser; tests must match.
    //   server → node:  server code is Node-only; jsdom would break native
    //     addons (argon2, better-sqlite3) and file system access.
    projects: [
      {
        test: {
          name: "common",
          include: ["common/__tests__/**/*.test.ts"],
          environment: "jsdom",
        },
      },
      {
        test: {
          name: "server",
          include: [
            "server/__tests__/**/*.test.ts",
            "__tests__/**/*.test.ts",
          ],
          environment: "node",
        },
      },
      {
        test: {
          name: "client",
          include: ["client/__tests__/**/*.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
