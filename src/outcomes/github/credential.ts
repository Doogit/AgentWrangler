/**
 * src/outcomes/github/credential.ts — GitHub token reader.
 *
 * Reads "AgentWrangler-GithubToken" from Windows Credential Manager via a
 * PowerShell P/Invoke call. Never logs the token. Never throws.
 *
 * Pattern mirrors src/oauth/usage.ts: typed {ok:true,data}|{ok:false,reason}.
 *
 * Clean degradation (HARD constraint from plan §4):
 *   - AW_GITHUB_TOKEN environment variable → {ok:true,data:trimmed token}
 *   - Token absent / empty blob → {ok:false,reason:'github-token-not-found'}
 *   - PowerShell unavailable → {ok:false,reason:'powershell-unavailable'}
 *   - Non-Windows → {ok:false,reason:'non-windows-platform'}
 *   - Any exception → {ok:false,reason:message}
 *   NEVER throws; NEVER crashes the daemon.
 */

import { execFile } from "node:child_process";
import * as os from "node:os";

const CREDENTIAL_TARGET = "AgentWrangler-GithubToken";

// execFile's own timeout. Bumped from 10s: a cold `Add-Type` C# compile
// (csc.exe) under the CPU/IO load right after a full-corpus back-scan can
// legitimately exceed 10s. Node tries to kill the child at this bound.
const EXECFILE_TIMEOUT_MS = 15_000;

// Absolute settle bound. MUST exceed EXECFILE_TIMEOUT_MS so execFile's own
// kill gets first chance; this is the backstop for the Windows failure mode
// where execFile's timeout kill does NOT reap the grandchild (csc.exe) that
// inherited the stdout pipe — the pipe stays open, the execFile callback
// never fires, and without this guard the Promise (and outcomesRunning) would
// hang forever. See runPowerShell.
const HARD_TIMEOUT_MS = 20_000;

export type TokenResult = { ok: true; data: string } | { ok: false; reason: string };

/**
 * Non-secret status of the GitHub token, for the Settings UI. NEVER includes
 * the token value — only whether one is available and where it came from, so
 * the outcomes feature never degrades to a silent dark state (plan §OS3).
 */
export interface GithubTokenStatus {
  configured: boolean;
  source: "env" | "credential-manager" | null;
  /** Human-readable reason + remedy; present only when not configured. */
  reason?: string;
}

/**
 * Injectable reader type for tests and stubs.
 */
export type TokenReader = () => Promise<TokenResult>;

/**
 * PowerShell script that reads the credential blob via advapi32.
 * Outputs only the token on stdout (or nothing on failure).
 * Avoids cmdkey (can't reveal blobs); uses CredRead P/Invoke instead.
 */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class CredMgr {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags;
    public int Type;
    public string TargetName;
    public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize;
    public IntPtr CredentialBlob;
    public int Persist;
    public int AttributeCount;
    public IntPtr Attributes;
    public string TargetAlias;
    public string UserName;
  }
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true)]
  public static extern void CredFree([In] IntPtr buffer);
}
"@
$ptr = [IntPtr]::Zero
if ([CredMgr]::CredRead("${CREDENTIAL_TARGET}", 1, 0, [ref]$ptr)) {
  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][CredMgr+CREDENTIAL])
  if ($cred.CredentialBlobSize -gt 0) {
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    [CredMgr]::CredFree($ptr)
    $tok = [System.Text.Encoding]::Unicode.GetString($bytes).Trim()
    if ($tok.Length -gt 0) { Write-Output $tok }
  } else {
    [CredMgr]::CredFree($ptr)
  }
}
`.trim();

/**
 * Raw exec of a PowerShell script. Injectable so the hard-timeout wrapper can
 * be tested against a never-settling command without spawning a process.
 */
export type RawExec = (script: string) => Promise<string>;

function defaultRawExec(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { timeout: EXECFILE_TIMEOUT_MS, killSignal: "SIGKILL", windowsHide: true },
      (err, stdout, stderr) => {
        if (err) {
          reject(new Error(`powershell exit ${err.code}: ${stderr || err.message}`));
          return;
        }
        resolve(stdout.trim());
      },
    );
    child.on("error", (e) => reject(e));
  });
}

/**
 * Run a PowerShell script and ALWAYS settle within HARD_TIMEOUT_MS.
 *
 * `execFile`'s own timeout is not a reliable settle guarantee on Windows: if
 * the timeout kill fails to reap a grandchild (e.g. csc.exe spawned by
 * Add-Type) that still holds the inherited stdout pipe, the callback never
 * fires and the underlying Promise hangs forever — which would stick the
 * caller's `outcomesRunning` flag `true` and silently kill all future polls.
 * This wrapper races the raw exec against a hard timer that rejects, so the
 * returned Promise cannot hang regardless of the child's fate.
 *
 * `raw` is injectable for tests.
 */
export function runPowerShell(script: string, raw: RawExec = defaultRawExec): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(`powershell hard-timeout after ${HARD_TIMEOUT_MS}ms`));
    }, HARD_TIMEOUT_MS);
    raw(script).then(
      (out) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(out);
      },
      (err: unknown) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      },
    );
  });
}

// Successful token, cached for the daemon's lifetime. The first read runs at
// boot when the event loop is free (the caller defers it until after the
// synchronous back-scan); every later 10-min poll then reuses this value
// instead of re-spawning powershell.exe + recompiling Add-Type under load —
// which is precisely the condition that can make the read slow/hang. Only
// successful reads are cached, so a not-yet-configured token is still picked
// up on a later poll. (A token rotated while the daemon runs needs a restart.)
let cachedToken: string | null = null;

/**
 * Read the GitHub PAT from Windows Credential Manager.
 * Returns {ok:true,data:token} or {ok:false,reason} — never throws.
 */
export async function readGithubToken(reader?: TokenReader): Promise<TokenResult> {
  if (reader !== undefined) return reader();

  const envToken = process.env.AW_GITHUB_TOKEN;
  if (typeof envToken === "string") {
    const token = envToken.trim();
    if (token.length > 0) {
      return { ok: true, data: token };
    }
  }

  if (cachedToken !== null) {
    return { ok: true, data: cachedToken };
  }

  if (os.platform() !== "win32") {
    return { ok: false, reason: "non-windows-platform" };
  }

  try {
    const token = await runPowerShell(PS_SCRIPT);
    if (token.length === 0) {
      return { ok: false, reason: "github-token-not-found" };
    }
    cachedToken = token;
    return { ok: true, data: token };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn")) {
      return { ok: false, reason: "powershell-unavailable" };
    }
    return { ok: false, reason: `credential-read-failed: ${msg}` };
  }
}

/**
 * Non-secret token status for the Settings UI. Mirrors the O9 usage-reader
 * status pattern (getOAuthStatus): reports whether outcomes sync has a token
 * and from which source, WITHOUT ever returning the token value. When no token
 * is available the reason names the remedy (AW_GITHUB_TOKEN) so the feature is
 * never silently dark. `reader` is injectable for tests.
 */
export async function getGithubTokenStatus(reader?: TokenReader): Promise<GithubTokenStatus> {
  if (reader === undefined) {
    const envToken = process.env.AW_GITHUB_TOKEN;
    if (typeof envToken === "string" && envToken.trim().length > 0) {
      return { configured: true, source: "env" };
    }
  }
  // reader===undefined here means no env token; delegate to the platform read.
  // An injected reader stands in for the platform credential source.
  const result = await readGithubToken(reader);
  if (result.ok) {
    return { configured: true, source: "credential-manager" };
  }
  const reason =
    os.platform() === "win32"
      ? "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN, or store AgentWrangler-GithubToken in Credential Manager"
      : "outcomes sync: no GitHub token — set AW_GITHUB_TOKEN";
  return { configured: false, source: null, reason };
}
