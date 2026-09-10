import { createHash } from "node:crypto";

const OPAQUE_DIGEST = /^[0-9a-f]{64}$/;

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex");
}

/** Canonical event-source identity. The raw path hash never crosses the observation boundary. */
export function effectEventSourceIdentity(workspaceId: string, filePathHash: string): string {
  return digest(["aw-effect-event-source-v1", workspaceId, filePathHash]);
}

/** Canonical tool identity with the frozen NFKC/trim/lowercase normalization. */
export function effectToolIdentity(toolName: string): string {
  const normalized = toolName.normalize("NFKC").trim().toLowerCase();
  if (normalized.length === 0) throw new Error("tool name must not be empty");
  return digest(["aw-effect-tool-v1", normalized]);
}

export function isOpaqueEffectIdentity(value: string): boolean {
  return OPAQUE_DIGEST.test(value);
}
