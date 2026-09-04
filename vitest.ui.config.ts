import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  root: __dirname,
  plugins: [react()],
  test: {
    include: ["test/ui/**/*.test.{ts,tsx}"],
    environment: "jsdom",
  },
});
