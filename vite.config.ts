import { resolve } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  root: resolve(__dirname, "src/ui"),
  build: {
    outDir: resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
  },
});
