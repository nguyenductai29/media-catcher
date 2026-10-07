import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { DriveAccount, ErrorCode } from "../../shared/models";
import { SnapshotEvents } from "../services/snapshot-events";
import { SecureStore } from "./secure-store";
import {
  DriveRequestError,
  GoogleHttpsTransport,
  googleResponseError,
  jsonObject,
  type DriveTransport,
} from "./drive-transport";

export const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const SCOPES = ["openid", "email", "profile", DRIVE_SCOPE];
const STORE_KEY = "google-auth";
interface SavedGrant {
  version: 1;
  clientId: string;
  refreshToken: string;
  scopes: string[];
  providerAccountId: string;
  email?: string;
  displayName?: string;
}
export interface GoogleAuthOptions {
  clientId?: string;
  clientSecret?: string;
  store: SecureStore;
  openExternal: (url: string) => Promise<unknown>;
  transport?: DriveTransport;
  callbackMessage?: () => string;
  now?: () => number;
}
function bounded(value: unknown, max: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= max && !/\p{Cc}/u.test(value)
  );
}
function validGrant(value: unknown, clientId: string): value is SavedGrant {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return (
    data.version === 1 &&
    data.clientId === clientId &&
    bounded(data.refreshToken, 8192) &&
    bounded(data.providerAccountId, 255) &&
    /^[\x20-\x7e]+$/.test(data.providerAccountId) &&
    Array.isArray(data.scopes) &&
    data.scopes.length <= 20 &&
    data.scopes.every((s) => bounded(s, 200)) &&
    data.scopes.includes(DRIVE_SCOPE) &&
    data.scopes.includes("openid") &&
    (data.email === undefined || bounded(data.email, 320)) &&
    (data.displayName === undefined || bounded(data.displayName, 512))
  );
}
function waitWithSignal<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DriveRequestError("cancelled", false));
  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(new DriveRequestError("cancelled", false));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

/** Tokens and the loopback listener live in Main; getAccount is the only public DTO. */
export class GoogleAuthService {
  private readonly clientId: string;
  private readonly transport: DriveTransport;
  private readonly now: () => number;
  private account: DriveAccount;
  private grant: SavedGrant | undefined;
  private access: { token: string; expires: number } | undefined;
  private generation = 0;
  private lifecycle = new AbortController();
  private refresh: Promise<string> | undefined;
  private connection: Promise<DriveAccount> | undefined;
  private shutdownWork: Promise<void> | undefined;
  private closed = false;
  readonly events = new SnapshotEvents(() => this.getAccount());
  constructor(private readonly options: GoogleAuthOptions) {
    this.clientId = options.clientId?.trim() ?? "";
    this.transport = options.transport ?? new GoogleHttpsTransport();
    this.now = options.now ?? Date.now;
    this.account = {
      configured:
        /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(this.clientId) &&
        !this.clientId.startsWith("replace-"),
      connected: false,
      connecting: false,
    };
  }
  getAccount(): DriveAccount {
    return { ...this.account };
  }
  private publish(value: DriveAccount): void {
    this.account = value;
    this.events.notify();
  }
  private check(generation: number, signal?: AbortSignal): void {
    if (this.closed || this.generation !== generation || signal?.aborted)
      throw new DriveRequestError("cancelled", false);
  }
  private connected(grant: SavedGrant): void {
    this.publish({
      configured: true,
      connecting: false,
      connected: true,
      providerAccountId: grant.providerAccountId,
      ...(grant.email ? { email: grant.email } : {}),
      ...(grant.displayName ? { displayName: grant.displayName } : {}),
    });
  }
  async initialize(): Promise<void> {
    if (!this.account.configured) return;
    const generation = this.generation;
    try {
      if (!this.options.store.isAvailable()) throw new Error("driveSecureStorageUnavailable");
      const value = await this.options.store.read(STORE_KEY);
      this.check(generation);
      if (value === undefined) return;
      if (!validGrant(value, this.clientId)) {
        await this.options.store.remove(STORE_KEY);
        return;
      }
      this.grant = value;
      this.connected(value);
    } catch (error) {
      if (generation !== this.generation || this.closed) return;
      this.publish({
        ...this.account,
        connected: false,
        error:
          error instanceof Error && error.message === "cancelled"
            ? "cancelled"
            : "driveSecureStorageUnavailable",
      });
    }
  }
  connect(signal?: AbortSignal): Promise<DriveAccount> {
    if (!this.account.configured) return Promise.reject(new Error("driveNotConfigured"));
    if (!this.options.store.isAvailable())
      return Promise.reject(new Error("driveSecureStorageUnavailable"));
    if (this.closed || signal?.aborted) return Promise.reject(new Error("cancelled"));
    if (this.account.connected) return Promise.resolve(this.getAccount());
    if (this.connection) return waitWithSignal(this.connection, signal);
    const operation = this.connectInternal(signal);
    this.connection = operation;
    void operation
      .finally(() => {
        if (this.connection === operation) this.connection = undefined;
      })
      .catch(() => {});
    return operation;
  }
  private async connectInternal(signal?: AbortSignal): Promise<DriveAccount> {
    const generation = this.generation;
    const combined = signal
      ? AbortSignal.any([signal, this.lifecycle.signal])
      : this.lifecycle.signal;
    let wroteGrant = false;
    this.publish({ configured: true, connected: false, connecting: true });
    try {
      const verifier = randomBytes(32).toString("base64url");
      const { code, redirectUri } = await this.authorizationCode(verifier, combined);
      this.check(generation, combined);
      const body = new URLSearchParams({
        client_id: this.clientId,
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
      });
      if (this.options.clientSecret) body.set("client_secret", this.options.clientSecret);
      const response = await this.transport.request({
        url: "https://oauth2.googleapis.com/token",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
        signal: combined,
      });
      this.check(generation, combined);
      if (response.status !== 200) throw new DriveRequestError("driveAuthFailed", false);
      const data = jsonObject(response);
      const token = this.parseToken(data);
      if (!bounded(data.refresh_token, 8192) || !bounded(data.scope, 4096))
        throw new DriveRequestError("driveAuthFailed", false);
      const scopes = data.scope.split(/\s+/);
      if (!scopes.includes(DRIVE_SCOPE) || !scopes.includes("openid"))
        throw new DriveRequestError("drivePermissionDenied", false);
      const identityResponse = await this.transport.request({
        url: "https://openidconnect.googleapis.com/v1/userinfo",
        method: "GET",
        headers: { Authorization: `Bearer ${token.token}` },
        signal: combined,
      });
      this.check(generation, combined);
      if (identityResponse.status !== 200) throw new DriveRequestError("driveAuthFailed", false);
      const identity = jsonObject(identityResponse);
      if (!bounded(identity.sub, 255) || !/^[\x20-\x7e]+$/.test(identity.sub))
        throw new DriveRequestError("driveAuthFailed", false);
      const grant: SavedGrant = {
        version: 1,
        clientId: this.clientId,
        refreshToken: data.refresh_token,
        scopes,
        providerAccountId: identity.sub,
        ...(bounded(identity.email, 320) ? { email: identity.email } : {}),
        ...(bounded(identity.name, 512) ? { displayName: identity.name } : {}),
      };
      await this.options.store.write(STORE_KEY, grant);
      wroteGrant = true;
      this.check(generation, combined);
      this.grant = grant;
      this.access = token;
      this.connected(grant);
      return this.getAccount();
    } catch (error) {
      if (wroteGrant && combined.aborted && (generation === this.generation || this.closed))
        await this.options.store.remove(STORE_KEY);
      const code: ErrorCode =
        combined.aborted || generation !== this.generation
          ? "cancelled"
          : error instanceof DriveRequestError
            ? error.code
            : error instanceof Error && error.message === "driveSecureStorageUnavailable"
              ? "driveSecureStorageUnavailable"
              : "driveAuthFailed";
      if (generation === this.generation && !this.closed)
        this.publish({ configured: true, connected: false, connecting: false, error: code });
      throw new DriveRequestError(code, false);
    }
  }
  private authorizationCode(
    verifier: string,
    signal: AbortSignal,
  ): Promise<{ code: string; redirectUri: string }> {
    return new Promise((resolve, reject) => {
      const state = randomBytes(32).toString("base64url");
      let redirectUri = "";
      let settled = false;
      const server = createServer({ maxHeaderSize: 8192 }, (request, response) => {
        const deny = () => {
          response.writeHead(400, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
            Connection: "close",
          });
          response.end("MediaVault");
        };
        if (
          settled ||
          request.method !== "GET" ||
          !request.url ||
          !request.url.startsWith("/") ||
          request.url.startsWith("//") ||
          request.url.length > 8192 ||
          request.headers.host !== new URL(redirectUri).host
        ) {
          deny();
          return;
        }
        let callback: URL;
        try {
          callback = new URL(request.url, redirectUri);
        } catch {
          deny();
          return;
        }
        const returnedState = callback.searchParams.get("state");
        if (
          callback.origin !== new URL(redirectUri).origin ||
          callback.pathname !== "/oauth/callback" ||
          callback.searchParams.getAll("state").length !== 1 ||
          !returnedState ||
          Buffer.byteLength(returnedState) !== Buffer.byteLength(state) ||
          !timingSafeEqual(Buffer.from(returnedState), Buffer.from(state))
        ) {
          deny();
          return;
        }
        const code = callback.searchParams.get("code");
        if (callback.searchParams.has("error")) {
          deny();
          finish(new DriveRequestError("driveAuthFailed", false));
          return;
        }
        if (callback.searchParams.getAll("code").length !== 1 || !bounded(code, 4096)) {
          deny();
          return;
        }
        response.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy": "default-src 'none'",
          Connection: "close",
        });
        response.once("finish", () => server.closeAllConnections());
        response.end(this.options.callbackMessage?.() ?? "MediaVault");
        finish(undefined, code);
      });
      server.requestTimeout = 10_000;
      server.headersTimeout = 10_000;
      server.keepAliveTimeout = 1_000;
      server.maxConnections = 8;
      const close = () => {
        server.close();
        server.closeIdleConnections();
      };
      const timer = setTimeout(() => {
        finish(new DriveRequestError("driveAuthFailed", false));
        server.closeAllConnections();
      }, 5 * 60_000);
      const abort = () => {
        finish(new DriveRequestError("cancelled", false));
        server.closeAllConnections();
      };
      const finish = (error?: Error, code?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener("abort", abort);
        close();
        if (error) reject(error);
        else resolve({ code: code!, redirectUri });
      };
      server.on("error", () => finish(new DriveRequestError("driveAuthFailed", false)));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) {
        abort();
        return;
      }
      server.listen(0, "127.0.0.1", () => {
        if (settled) {
          close();
          return;
        }
        redirectUri = `http://127.0.0.1:${(server.address() as AddressInfo).port}/oauth/callback`;
        const authorization = new URL("https://accounts.google.com/o/oauth2/v2/auth");
        authorization.search = new URLSearchParams({
          client_id: this.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: SCOPES.join(" "),
          access_type: "offline",
          prompt: "consent",
          code_challenge: createHash("sha256").update(verifier).digest("base64url"),
          code_challenge_method: "S256",
          state,
        }).toString();
        void Promise.resolve()
          .then(() => this.options.openExternal(authorization.toString()))
          .catch(() => finish(new DriveRequestError("driveAuthFailed", false)));
      });
    });
  }
  private parseToken(data: Record<string, unknown>): { token: string; expires: number } {
    if (
      !bounded(data.access_token, 8192) ||
      typeof data.token_type !== "string" ||
      data.token_type.toLowerCase() !== "bearer" ||
      typeof data.expires_in !== "number" ||
      !Number.isFinite(data.expires_in) ||
      data.expires_in <= 0 ||
      data.expires_in > 86400
    )
      throw new DriveRequestError("driveAuthFailed", false);
    return { token: data.access_token, expires: this.now() + data.expires_in * 1000 };
  }
  async getAccessToken(signal?: AbortSignal, forceRefresh = false): Promise<string> {
    this.check(this.generation, signal);
    if (!this.grant) throw new DriveRequestError("driveNotConnected", false);
    if (!forceRefresh && this.access && this.access.expires > this.now() + 60_000)
      return this.access.token;
    if (!this.refresh) {
      const operation = this.refreshToken();
      this.refresh = operation;
      void operation
        .finally(() => {
          if (this.refresh === operation) this.refresh = undefined;
        })
        .catch(() => {});
    }
    return waitWithSignal(this.refresh, signal);
  }
  private async refreshToken(): Promise<string> {
    const generation = this.generation;
    const grant = this.grant!;
    const signal = this.lifecycle.signal;
    const body = new URLSearchParams({
      client_id: this.clientId,
      grant_type: "refresh_token",
      refresh_token: grant.refreshToken,
    });
    if (this.options.clientSecret) body.set("client_secret", this.options.clientSecret);
    const response = await this.transport.request({
      url: "https://oauth2.googleapis.com/token",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal,
    });
    this.check(generation, signal);
    if (response.status !== 200) {
      let invalid = false;
      try {
        invalid = ["invalid_grant", "invalid_client", "unauthorized_client"].includes(
          String(jsonObject(response).error),
        );
      } catch {
        /* Safe error below. */
      }
      if (invalid || response.status === 401) {
        await this.invalidateGrant("driveTokenExpired", generation, signal);
        throw new DriveRequestError("driveTokenExpired", false);
      }
      throw googleResponseError(response);
    }
    const data = jsonObject(response);
    const token = this.parseToken(data);
    if (
      data.scope !== undefined &&
      (!bounded(data.scope, 4096) ||
        !data.scope.split(/\s+/).includes(DRIVE_SCOPE) ||
        !data.scope.split(/\s+/).includes("openid"))
    ) {
      await this.invalidateGrant("drivePermissionDenied", generation, signal);
      throw new DriveRequestError("drivePermissionDenied", false);
    }
    if (data.refresh_token !== undefined) {
      if (!bounded(data.refresh_token, 8192)) throw new DriveRequestError("driveAuthFailed", false);
      const updated = { ...grant, refreshToken: data.refresh_token };
      await this.options.store.write(STORE_KEY, updated);
      this.check(generation, signal);
      this.grant = updated;
    }
    this.access = token;
    return token.token;
  }
  private async invalidateGrant(
    error: ErrorCode,
    generation: number,
    signal: AbortSignal,
  ): Promise<void> {
    this.check(generation, signal);
    this.grant = undefined;
    this.access = undefined;
    this.publish({ configured: true, connecting: false, connected: false, error });
    await this.options.store.remove(STORE_KEY);
    this.check(generation, signal);
  }
  async disconnect(): Promise<void> {
    this.generation++;
    this.lifecycle.abort();
    this.lifecycle = new AbortController();
    this.grant = undefined;
    this.access = undefined;
    this.refresh = undefined;
    this.connection = undefined;
    this.publish({ configured: this.account.configured, connecting: false, connected: false });
    await this.options.store.remove(STORE_KEY);
  }
  shutdown(): Promise<void> {
    if (this.shutdownWork) return this.shutdownWork;
    const pending = [this.refresh, this.connection];
    this.closed = true;
    this.generation++;
    this.lifecycle.abort();
    this.access = undefined;
    this.events.dispose();
    // Caller cancellation releases its token wait immediately; the shared
    // refresh may still be atomically persisting a rotated refresh credential.
    this.shutdownWork = Promise.allSettled(pending).then(() => {});
    return this.shutdownWork;
  }
}
