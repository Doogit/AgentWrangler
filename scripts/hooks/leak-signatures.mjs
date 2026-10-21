// Structural signatures of agent scratch / raw-content dumps that leaked into the
// tree as tracked files (the SEC-101 root cause: commit 6998f78). Matched against
// the staged PATH only, so there are no false positives on real source. This file
// SHIPS with the hook (scripts/ is public), so it holds NO owner/project names —
// the FORBIDDEN identifier list stays inline in scripts/launch/export.mjs, which
// never ships.
//
// Root cause recap: a worker redirected stderr to a Windows absolute scratchpad
// path (C:\...) while running under Git-Bash, where that is an illegal filename,
// so the whole path became one flat 5001-line file in the repo root.
const PATH_SIGNATURES = [
  { re: /\uF03A/, why: "MSYS colon-encoding (U+F03A) — an escaped Windows drive path became a filename" },
  { re: /^[A-Za-z]:[\\/]/, why: "absolute drive-letter path used as a repo-relative filename" },
  { re: /(^|[\\/])scratchpad([\\/]|$)/i, why: "agent scratchpad path tracked in the tree" },
  { re: /AppData[\\/]+Local[\\/]+Temp/i, why: "OS temp path tracked in the tree" },
  { re: /(^|[\\/])std(err|out)\.txt$/i, why: "captured stderr/stdout dump" },
  {
    re: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}.*(scratchpad|std(err|out)|dump)/i,
    why: "session-id-named scratch dump",
  },
];

// Reasons a staged path looks like a leaked scratch file (empty array = clean).
export function structuralLeakReasons(relPath) {
  return PATH_SIGNATURES.filter((s) => s.re.test(relPath)).map((s) => s.why);
}
