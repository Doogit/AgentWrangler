/**
 * Per-job Claude Code settings generation for W3-A assisted apply.
 *
 * The settings file is a best-effort pre-edit boundary. Headless Claude can
 * silently ignore invalid settings, so callers must still run the post-apply
 * path audit before marking a job APPLIED.
 */

export type ApplySettingsMode = "dry-run" | "apply";

function globPath(fileRef: string): string {
  return fileRef.replace(/\\/g, "/");
}

export function generateJobSettings(fileRef: string, mode: ApplySettingsMode): string {
  const escaped = globPath(fileRef);
  const settings =
    mode === "apply"
      ? {
          permissions: {
            allow: [
              `Edit(${escaped})`,
              `Write(${escaped})`,
              "Read(**)",
              "Bash(git diff*)",
              "Bash(git status*)",
            ],
            deny: ["Edit(**)", "Write(**)", "Bash(**)", "WebFetch(**)", "WebSearch(**)"],
          },
        }
      : {
          permissions: {
            deny: ["Edit(**)", "Write(**)", "Bash(**)", "WebFetch(**)", "WebSearch(**)"],
          },
        };

  return JSON.stringify(settings, null, 2);
}

export function assertValidSettingsJson(raw: string): void {
  JSON.parse(raw);
}
