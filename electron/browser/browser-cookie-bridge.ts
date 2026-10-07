import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { isAbsolute, join, normalize } from "node:path";
import type { Cookie } from "electron";
import { cookieFingerprint, cookieKey, type CookieMetadata } from "./cookie-metadata";
import { normalizeBrowserUrl } from "./url";

export interface CookieContext {
  cookies: { get(filter: { url: string }): Promise<Cookie[]> };
  currentPage(): { url: string; generation: number; loading: boolean } | null;
  metadata(url: string, signal: AbortSignal): Promise<CookieMetadata[]>;
}
export interface CookieRequest {
  pageUrl: string;
  required: boolean;
  /** savedJob is usable only by Main's persisted job executor. */
  mode: "currentPage" | "savedJob";
}
export interface CookieOperation {
  cookieFile?: string;
  signal: AbortSignal;
}
export type CookieEvent = "authAnalysisRetry" | "authDownloadUsed" | "cookieCleanupFailed";
interface Options {
  directory: string;
  onEvent?: (event: CookieEvent) => void;
}
interface Lease {
  controller: AbortController;
  done: Promise<void>;
}
const filename =
  /^cookie-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.txt$/;
const safeText = (value: string) => !/[\p{Cc}\p{Cf}]/u.test(value);
const samePage = (a: string, b: string) =>
  normalizeBrowserUrl(a).split("#")[0] === normalizeBrowserUrl(b).split("#")[0];
const pathIdentity = (value: string) =>
  process.platform === "win32" ? normalize(value).toLowerCase() : normalize(value);
const isMissing = (error: unknown) =>
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
function boundedRead<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
    };
    const abort = () => {
      cleanup();
      reject(new Error("cancelled"));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("browserSessionRequired"));
    }, 5000);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      () => {
        cleanup();
        reject(new Error("browserSessionRequired"));
      },
    );
    if (signal.aborted) abort();
  });
}

/** Cookies only exist in operation memory and uniquely owned, short-lived jars. */
export class BrowserCookieBridge {
  private context: CookieContext | undefined;
  private epoch = 0;
  private closed = false;
  private accepting = false;
  private initialized: Promise<void> | undefined;
  private directory: string | undefined;
  private active = new Set<Lease>();
  constructor(private readonly options: Options) {}
  event(event: CookieEvent): void {
    try {
      this.options.onEvent?.(event);
    } catch {
      /* Logging cannot affect a lease. */
    }
  }
  initialize(): Promise<void> {
    this.initialized ??= this.prepareDirectory().catch(() => {
      throw new Error("fileAccessDenied");
    });
    return this.initialized;
  }
  private async prepareDirectory() {
    if (!isAbsolute(this.options.directory)) throw new Error("fileAccessDenied");
    await mkdir(this.options.directory, { recursive: true, mode: 0o700 });
    const info = await lstat(this.options.directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("fileAccessDenied");
    this.directory = await realpath(this.options.directory);
    for (const entry of await readdir(this.directory, { withFileTypes: true })) {
      if (!filename.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
      await unlink(join(this.directory, entry.name));
    }
  }
  bind(context: CookieContext): void {
    if (this.closed || this.active.size) throw new Error("browserSessionRequired");
    this.context = context;
    this.epoch++;
    this.accepting = true;
  }
  withCookies<T>(
    request: CookieRequest,
    signal: AbortSignal | undefined,
    action: (context: CookieOperation) => Promise<T>,
  ): Promise<T> {
    if (this.closed || signal?.aborted) return Promise.reject(new Error("cancelled"));
    if (!this.accepting) return Promise.reject(new Error("browserSessionRequired"));
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const lease: Lease = { controller, done: Promise.resolve() };
    const epoch = this.epoch;
    const context = this.accepting ? this.context : undefined;
    this.active.add(lease);
    const result = this.run(request, context, epoch, signal, controller.signal, action).finally(
      () => {
        signal?.removeEventListener("abort", abort);
        this.active.delete(lease);
      },
    );
    lease.done = result.then(
      () => {},
      () => {},
    );
    return result;
  }
  private async run<T>(
    request: CookieRequest,
    context: CookieContext | undefined,
    epoch: number,
    external: AbortSignal | undefined,
    signal: AbortSignal,
    action: (context: CookieOperation) => Promise<T>,
  ): Promise<T> {
    let cookieFile: string | undefined;
    const check = () => {
      if (external?.aborted || this.closed) throw new Error("cancelled");
      if (signal.aborted || epoch !== this.epoch) throw new Error("browserSessionRequired");
    };
    try {
      check();
      let pageUrl: string;
      try {
        pageUrl = normalizeBrowserUrl(request.pageUrl);
      } catch {
        throw new Error("browserSessionRequired");
      }
      const currentPage = context?.currentPage();
      const page = currentPage ? { ...currentPage } : null;
      const matches = () => {
        if (!context) return false;
        if (request.mode === "savedJob") return true;
        const current = context.currentPage();
        try {
          return (
            !!page &&
            !!current &&
            !current.loading &&
            current.generation === page.generation &&
            samePage(pageUrl, current.url)
          );
        } catch {
          return false;
        }
      };
      let data: string | undefined;
      if (matches() && context) {
        try {
          const cookies = await boundedRead(context.cookies.get({ url: pageUrl }), signal);
          check();
          const metadata = await context.metadata(pageUrl, signal);
          check();
          if (!matches()) throw new Error("browserSessionRequired");
          data = serializeCookies(cookies, metadata, new URL(pageUrl));
        } catch {
          check();
          if (request.required) throw new Error("browserSessionRequired");
        }
      }
      check();
      if (!data && request.required) throw new Error("browserSessionRequired");
      if (data) {
        await this.initialize();
        check();
        const root = this.directory!;
        const info = await lstat(root);
        if (
          !info.isDirectory() ||
          info.isSymbolicLink() ||
          pathIdentity(await realpath(root)) !== pathIdentity(root)
        )
          throw new Error("fileAccessDenied");
        const target = join(root, `cookie-${randomUUID()}.txt`);
        const file = await open(target, "wx", 0o600);
        cookieFile = target;
        try {
          await file.writeFile(data, "utf8");
        } finally {
          await file.close();
        }
        check();
        if (!matches()) throw new Error("browserSessionRequired");
      }
      const result = await action({ ...(cookieFile ? { cookieFile } : {}), signal });
      check();
      return result;
    } catch (error) {
      check();
      if (
        error instanceof Error &&
        [
          "browserSessionRequired",
          "cancelled",
          "fileAccessDenied",
          "databaseFailed",
          "analysisFailed",
          "analysisTimeout",
          "binaryMissing",
          "binaryInvalid",
          "drmProtected",
          "downloadFailed",
          "networkUnavailable",
          "insufficientSpace",
          "fileMissing",
          "invalidInput",
          "invalidUrl",
        ].includes(error.message)
      )
        throw error;
      throw new Error("fileAccessDenied");
    } finally {
      if (cookieFile) await this.removeCookieFile(cookieFile);
    }
  }
  private async removeCookieFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch (error) {
      if (!isMissing(error)) {
        this.event("cookieCleanupFailed");
        throw new Error("fileAccessDenied");
      }
    }
  }
  invalidate(): Promise<void> {
    this.accepting = false;
    this.context = undefined;
    this.epoch++;
    for (const lease of this.active) lease.controller.abort();
    return Promise.all([...this.active].map((lease) => lease.done)).then(() => {});
  }
  shutdown(): Promise<void> {
    this.closed = true;
    return this.invalidate();
  }
}

function serializeCookies(
  cookies: Cookie[],
  metadata: CookieMetadata[],
  url: URL,
): string | undefined {
  if (!Array.isArray(cookies) || cookies.length > 3000) throw new Error("browserSessionRequired");
  const allowed = new Map(metadata.map((item) => [cookieKey(item), item]));
  const counts = new Map<string, number>();
  for (const item of cookies) {
    if (
      typeof item.domain !== "string" ||
      typeof item.path !== "string" ||
      typeof item.name !== "string"
    )
      continue;
    const key = cookieKey({ ...item, domain: item.domain, path: item.path });
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const lines: string[] = [];
  let size = 32;
  const now = Date.now() / 1000;
  for (const item of cookies) {
    const { domain, path, name, value } = item;
    if (
      typeof domain !== "string" ||
      typeof path !== "string" ||
      typeof name !== "string" ||
      typeof value !== "string"
    )
      continue;
    if (
      ![domain, path, name, value].every(safeText) ||
      !domain ||
      !path.startsWith("/") ||
      !name ||
      domain.length > 254 ||
      path.length > 4096 ||
      name.length > 4096 ||
      value.length > 16384
    )
      continue;
    const key = cookieKey({ domain, path, name });
    const match = allowed.get(key);
    if (!match || counts.get(key) !== 1 || cookieFingerprint(value) !== match.fingerprint) continue;
    const secure = item.secure === true,
      httpOnly = item.httpOnly === true,
      session = item.session === true;
    if (
      secure !== match.secure ||
      httpOnly !== match.httpOnly ||
      session !== match.session ||
      (!session && item.expirationDate !== match.expires)
    )
      continue;
    const hostOnly = item.hostOnly ?? !domain.startsWith(".");
    const host = domain.toLowerCase().replace(/^\./, "");
    if (
      hostOnly ? url.hostname !== host : url.hostname !== host && !url.hostname.endsWith(`.${host}`)
    )
      continue;
    if (secure && url.protocol !== "https:") continue;
    if (
      url.pathname !== path &&
      (!url.pathname.startsWith(path) || (!path.endsWith("/") && url.pathname[path.length] !== "/"))
    )
      continue;
    if (!session && (!Number.isFinite(item.expirationDate) || item.expirationDate! <= now))
      continue;
    const expires = session ? 0 : Math.floor(item.expirationDate!);
    const line = `${httpOnly ? "#HttpOnly_" : ""}${hostOnly ? host : `.${host}`}\t${hostOnly ? "FALSE" : "TRUE"}\t${path}\t${secure ? "TRUE" : "FALSE"}\t${expires}\t${name}\t${value}`;
    size += Buffer.byteLength(line) + 2;
    if (size > 256 * 1024 || lines.length >= 500) throw new Error("browserSessionRequired");
    lines.push(line);
  }
  if (!lines.length) return undefined;
  const result = ["# Netscape HTTP Cookie File", ...lines, ""].join(
    process.platform === "win32" ? "\r\n" : "\n",
  );
  if (lines.length > 500 || Buffer.byteLength(result) > 256 * 1024)
    throw new Error("browserSessionRequired");
  return result;
}
