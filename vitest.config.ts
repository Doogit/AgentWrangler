import { defineConfig } from "vitest/config";

// The loop-lag test builds a heavy fixture and starves timing-sensitive tests (wal-checkpointer's
// 25 ms step budget) that run in parallel. It is its own project in a later group, so it runs
// alone: projects with different sequence.groupOrder never overlap.
const LOOP_LAG = "test/daemon/scan-offload-loop-lag.test.ts";

export default defineConfig({
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "default",
          include: ["bootstrap/test/**/*.test.{ts,tsx}", "test/**/*.test.{ts,tsx}"],
          // UI tests run under vitest.ui.config.ts/jsdom; keep the default node run focused on
          // non-UI tests even though the shared pattern recognizes both TypeScript extensions.
          exclude: ["test/ui/**/*.test.{ts,tsx}", LOOP_LAG],
          environment: "node",
          sequence: { groupOrder: 1 },
        },
      },
      {
        extends: true,
        test: {
          name: "serial-heavy",
          include: [LOOP_LAG],
          environment: "node",
          sequence: { groupOrder: 2 },
        },
      },
    ],
  },
});
