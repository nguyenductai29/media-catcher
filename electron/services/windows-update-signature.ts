import { spawn } from "node:child_process";
import { isAbsolute, join, resolve } from "node:path";
import { parseDn } from "builder-util-runtime";
import { terminateProcessTree } from "./binary-service";

const maxOutput = 16 * 1024;
const script = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$PSModuleAutoloadingPreference = 'None'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
try {
  if (-not $env:MEDIAVAULT_SIGNATURE_FILE) { throw 'Missing file.' }
  Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1" -ErrorAction Stop
  Import-Module -Name "$PSHOME\Modules\Microsoft.PowerShell.Utility\Microsoft.PowerShell.Utility.psd1" -ErrorAction Stop
  $signature = Get-AuthenticodeSignature -LiteralPath $env:MEDIAVAULT_SIGNATURE_FILE -ErrorAction Stop
  if ($signature.Status -ne [System.Management.Automation.SignatureStatus]::Valid -or -not $signature.SignerCertificate) { exit 1 }
  [pscustomobject]@{
    status = [int]$signature.Status
    path = [string]$signature.Path
    subject = [string]$signature.SignerCertificate.Subject
    commonName = [string]$signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
  } | ConvertTo-Json -Compress
} catch { exit 1 }
`;

export function validateSignatureReport(output: string, path: string, publisher: string): void {
  try {
    if (Buffer.byteLength(output) > maxOutput) throw new Error();
    const value: unknown = JSON.parse(output.replace(/^\uFEFF/, ""));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const report = value as Record<string, unknown>;
    if (
      report.status !== 0 ||
      typeof report.path !== "string" ||
      !isAbsolute(report.path) ||
      resolve(report.path).toLowerCase() !== resolve(path).toLowerCase() ||
      typeof report.subject !== "string" ||
      !report.subject ||
      typeof report.commonName !== "string" ||
      !report.commonName ||
      /[\p{Cc}]/u.test(report.subject + report.commonName) ||
      !publisher ||
      publisher !== publisher.trim()
    )
      throw new Error();
    if (publisher.includes("=")) {
      const expected = parseDn(publisher);
      const actual = parseDn(report.subject);
      if (
        !expected.get("CN") ||
        [...expected].some(([key, name]) => !name || actual.get(key) !== name)
      )
        throw new Error();
    } else if (report.commonName !== publisher) throw new Error();
  } catch {
    throw new Error("updateFailed");
  }
}

/** A failed or unavailable verifier always rejects. File paths are data, never PowerShell source. */
export async function verifyInstallerSignature(
  path: string,
  publisher: string,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) throw new Error("cancelled");
  if (process.platform !== "win32" || !isAbsolute(path) || /[\p{Cc}]/u.test(path))
    throw new Error("updateFailed");
  const output = await new Promise<string>((resolveOutput, reject) => {
    const child = spawn(
      join(
        process.env["SystemRoot"] ?? "C:\\Windows",
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      ),
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      {
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, MEDIAVAULT_SIGNATURE_FILE: path, PSModulePath: "" },
      },
    );
    const chunks: Buffer[] = [];
    let bytes = 0,
      stderr = 0,
      settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const fail = (code: "cancelled" | "updateFailed") => {
      if (settled) return;
      settled = true;
      cleanup();
      const finish = () => {
        child.stdout.destroy();
        child.stderr.destroy();
        reject(new Error(code));
      };
      void terminateProcessTree(child).then(finish, finish);
    };
    const abort = () => fail("cancelled");
    const timer = setTimeout(() => fail("updateFailed"), 20_000);
    child.stdout.on("data", (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > maxOutput) fail("updateFailed");
      else chunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.length;
      if (stderr > 4096) fail("updateFailed");
    });
    child.once("error", () => fail("updateFailed"));
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (code !== 0 || stderr || signal.aborted)
        reject(new Error(signal.aborted ? "cancelled" : "updateFailed"));
      else resolveOutput(Buffer.concat(chunks).toString("utf8"));
    });
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  if (signal.aborted) throw new Error("cancelled");
  validateSignatureReport(output, path, publisher);
}
