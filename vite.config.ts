import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// "profiling" mode (npm run build:ui:profiling) swaps in React's profiling
// bundle so the PERF0 browser harness can read real commit durations; it
// builds to dist/ui-profiling and never touches the production dist/ui output.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  root: resolve(__dirname, "src/ui"),
  ...(mode === "profiling"
    ? { resolve: { alias: { "react-dom/client": "react-dom/profiling" } } }
    : {}),
  build: {
    outDir: resolve(__dirname, mode === "profiling" ? "dist/ui-profiling" : "dist/ui"),
    emptyOutDir: true,
  },
}));
