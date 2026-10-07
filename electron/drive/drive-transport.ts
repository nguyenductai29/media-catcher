import { request } from "node:https";
import type { IncomingMessage } from "node:http";
import type { Readable } from "node:stream";
import type { ErrorCode } from "../../shared/models";

export class DriveRequestError extends Error {
  constructor(
    readonly code: ErrorCode,
    readonly retryable: boolean,
    readonly retryAfterMs?: number,
  ) {
    super(code);
  }
}
export interface DriveHttpRequest {
  url: string;
  method: "GET" | "POST" | "PUT";
  headers?: Record<string, string>;
  body?: string | Readable;
  signal?: AbortSignal;
  timeoutMs?: number;
  onUploadProgress?: (bytes: number) => void;
}
export interface DriveHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Buffer;
}
export interface DriveTransport {
  request(input: DriveHttpRequest): Promise<DriveHttpResponse>;
}

export function validateGoogleUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DriveRequestError("driveVerificationFailed", false);
  }
  const allowed =
    (url.hostname === "oauth2.googleapis.com" && ["/token", "/revoke"].includes(url.pathname)) ||
    (url.hostname === "openidconnect.googleapis.com" && url.pathname === "/v1/userinfo") ||
    (url.hostname === "www.googleapis.com" &&
      (/^\/drive\/v3\/(?:about|files(?:\/[A-Za-z0-9_-]{1,200})?)$/.test(url.pathname) ||
        url.pathname === "/upload/drive/v3/files"));
  if (
    !allowed ||
    value.length > 8192 ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    url.port
  )
    throw new DriveRequestError("driveVerificationFailed", false);
  return url;
}
export function validateSessionUrl(value: string): string {
  const url = validateGoogleUrl(value);
  if (
    url.hostname !== "www.googleapis.com" ||
    url.pathname !== "/upload/drive/v3/files" ||
    url.searchParams.getAll("uploadType").length !== 1 ||
    url.searchParams.get("uploadType") !== "resumable" ||
    url.searchParams.getAll("upload_id").length !== 1 ||
    !url.searchParams.get("upload_id")
  )
    throw new DriveRequestError("driveVerificationFailed", false);
  return url.toString();
}

/** HTTPS only, fixed Google endpoints, no redirect handling, bounded response bodies. */
export class GoogleHttpsTransport implements DriveTransport {
  request(input: DriveHttpRequest): Promise<DriveHttpResponse> {
    const url = validateGoogleUrl(input.url);
    if (input.signal?.aborted) return Promise.reject(new DriveRequestError("cancelled", false));
    return new Promise((resolve, reject) => {
      let settled = false;
      let response: IncomingMessage | undefined;
      const source = typeof input.body === "object" ? input.body : undefined;
      const cleanup = () => {
        clearTimeout(deadline);
        input.signal?.removeEventListener("abort", abort);
      };
      const fail = (error: DriveRequestError) => {
        if (settled) return;
        settled = true;
        cleanup();
        source?.unpipe(req);
        source?.destroy();
        response?.destroy();
        req.destroy();
        reject(error);
      };
      const abort = () => fail(new DriveRequestError("cancelled", false));
      const req = request(url, { method: input.method, headers: input.headers }, (incoming) => {
        response = incoming;
        const chunks: Buffer[] = [];
        let length = 0;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1024 * 1024) {
            fail(new DriveRequestError("driveVerificationFailed", false));
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", () => fail(new DriveRequestError("networkUnavailable", false)));
        incoming.on("aborted", () => fail(new DriveRequestError("networkUnavailable", false)));
        incoming.on("end", () => {
          if (settled) return;
          settled = true;
          cleanup();
          source?.unpipe(req);
          source?.destroy();
          req.destroy();
          const headers: Record<string, string> = {};
          for (const [key, value] of Object.entries(incoming.headers))
            if (typeof value === "string") headers[key.toLowerCase()] = value;
          resolve({
            status: incoming.statusCode ?? 0,
            headers,
            body: Buffer.concat(chunks, length),
          });
        });
      });
      req.on("error", () => fail(new DriveRequestError("networkUnavailable", false)));
      req.setTimeout(30_000, () => fail(new DriveRequestError("networkUnavailable", false)));
      const deadline = setTimeout(
        () => fail(new DriveRequestError("networkUnavailable", false)),
        Math.min(input.timeoutMs ?? 60_000, 10 * 60_000),
      );
      input.signal?.addEventListener("abort", abort, { once: true });
      if (input.signal?.aborted) {
        abort();
        return;
      }
      if (source) {
        let bytes = 0;
        source.on("error", (error: unknown) => {
          const code =
            error instanceof DriveRequestError &&
            (error.code === "fileChanged" ||
              error.code === "fileAccessDenied" ||
              error.code === "fileMissing")
              ? error.code
              : "fileMissing";
          fail(new DriveRequestError(code, false));
        });
        source.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          input.onUploadProgress?.(bytes);
        });
        source.pipe(req);
      } else req.end(input.body);
    });
  }
}

export function jsonObject(response: DriveHttpResponse): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(response.body.toString("utf8"));
    if (value && typeof value === "object" && !Array.isArray(value))
      return value as Record<string, unknown>;
  } catch {
    /* Safe error below. */
  }
  throw new DriveRequestError("driveVerificationFailed", false);
}
export function googleResponseError(response: DriveHttpResponse): DriveRequestError {
  let reason = "";
  try {
    const data = jsonObject(response);
    if (
      data.error &&
      typeof data.error === "object" &&
      "errors" in data.error &&
      Array.isArray(data.error.errors)
    ) {
      const first: unknown = data.error.errors[0];
      if (
        first &&
        typeof first === "object" &&
        "reason" in first &&
        typeof first.reason === "string"
      )
        reason = first.reason;
    }
  } catch {
    /* Response diagnostics never cross this boundary. */
  }
  const delay = response.headers["retry-after"];
  const milliseconds =
    delay && /^\d+$/.test(delay)
      ? Number(delay) * 1000
      : delay
        ? Date.parse(delay) - Date.now()
        : undefined;
  const retryAfterMs =
    milliseconds !== undefined && Number.isFinite(milliseconds)
      ? Math.max(0, Math.min(60_000, milliseconds))
      : undefined;
  if (response.status === 401) return new DriveRequestError("driveTokenExpired", false);
  if (response.status === 403 && reason === "storageQuotaExceeded")
    return new DriveRequestError("driveQuotaExceeded", false);
  if (
    response.status === 429 ||
    response.status >= 500 ||
    ["rateLimitExceeded", "userRateLimitExceeded"].includes(reason)
  )
    return new DriveRequestError("driveUnavailable", true, retryAfterMs);
  if (response.status === 403) return new DriveRequestError("drivePermissionDenied", false);
  if (response.status === 404) return new DriveRequestError("driveFileMissing", false);
  return new DriveRequestError("driveUploadFailed", false);
}
