// @vitest-environment node
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleAuthService } from "./google-auth-service";
import { SecureStore } from "./secure-store";
import type { DriveHttpRequest, DriveHttpResponse, DriveTransport } from "./drive-transport";

const roots: string[] = [];
const services: GoogleAuthService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
const response = (data: unknown, status = 200): DriveHttpResponse => ({
  status,
  headers: {},
  body: Buffer.from(JSON.stringify(data)),
});
async function storage() {
  const root = await mkdtemp(join(tmpdir(), "mv-oauth-"));
  roots.push(root);
  // Tests exercise the adapter boundary. Production passes Electron safeStorage.
  return {
    root,
    store: new SecureStore(root, {
      isEncryptionAvailable: () => true,
      encryptString: (value) => Buffer.from([...value].reverse().join("")),
      decryptString: (value) => [...value.toString()].reverse().join(""),
    }),
  };
}
const scopes = "openid email profile https://www.googleapis.com/auth/drive.file";
const grant = {
  version: 1,
  clientId: "desktop.apps.googleusercontent.com",
  refreshToken: "refresh-secret",
  scopes: scopes.split(" "),
  providerAccountId: "subject-123",
  email: "owner@example.test",
  displayName: "Owner",
};
function service(
  store: SecureStore,
  transport: DriveTransport,
  openExternal: (url: string) => Promise<unknown> = async () => {},
) {
  const auth = new GoogleAuthService({ clientId: grant.clientId, store, transport, openExternal });
  services.push(auth);
  return auth;
}
describe("desktop Google OAuth", () => {
  it("stays unconfigured without a client and refuses unavailable secure storage", async () => {
    const { store } = await storage();
    const auth = new GoogleAuthService({ store, openExternal: vi.fn() });
    services.push(auth);
    await auth.initialize();
    expect(auth.getAccount().configured).toBe(false);
    await expect(auth.connect()).rejects.toThrow(/^driveNotConfigured$/);
    const unavailable = new SecureStore("unused", {
      isEncryptionAvailable: () => false,
      encryptString: vi.fn(),
      decryptString: vi.fn(),
    });
    const configured = service(unavailable, { request: vi.fn() });
    await expect(configured.connect()).rejects.toThrow(/^driveSecureStorageUnavailable$/);
  });
  it("uses PKCE, ignores a forged callback, persists only encrypted refresh credentials and stable subject", async () => {
    const { root, store } = await storage();
    let authorization: URL | undefined;
    let absoluteStatus: number | undefined;
    const transport = {
      request: vi.fn(async (input: DriveHttpRequest) => {
        if (input.url.endsWith("/token")) {
          const body = new URLSearchParams(String(input.body));
          expect(body.get("code")).toBe("authorization-code");
          expect(createHash("sha256").update(body.get("code_verifier")!).digest("base64url")).toBe(
            authorization?.searchParams.get("code_challenge"),
          );
          return response({
            access_token: "access-secret",
            refresh_token: "refresh-secret",
            expires_in: 3600,
            token_type: "Bearer",
            scope: scopes,
          });
        }
        expect(input.headers?.Authorization).toBe("Bearer access-secret");
        return response({ sub: "subject-123", email: "owner@example.test", name: "Owner" });
      }),
    };
    const auth = service(store, transport, async (value) => {
      authorization = new URL(value);
      expect(authorization.origin).toBe("https://accounts.google.com");
      expect(authorization.searchParams.get("code_challenge_method")).toBe("S256");
      const callback = new URL(authorization.searchParams.get("redirect_uri")!);
      expect(callback.hostname).toBe("127.0.0.1");
      callback.searchParams.set("code", "authorization-code");
      callback.searchParams.set("state", "forged");
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set("state", authorization.searchParams.get("state")!);
      absoluteStatus = await new Promise<number | undefined>((resolve, reject) => {
        const request = httpRequest(
          {
            hostname: callback.hostname,
            port: callback.port,
            path: `http://evil.test${callback.pathname}${callback.search}`,
            headers: { Host: callback.host },
          },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        request.on("error", reject);
        request.end();
      });
      if (absoluteStatus !== 400) return;
      expect((await fetch(callback)).status).toBe(200);
    });
    const account = await auth.connect();
    expect(absoluteStatus).toBe(400);
    expect(account).toMatchObject({
      connected: true,
      connecting: false,
      providerAccountId: "subject-123",
      email: "owner@example.test",
    });
    expect(JSON.stringify(account)).not.toMatch(/access-secret|refresh-secret/);
    expect(await readFile(join(root, "auth", "google-auth.dat"), "utf8")).not.toContain(
      "refresh-secret",
    );
    expect(await auth.getAccessToken()).toBe("access-secret");
    expect(transport.request).toHaveBeenCalledTimes(2);
    const saved = await store.read("google-auth");
    expect(saved).toMatchObject({
      refreshToken: "refresh-secret",
      providerAccountId: "subject-123",
    });
    expect(saved).not.toHaveProperty("accessToken");
  });
  it("restores a client-bound grant and coalesces concurrent token refreshes", async () => {
    const { store } = await storage();
    await store.write("google-auth", grant);
    const request = vi.fn(async () =>
      response({ access_token: "fresh", expires_in: 3600, token_type: "Bearer" }),
    );
    const auth = service(store, { request });
    await auth.initialize();
    expect(auth.getAccount().providerAccountId).toBe("subject-123");
    expect(await Promise.all([auth.getAccessToken(), auth.getAccessToken()])).toEqual([
      "fresh",
      "fresh",
    ]);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("invalid_grant disconnects and removes saved credentials without repeated refresh loops", async () => {
    const { store } = await storage();
    await store.write("google-auth", grant);
    const request = vi.fn(async () =>
      response({ error: "invalid_grant", error_description: "sensitive-details" }, 400),
    );
    const auth = service(store, { request });
    await auth.initialize();
    await expect(auth.getAccessToken()).rejects.toThrow(/^driveTokenExpired$/);
    expect(auth.getAccount()).toMatchObject({ connected: false, error: "driveTokenExpired" });
    expect(await store.read("google-auth")).toBeUndefined();
    await expect(auth.getAccessToken()).rejects.toThrow(/^driveNotConnected$/);
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("disconnect during refresh prevents a late token response restoring account or credentials", async () => {
    const { store } = await storage();
    await store.write("google-auth", grant);
    let finish!: (response: DriveHttpResponse) => void;
    const request = vi.fn(
      () =>
        new Promise<DriveHttpResponse>((resolve) => {
          finish = resolve;
        }),
    );
    const auth = service(store, { request });
    await auth.initialize();
    const pending = auth.getAccessToken();
    const rejection = expect(pending).rejects.toThrow(/^cancelled$/);
    await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(1));
    await auth.disconnect();
    finish(
      response({
        access_token: "late",
        refresh_token: "rotated",
        expires_in: 3600,
        token_type: "Bearer",
      }),
    );
    await rejection;
    expect(auth.getAccount().connected).toBe(false);
    expect(await store.read("google-auth")).toBeUndefined();
  });
  it("abort closes the loopback callback and leaves no saved credential", async () => {
    const { store } = await storage();
    const controller = new AbortController();
    let callback = "";
    const auth = service(store, { request: vi.fn() }, async (value) => {
      callback = new URL(value).searchParams.get("redirect_uri")!;
      controller.abort();
    });
    await expect(auth.connect(controller.signal)).rejects.toThrow(/^cancelled$/);
    await expect(fetch(callback)).rejects.toThrow();
    expect(await store.read("google-auth")).toBeUndefined();
    expect(auth.getAccount().connecting).toBe(false);
  });
  it("does not restore credentials issued for a different desktop client", async () => {
    const { store } = await storage();
    await store.write("google-auth", { ...grant, clientId: "other-client" });
    const auth = service(store, { request: vi.fn() });
    await auth.initialize();
    expect(auth.getAccount().connected).toBe(false);
    expect(await store.read("google-auth")).toBeUndefined();
  });
  it("removes a grant when cancellation arrives while the encrypted write is pending", async () => {
    const { store } = await storage();
    const controller = new AbortController();
    const write = store.write.bind(store);
    let release!: () => void;
    const paused = new Promise<void>((resolve) => {
      release = resolve;
    });
    const pendingWrite = vi.spyOn(store, "write").mockImplementation(async (key, value) => {
      await paused;
      await write(key, value);
    });
    const auth = service(
      store,
      {
        request: async (input) =>
          input.url.endsWith("/token")
            ? response({
                access_token: "access",
                refresh_token: "refresh",
                expires_in: 3600,
                token_type: "Bearer",
                scope: scopes,
              })
            : response({ sub: "subject-123" }),
      },
      async (value) => {
        const url = new URL(value);
        const callback = new URL(url.searchParams.get("redirect_uri")!);
        callback.searchParams.set("state", url.searchParams.get("state")!);
        callback.searchParams.set("code", "code");
        await fetch(callback);
      },
    );
    const connecting = auth.connect(controller.signal);
    const rejection = expect(connecting).rejects.toThrow(/^cancelled$/);
    await vi.waitFor(() => expect(pendingWrite).toHaveBeenCalledTimes(1));
    controller.abort();
    release();
    await rejection;
    expect(await store.read("google-auth")).toBeUndefined();
    expect(auth.getAccount().connected).toBe(false);
  });
  it("drains a rotated refresh-token write on shutdown even after the upload caller aborts", async () => {
    const { store } = await storage();
    await store.write("google-auth", grant);
    const auth = service(store, {
      request: async () =>
        response({
          access_token: "fresh",
          refresh_token: "rotated",
          expires_in: 3600,
          token_type: "Bearer",
        }),
    });
    await auth.initialize();
    const write = store.write.bind(store);
    let release!: () => void;
    const delayed = new Promise<void>((resolve) => {
      release = resolve;
    });
    const writing = vi.spyOn(store, "write").mockImplementation(async (key, value) => {
      await delayed;
      await write(key, value);
    });
    const caller = new AbortController();
    const token = auth.getAccessToken(caller.signal);
    const cancelled = expect(token).rejects.toThrow("cancelled");
    await vi.waitFor(() => expect(writing).toHaveBeenCalledTimes(1));
    caller.abort();
    await cancelled;
    let stopped = false;
    const shutdown = auth.shutdown().then(() => {
      stopped = true;
    });
    for (let tick = 0; tick < 10; tick++) await Promise.resolve();
    const returnedBeforeWrite = stopped;
    release();
    await shutdown;
    expect(returnedBeforeWrite).toBe(false);
    expect(await store.read("google-auth")).toMatchObject({ refreshToken: "rotated" });
  });
  it.each(["invalid_client", "unauthorized_client", "lost_scope"])(
    "invalidates the refresh grant after permanent %s",
    async (error) => {
      const { store } = await storage();
      await store.write("google-auth", grant);
      const request = vi.fn(async () =>
        error === "lost_scope"
          ? response({
              access_token: "fresh",
              expires_in: 3600,
              token_type: "Bearer",
              scope: "openid email",
            })
          : response({ error }, 400),
      );
      const auth = service(store, { request });
      await auth.initialize();
      await expect(auth.getAccessToken()).rejects.toThrow();
      expect(auth.getAccount().connected).toBe(false);
      expect(await store.read("google-auth")).toBeUndefined();
      await expect(auth.getAccessToken()).rejects.toThrow(/^driveNotConnected$/);
      expect(request).toHaveBeenCalledTimes(1);
    },
  );
});
