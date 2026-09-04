import { createHash } from "node:crypto";
import * as fs from "node:fs";

function serializeCanonical(value: unknown, seen: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonical_non_finite_number");
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error("canonical_unsupported_value");
  if (seen.has(value)) throw new Error("canonical_cycle");

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => serializeCanonical(item, seen)).join(",")}]`;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("canonical_non_plain_object");
    }
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${serializeCanonical(record[key], seen)}`)
      .join(",")}}`;
  } finally {
    seen.delete(value);
  }
}

/** Deterministic JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value: unknown): string {
  return serializeCanonical(value, new Set());
}

export function sha256Bytes(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Canonical(value: unknown): string {
  return sha256Bytes(canonicalJson(value));
}

/** Stream a file into SHA-256 so database size is not duplicated in memory. */
export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  await new Promise<void>((resolve, reject) => {
    const input = fs.createReadStream(filePath);
    input.on("data", (chunk) => hash.update(chunk));
    input.once("error", reject);
    input.once("end", resolve);
  });
  return hash.digest("hex");
}
