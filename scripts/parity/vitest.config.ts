import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["scripts/parity/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
