import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["bootstrap/test/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
    // UI tests run under vitest.ui.config.ts/jsdom; keep the default node run focused on
    // non-UI tests even though the shared pattern recognizes both TypeScript extensions.
    exclude: ["test/ui/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
