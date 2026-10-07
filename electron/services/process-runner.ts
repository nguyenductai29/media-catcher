import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import type { ErrorCode } from "../../shared/models";
import { terminateProcessTree } from "./binary-service";
import { classifyProcessFailure } from "./process-failure";

export interface ManagedProcessOptions {
  timeout: number;
  /** Capture limit, or maximum UTF-8 line size when streaming. */
  maxStdout: number;
  /** Maximum retained diagnostic tail; diagnostics are never returned. */
  maxStderr: number;
  signal?: AbortSignal | undefined;
  cwd?: string | undefined;
  onStdoutLine?: ((line: string) => void) | undefined;
  failureCode?: ErrorCode;
  timeoutCode?: ErrorCode;
}

/** Streaming mode returns an empty string and does not accumulate progress. */
export function runManagedProcess(
  binary: string,
  args: string[],
  options: ManagedProcessOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const failureCode = options.failureCode ?? "downloadFailed";
    if (options.signal?.aborted) {
      reject(new Error("cancelled"));
      return;
    }
    if (
      ![options.timeout, options.maxStdout, options.maxStderr].every(
        (value) => Number.isSafeInteger(value) && value > 0,
      )
    ) {
      reject(new Error("invalidInput"));
      return;
    }
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn(binary, args, {
        shell: false,
        windowsHide: true,
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
        ...(options.cwd ? { cwd: options.cwd } : {}),
      });
      child.stdin.end();
    } catch {
      reject(new Error("binaryInvalid"));
      return;
    }
    let settled = false;
    let capturedSize = 0;
    let pending = "";
    let diagnosticTail = Buffer.alloc(0);
    const decoder = new StringDecoder("utf8");
    const captured: Buffer[] = [];
    const timer = setTimeout(() => fail(options.timeoutCode ?? failureCode, true), options.timeout);

    function cleanup() {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      child.stdout.removeListener("data", output);
      child.stderr.removeListener("data", diagnostic);
      child.stdout.destroy();
      child.stderr.destroy();
      captured.length = 0;
      pending = "";
      diagnosticTail = Buffer.alloc(0);
    }
    function fail(code: ErrorCode | Error, kill = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abort);
      const finish = () => {
        cleanup();
        reject(code instanceof Error ? code : new Error(code));
      };
      if (kill) void terminateProcessTree(child).then(finish, finish);
      else finish();
    }
    function abort() {
      fail("cancelled", true);
    }
    function deliver(line: string) {
      if (settled) return;
      if (Buffer.byteLength(line) > options.maxStdout) {
        fail(failureCode, true);
        return;
      }
      try {
        options.onStdoutLine?.(line.replace(/\r$/, ""));
      } catch {
        fail(failureCode, true);
      }
    }
    function output(chunk: Buffer | string) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (!options.onStdoutLine) {
        capturedSize += bytes.length;
        if (capturedSize > options.maxStdout) {
          fail(failureCode, true);
          return;
        }
        captured.push(bytes);
        return;
      }
      const text = pending + decoder.write(bytes);
      let start = 0;
      let end: number;
      while (!settled && (end = text.indexOf("\n", start)) !== -1) {
        deliver(text.slice(start, end));
        start = end + 1;
      }
      if (settled) return;
      pending = text.slice(start);
      if (Buffer.byteLength(pending) > options.maxStdout) fail(failureCode, true);
    }
    function diagnostic(chunk: Buffer | string) {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      diagnosticTail = Buffer.concat([diagnosticTail, bytes.subarray(-options.maxStderr)]).subarray(
        -options.maxStderr,
      );
    }
    function launchError(error: NodeJS.ErrnoException) {
      fail(error.code === "ENOENT" ? "binaryMissing" : "binaryInvalid");
    }
    function closed(code: number | null) {
      child.removeListener("error", launchError);
      if (settled) return;
      if (code !== 0) {
        const diagnostic = diagnosticTail.toString("utf8");
        fail(classifyProcessFailure(diagnostic, failureCode));
        return;
      }
      if (options.onStdoutLine) {
        pending += decoder.end();
        if (pending) deliver(pending);
        if (settled) return;
      }
      const result = options.onStdoutLine ? "" : Buffer.concat(captured).toString("utf8");
      settled = true;
      cleanup();
      resolve(result);
    }
    child.stdout.on("data", output);
    child.stderr.on("data", diagnostic);
    child.on("error", launchError);
    child.once("close", closed);
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) abort();
  });
}
