import { fileURLToPath } from "node:url";
import { build } from "vite";
import { describe, expect, it } from "vitest";

describe("recovery Help bundle", () => {
  it("includes Help in the initial app script when the daemon becomes unavailable", async () => {
    const result = await build({
      configFile: fileURLToPath(new URL("../vite.config.ts", import.meta.url)),
      logLevel: "silent",
      build: { write: false },
    });
    const outputs = Array.isArray(result) ? result : [result];
    const entry = outputs
      .flatMap((output) => ("output" in output ? output.output : []))
      .find((chunk) => chunk.type === "chunk" && chunk.isEntry);
    expect(entry?.type).toBe("chunk");
    if (entry?.type !== "chunk") return;

    const bundledModules = Object.keys(entry.modules).map((path) => path.replaceAll("\\", "/"));
    expect(bundledModules.some((path) => path.endsWith("/src/ui/help/HelpPage.tsx"))).toBe(true);
  }, 60_000);
});
