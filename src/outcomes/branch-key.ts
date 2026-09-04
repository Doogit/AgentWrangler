import { createHash } from "node:crypto";

const NORMALIZATION_VERSION = "branch-v1";
const LOCAL_HEAD_PREFIX = "refs/heads/";
const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/i;
const FORBIDDEN_CHARACTERS = /[\\~^:?*\[]/u;
const WHITESPACE_OR_CONTROL = /[\s\p{Cc}]/u;

function isDetachedHeadMarker(ref: string): boolean {
  const lower = ref.toLowerCase();
  return (
    lower === "detached" ||
    lower === "detached head" ||
    lower === "(detached)" ||
    lower === "(no branch)" ||
    lower.startsWith("(head detached ") ||
    lower.startsWith("head detached ")
  );
}

/**
 * Convert a valid Git branch ref directly to its privacy-safe equality key.
 *
 * The normalized ref never leaves this function. Invalid or absent values
 * abstain with null rather than producing a key.
 */
export function fingerprintBranchRef(value: unknown): string | null {
  if (typeof value !== "string") return null;

  const byteLength = Buffer.byteLength(value, "utf8");
  if (byteLength < 1 || byteLength > 255) return null;
  if (value.trim() !== value || WHITESPACE_OR_CONTROL.test(value)) return null;

  const ref = value.startsWith(LOCAL_HEAD_PREFIX) ? value.slice(LOCAL_HEAD_PREFIX.length) : value;
  if (ref.length === 0) return null;
  if (ref === "HEAD" || ref === "@" || FULL_COMMIT_SHA.test(ref) || isDetachedHeadMarker(ref)) {
    return null;
  }
  if (ref.includes("..") || ref.includes("@{") || FORBIDDEN_CHARACTERS.test(ref)) return null;

  const components = ref.split("/");
  if (
    components.some(
      (component) =>
        component.length === 0 ||
        component.startsWith(".") ||
        component.endsWith(".") ||
        component.endsWith(".lock"),
    )
  ) {
    return null;
  }

  return createHash("sha256")
    .update(`${NORMALIZATION_VERSION}\0`, "utf8")
    .update(ref, "utf8")
    .digest("hex");
}
