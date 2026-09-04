/**
 * src/oauth/anthropic-api-key.ts — Anthropic API-key reader for the G2 judge.
 *
 * Resolves a raw Anthropic Console API key so the judge can authenticate with
 * `x-api-key` (a separate rate-limit pool) instead of the Claude Code
 * subscription OAuth token, which it shares with live Claude Code generation.
 *
 * Sources, first match wins:
 *   - ANTHROPIC_API_KEY env var → {ok:true, source:'env'}
 *   - Windows Credential Manager Generic cred "AgentWrangler-AnthropicKey"
 *       → {ok:true, source:'credential-manager'}
 *
 * SEC-101: the key VALUE is never logged; callers report only `source`.
 * Never throws.
 */

import * as os from "node:os";
import { type RawExec, runPowerShell } from "../outcomes/github/credential.js";

const CREDENTIAL_TARGET = "AgentWrangler-AnthropicKey";

export type ApiKeyResult =
  | { ok: true; data: string; source: "env" | "credential-manager" }
  | { ok: false; reason: string };

/** CredRead P/Invoke for the Anthropic key blob (mirrors the GitHub reader). */
const PS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class AnthKeyCredMgr {
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
if ([AnthKeyCredMgr]::CredRead("${CREDENTIAL_TARGET}", 1, 0, [ref]$ptr)) {
  $cred = [System.Runtime.InteropServices.Marshal]::PtrToStructure($ptr, [type][AnthKeyCredMgr+CREDENTIAL])
  if ($cred.CredentialBlobSize -gt 0) {
    $bytes = New-Object byte[] $cred.CredentialBlobSize
    [System.Runtime.InteropServices.Marshal]::Copy($cred.CredentialBlob, $bytes, 0, $cred.CredentialBlobSize)
    [AnthKeyCredMgr]::CredFree($ptr)
    $key = [System.Text.Encoding]::Unicode.GetString($bytes).Trim()
    if ($key.Length -gt 0) { Write-Output $key }
  } else {
    [AnthKeyCredMgr]::CredFree($ptr)
  }
}
`.trim();

/**
 * Read the Anthropic API key from the env or Windows Credential Manager.
 * `raw` is injectable for tests. Never throws.
 */
export async function readAnthropicApiKey(raw?: RawExec): Promise<ApiKeyResult> {
  const envKey = process.env.ANTHROPIC_API_KEY;
  if (typeof envKey === "string" && envKey.trim().length > 0) {
    return { ok: true, data: envKey.trim(), source: "env" };
  }

  if (raw === undefined && os.platform() !== "win32") {
    return { ok: false, reason: "non-windows-platform" };
  }

  try {
    const key = await runPowerShell(PS_SCRIPT, raw);
    if (key.length === 0) {
      return { ok: false, reason: "anthropic-key-not-found" };
    }
    return { ok: true, data: key, source: "credential-manager" };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("ENOENT") || msg.includes("not found") || msg.includes("spawn")) {
      return { ok: false, reason: "powershell-unavailable" };
    }
    return { ok: false, reason: `credential-read-failed: ${msg}` };
  }
}
