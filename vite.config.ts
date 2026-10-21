import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// V8 explicit compile hint: compile every function in the recharts chunk eagerly, off the main
// thread, while it streams in. Without it the first chart mount in a tab compiled recharts lazily
// inside the click's task (M17). Prepended in generateBundle, after minification.
const compileHint = {
  name: "recharts-compile-hint",
  generateBundle(
    _: unknown,
    bundle: Record<string, { type: string; name?: string; code?: string }>,
  ) {
    for (const chunk of Object.values(bundle)) {
      if (chunk.type === "chunk" && chunk.name === "recharts") {
        chunk.code = `//# allFunctionsCalledOnLoad\n${chunk.code}`;
      }
    }
  },
};

// "profiling" mode (npm run build:ui:profiling) swaps in React's profiling
// bundle so the PERF0 browser harness can read real commit durations; it
// builds to dist/ui-profiling and never touches the production dist/ui output.
export default defineConfig(({ mode }) => ({
  plugins: [react(), compileHint],
  root: resolve(__dirname, "src/ui"),
  ...(mode === "profiling"
    ? { resolve: { alias: { "react-dom/client": "react-dom/profiling" } } }
    : {}),
  build: {
    outDir: resolve(__dirname, mode === "profiling" ? "dist/ui-profiling" : "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks: {
          recharts: ["recharts"],
        },
      },
    },
  },
}));
