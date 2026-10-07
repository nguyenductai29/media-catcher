// @vitest-environment node
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Cookie } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrowserCookieBridge, type CookieContext } from "./browser-cookie-bridge";
import { parseCookieMetadata } from "./cookie-metadata";

const url = "https://video.example.com/watch/movie";
const cookie = {
  name: "login",
  value: "private-value",
  domain: ".example.com",
  hostOnly: false,
  path: "/",
  secure: true,
  httpOnly: true,
  session: true,
  sameSite: "lax" as const,
};
const metadata = (cookies: Cookie[]) =>
  parseCookieMetadata({
    cookies: cookies.map((value) => ({
      ...value,
      expires: value.session ? -1 : value.expirationDate,
    })),
  });
const request = { pageUrl: url, required: true, mode: "currentPage" as const };
describe("browser cookie operation leases", () => {
  let directory: string;
  let bridge: BrowserCookieBridge;
  let context: CookieContext;
  let page: { url: string; generation: number; loading: boolean };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "mediavault-cookies-"));
    page = { url, generation: 1, loading: false };
    context = {
      cookies: { get: vi.fn(async () => [cookie]) },
      currentPage: () => page,
      metadata: vi.fn(async () => metadata([cookie])),
    };
    bridge = new BrowserCookieBridge({ directory });
    await bridge.initialize();
    bridge.bind(context);
  });
  afterEach(async () => {
    await bridge.shutdown();
    await rm(directory, { recursive: true, force: true });
  });
  it("exports a bounded Netscape jar and removes it before returning", async () => {
    const result = await bridge.withCookies(request, undefined, async ({ cookieFile }) => {
      expect(cookieFile).toBeDefined();
      const data = await readFile(cookieFile!, "utf8");
      expect(data).toContain("# Netscape HTTP Cookie File");
      expect(data).toContain("#HttpOnly_.example.com\tTRUE\t/\tTRUE\t0\tlogin\tprivate-value");
      return 7;
    });
    expect(result).toBe(7);
    expect(await readdir(directory)).toEqual([]);
    expect(context.cookies.get).toHaveBeenCalledWith({ url });
  });
  it("excludes unrelated, path-ineligible, expired, malformed and CDP-unmatched cookies", async () => {
    const cookies = [
      cookie,
      { ...cookie, name: "other", domain: ".other.test" },
      { ...cookie, name: "suffix", domain: ".ample.com" },
      { ...cookie, name: "path", path: "/watch/movie2" },
      { ...cookie, name: "expired", session: false, expirationDate: 1 },
      { ...cookie, name: "bad", value: "secret\ninjection" },
      { ...cookie, name: "unmatched" },
    ];
    vi.mocked(context.cookies.get).mockResolvedValue(cookies);
    vi.mocked(context.metadata).mockResolvedValue(metadata(cookies.slice(0, -1)));
    await bridge.withCookies(request, undefined, async ({ cookieFile }) => {
      const data = await readFile(cookieFile!, "utf8");
      expect(data.split(/\r?\n/).filter((line) => line.includes("\t"))).toHaveLength(1);
    });
  });
  it("rejects duplicate tuples and changed cookie values rather than borrowing metadata", async () => {
    for (const cookies of [[cookie, { ...cookie }], [{ ...cookie, value: "changed" }]]) {
      vi.mocked(context.cookies.get).mockResolvedValue(cookies);
      await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
        /^browserSessionRequired$/,
      );
    }
    expect(await readdir(directory)).toEqual([]);
  });
  it.each([
    { label: "host-only parent", cookie: { ...cookie, hostOnly: true }, eligible: false },
    {
      label: "host-only exact",
      cookie: { ...cookie, domain: "video.example.com", hostOnly: true },
      eligible: true,
    },
    { label: "matching path", cookie: { ...cookie, path: "/watch" }, eligible: true },
    {
      label: "expired persistent",
      cookie: { ...cookie, session: false, expirationDate: 1 },
      eligible: false,
    },
    {
      label: "unexpired persistent",
      cookie: { ...cookie, session: false, expirationDate: 9999999999 },
      eligible: true,
    },
  ])("enforces $label eligibility", async ({ cookie: value, eligible }) => {
    vi.mocked(context.cookies.get).mockResolvedValue([value]);
    vi.mocked(context.metadata).mockResolvedValue(metadata([value]));
    const operation = bridge.withCookies(request, undefined, async ({ cookieFile }) =>
      expect(cookieFile).toBeDefined(),
    );
    if (eligible) await operation;
    else await expect(operation).rejects.toThrow(/^browserSessionRequired$/);
  });
  it("never exports secure cookies to HTTP and rejects attribute replacement", async () => {
    page.url = url.replace("https:", "http:");
    await expect(
      bridge.withCookies({ ...request, pageUrl: page.url }, undefined, async () => {}),
    ).rejects.toThrow(/^browserSessionRequired$/);
    page.url = url;
    vi.mocked(context.metadata).mockResolvedValue(metadata([{ ...cookie, httpOnly: false }]));
    await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
      /^browserSessionRequired$/,
    );
  });
  it("bounds total exported bytes before creating a file", async () => {
    const values = Array.from({ length: 100 }, (_, i) => ({
      ...cookie,
      name: `cookie${i}`,
      value: "x".repeat(4096),
    }));
    vi.mocked(context.cookies.get).mockResolvedValue(values);
    vi.mocked(context.metadata).mockResolvedValue(metadata(values));
    await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    expect(await readdir(directory)).toEqual([]);
  });
  it("keeps public operation optional and allows trusted saved jobs after tab navigation", async () => {
    page = { url: "https://unrelated.test/", generation: 2, loading: false };
    await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    await bridge.withCookies({ ...request, required: false }, undefined, async ({ cookieFile }) =>
      expect(cookieFile).toBeUndefined(),
    );
    await bridge.withCookies({ ...request, mode: "savedJob" }, undefined, async ({ cookieFile }) =>
      expect(cookieFile).toBeDefined(),
    );
  });
  it("does not export after navigation changes during an asynchronous read", async () => {
    vi.mocked(context.cookies.get).mockImplementation(async () => {
      page.generation++;
      return [cookie];
    });
    await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    expect(await readdir(directory)).toEqual([]);
  });
  it("aborts a pending native-cookie read without delaying shutdown", async () => {
    vi.mocked(context.cookies.get).mockImplementation(() => new Promise(() => {}));
    const pending = bridge.withCookies(request, undefined, async () => {});
    const failure = expect(pending).rejects.toThrow(/^cancelled$/);
    await bridge.shutdown();
    await failure;
    expect(await readdir(directory)).toEqual([]);
  });
  it.each(["success", "failure", "cancel"])("removes the jar after %s", async (outcome) => {
    const controller = new AbortController();
    const operation = bridge.withCookies(
      request,
      controller.signal,
      async ({ signal, cookieFile }) => {
        expect(cookieFile).toBeDefined();
        if (outcome === "failure") throw new Error("downloadFailed");
        if (outcome === "cancel") {
          controller.abort();
          expect(signal.aborted).toBe(true);
          throw new Error("cancelled");
        }
      },
    );
    if (outcome === "success") await operation;
    else
      await expect(operation).rejects.toThrow(
        outcome === "cancel" ? "cancelled" : "downloadFailed",
      );
    expect(await readdir(directory)).toEqual([]);
  });
  it("preserves a safe checkpoint error while still deleting cookie material", async () => {
    await expect(
      bridge.withCookies(request, undefined, async () => {
        throw new Error("databaseFailed");
      }),
    ).rejects.toThrow(/^databaseFailed$/);
    expect(await readdir(directory)).toEqual([]);
  });
  it("invalidation aborts and drains process cleanup before allowing a new session", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let activeSignal: AbortSignal | undefined;
    const operation = bridge.withCookies(request, undefined, async ({ signal }) => {
      activeSignal = signal;
      await gate;
    });
    const failure = expect(operation).rejects.toThrow(/^browserSessionRequired$/);
    await vi.waitFor(() => expect(activeSignal).toBeDefined());
    let drained = false;
    const invalidation = bridge.invalidate().then(() => {
      drained = true;
    });
    expect(activeSignal!.aborted).toBe(true);
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(bridge.withCookies(request, undefined, async () => {})).rejects.toThrow(
      /^browserSessionRequired$/,
    );
    await expect(
      bridge.withCookies({ ...request, required: false }, undefined, async () => {}),
    ).rejects.toThrow(/^browserSessionRequired$/);
    release();
    await failure;
    await invalidation;
    expect(await readdir(directory)).toEqual([]);
    bridge.bind(context);
    await bridge.withCookies(request, undefined, async ({ cookieFile }) =>
      expect(cookieFile).toBeDefined(),
    );
  });
  it("cleans only its exact stale files and preserves foreign entries", async () => {
    await bridge.shutdown();
    await writeFile(
      join(directory, "cookie-00000000-0000-4000-8000-000000000001.txt"),
      "stale-secret",
    );
    await writeFile(join(directory, "keep.txt"), "keep");
    await mkdir(join(directory, "cookie-00000000-0000-4000-8000-000000000002.txt"));
    bridge = new BrowserCookieBridge({ directory });
    await bridge.initialize();
    expect(await readdir(directory)).toEqual([
      "cookie-00000000-0000-4000-8000-000000000002.txt",
      "keep.txt",
    ]);
  });
});
